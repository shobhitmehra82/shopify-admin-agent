#!/usr/bin/env node
import 'dotenv/config';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { shopifyMcpServer, SERVER_NAME } from './mcpServer.js';
import { verifySessionToken } from './sessionToken.js';

const ALLOWED_TOOLS = [`mcp__${SERVER_NAME}__check_inventory_level`, `mcp__${SERVER_NAME}__update_order_status`];

const queryOptions = {
  mcpServers: { [SERVER_NAME]: shopifyMcpServer },
  allowedTools: ALLOWED_TOOLS,
};

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const SHOPIFY_APP_CLIENT_ID = requireEnv('SHOPIFY_APP_CLIENT_ID');
const SHOPIFY_APP_CLIENT_SECRET = requireEnv('SHOPIFY_APP_CLIENT_SECRET');
const SHOPIFY_STORE_DOMAIN = requireEnv('SHOPIFY_STORE_DOMAIN');
const EMBED_CSP = 'frame-ancestors https://admin.shopify.com https://*.myshopify.com;';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT) || 3001;

const STATIC_FILES = {
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/styles.css': { file: 'styles.css', type: 'text/css; charset=utf-8' },
};

function verifyRequestToken(token, res) {
  try {
    return verifySessionToken(token, {
      clientId: SHOPIFY_APP_CLIENT_ID,
      clientSecret: SHOPIFY_APP_CLIENT_SECRET,
      shopDomain: SHOPIFY_STORE_DOMAIN,
    });
  } catch (error) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: error.message }));
    return null;
  }
}

// --- Single-session input queue -------------------------------------------
// Same model as the CLI's userMessages() generator: a queue feeding the SDK's
// streaming prompt input, except pushes come from HTTP requests instead of
// readline.

function createInputQueue() {
  const pending = [];
  let waitingResolve = null;

  function push(text) {
    const message = {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    };

    if (waitingResolve) {
      const resolve = waitingResolve;
      waitingResolve = null;
      resolve(message);
    } else {
      pending.push(message);
    }
  }

  async function* stream() {
    while (true) {
      if (pending.length > 0) {
        yield pending.shift();
      } else {
        yield await new Promise((resolve) => {
          waitingResolve = resolve;
        });
      }
    }
  }

  return { push, stream };
}

// --- SSE broadcast -----------------------------------------------------

const sseClients = new Set();

function broadcast(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) {
    res.write(payload);
  }
}

function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
  }
  return '';
}

function translateMessage(message) {
  const events = [];

  if (message.type === 'assistant') {
    for (const block of message.message.content) {
      if (block.type === 'text') {
        events.push({ kind: 'text', text: block.text });
      } else if (block.type === 'tool_use') {
        events.push({ kind: 'tool_call', id: block.id, name: block.name, input: block.input });
      }
    }
  } else if (message.type === 'user') {
    const content = message.message.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'tool_result') {
          events.push({
            kind: 'tool_result',
            id: block.tool_use_id,
            content: extractText(block.content),
            isError: block.is_error === true,
          });
        }
      }
    }
  } else if (message.type === 'result') {
    events.push({ kind: 'done', subtype: message.subtype, isError: message.is_error === true });
  }

  return events;
}

// --- Agent session -------------------------------------------------------

const inputQueue = createInputQueue();
const agentQuery = query({ prompt: inputQueue.stream(), options: queryOptions });

(async () => {
  try {
    for await (const message of agentQuery) {
      for (const event of translateMessage(message)) {
        broadcast(event);
      }
    }
  } catch (error) {
    broadcast({ kind: 'error', message: error.message });
  }
})();

// --- HTTP server -----------------------------------------------------

async function serveIndex(res) {
  const template = await fs.readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const html = template.replace('%%SHOPIFY_API_KEY%%', SHOPIFY_APP_CLIENT_ID);

  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': EMBED_CSP,
  });
  res.end(html);
}

async function serveStatic(pathname, res) {
  const entry = STATIC_FILES[pathname];
  if (!entry) return false;

  try {
    const body = await fs.readFile(path.join(PUBLIC_DIR, entry.file));
    res.writeHead(200, { 'Content-Type': entry.type });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
  return true;
}

const HEARTBEAT_INTERVAL_MS = 20_000;

function handleEvents(req, res, searchParams) {
  if (!verifyRequestToken(searchParams.get('token'), res)) return;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(': connected\n\n');

  // Render's free-tier proxy (and similar hosts) drops connections that sit
  // idle for ~100s. A periodic comment keeps bytes flowing without the
  // browser treating it as a message.
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), HEARTBEAT_INTERVAL_MS);

  sseClients.add(res);
  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function extractBearerToken(req) {
  const match = /^Bearer (.+)$/.exec(req.headers['authorization'] || '');
  return match ? match[1] : null;
}

async function handleMessage(req, res) {
  if (!verifyRequestToken(extractBearerToken(req), res)) return;

  try {
    const raw = await readBody(req);
    const { text } = JSON.parse(raw);

    if (typeof text !== 'string' || text.trim() === '') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'text is required' }));
      return;
    }

    broadcast({ kind: 'user_echo', text });
    inputQueue.push(text);

    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  } catch (error) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

const server = http.createServer((req, res) => {
  // Admin appends ?shop=...&host=...&embedded=1 to the document request, and
  // EventSource needs its own ?token= param - route on pathname, not the raw
  // req.url, so those query strings don't break matching.
  const { pathname, searchParams } = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && pathname === '/events') {
    handleEvents(req, res, searchParams);
    return;
  }

  if (req.method === 'POST' && pathname === '/api/message') {
    handleMessage(req, res);
    return;
  }

  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    serveIndex(res);
    return;
  }

  if (req.method === 'GET') {
    serveStatic(pathname, res).then((served) => {
      if (!served) {
        res.writeHead(404);
        res.end('Not found');
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`Shopify Admin Agent UI running at http://localhost:${PORT}`);
});
