// HTTP backend for the chat UI.
//
//   npm run server        → http://localhost:8787
//
// One endpoint does the work: POST /api/chat streams the assistant's reply back
// as server-sent events so the UI can render text as it arrives and show which
// tool is running.

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env"), quiet: true });

const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const { runTurn, MODEL } = require("./agent");
const mcp = require("./mcpClient");
const config = require("../config");

const PORT = Number(process.env.PORT) || 8787;

// Conversation history lives here rather than in the browser: the transcript
// includes tool results and thinking blocks that the UI has no business
// holding, and the client only needs to send the next message.
const conversations = new Map();
// Each turn appends an assistant turn plus a tool-result turn, so 60 entries is
// roughly 20 exchanges — past that, drop the oldest.
const MAX_HISTORY = 60;
const MAX_CONVERSATIONS = 200;

function getHistory(id) {
  if (!conversations.has(id)) {
    if (conversations.size >= MAX_CONVERSATIONS) {
      // Map iterates in insertion order, so the first key is the oldest.
      conversations.delete(conversations.keys().next().value);
    }
    conversations.set(id, []);
  }
  return conversations.get(id);
}

/**
 * Trim from the front while keeping the transcript valid: a `tool_result` turn
 * must still be preceded by the assistant turn holding its `tool_use`, so only
 * cut at a plain user message.
 */
function trimHistory(messages) {
  while (messages.length > MAX_HISTORY) {
    const cut = messages.findIndex(
      (message, index) =>
        index > 0 &&
        message.role === "user" &&
        !(Array.isArray(message.content) && message.content.some((b) => b.type === "tool_result"))
    );
    if (cut < 1) break;
    messages.splice(0, cut);
  }
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", async (_req, res) => {
  try {
    const tools = await mcp.listAnthropicTools();
    res.json({
      ok: true,
      model: MODEL,
      store: process.env.SHOPIFY_STORE_DOMAIN || null,
      tools: tools.map((tool) => tool.name),
      // Published rather than duplicated in the UI, so config.js stays the one
      // place the display limits are set.
      config: {
        productDisplayLimit: config.products.displayLimit,
        voiceRecordingSeconds: config.voice.recordingSeconds,
      },
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/chat", async (req, res) => {
  const { message, conversationId } = req.body || {};
  if (!message || typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "A non-empty `message` is required." });
  }
  if (!conversationId || typeof conversationId !== "string") {
    return res.status(400).json({ error: "A `conversationId` string is required." });
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // Stops nginx and friends from buffering the stream into one lump.
    "X-Accel-Buffering": "no",
  });

  // Checked against the response rather than tracked with a req.on("close")
  // listener: on a POST, the request stream closes as soon as express.json()
  // has read the body, so that listener fires immediately on every healthy
  // request and would silently discard the whole stream.
  const writable = () => !res.writableEnded && !res.destroyed;

  const emit = (event, data) => {
    if (!writable()) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const history = getHistory(conversationId);
  // Snapshot the length so a mid-turn failure can roll the transcript back to a
  // valid state instead of leaving a dangling tool_use with no result.
  const checkpoint = history.length;
  history.push({ role: "user", content: message.trim() });

  try {
    await runTurn({ messages: history, emit });
    trimHistory(history);
    emit("done", {});
  } catch (error) {
    console.error("chat turn failed:", error);
    history.length = checkpoint;
    emit("notice", { level: "error", message: error.message });
    emit("done", {});
  } finally {
    if (writable()) res.end();
  }
});

app.post("/api/reset", (req, res) => {
  const { conversationId } = req.body || {};
  if (conversationId) conversations.delete(conversationId);
  res.json({ ok: true });
});

// Serve the built UI when it exists, so `npm run build && npm run server` is a
// single-process deployment. In development Vite serves the UI and proxies here.
const distDir = path.join(__dirname, "..", "web", "dist");
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(distDir, "index.html")));
}

if (!process.env.ANTHROPIC_API_KEY) {
  // Not necessarily fatal: the SDK also reads an `ant auth login` profile, so
  // this is a hint rather than an error.
  console.warn(
    "ANTHROPIC_API_KEY is not set — chat will fail unless credentials come " +
      "from an `ant auth login` profile."
  );
}

const server = app.listen(PORT, () => {
  console.log(`Shopify chat backend on http://localhost:${PORT} (model: ${MODEL})`);
  if (!fs.existsSync(distDir)) console.log("UI not built — run `npm run web` for the dev server.");
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    // server.close() stops new connections but waits for existing ones, and an
    // idle keep-alive socket — any browser that has loaded the UI — never
    // closes on its own. Without closeIdleConnections() the callback below
    // never fires and the process outlives its parent, holding the port.
    server.close(() => mcp.close().finally(() => process.exit(0)));
    server.closeIdleConnections();
    // Backstop: an in-flight streaming response can still outlast the drain.
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
