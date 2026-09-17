#!/usr/bin/env node
import 'dotenv/config';
import readline from 'node:readline';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { shopifyMcpServer, SERVER_NAME } from './mcpServer.js';

const ALLOWED_TOOLS = [`mcp__${SERVER_NAME}__check_inventory_level`, `mcp__${SERVER_NAME}__update_order_status`];

const queryOptions = {
  mcpServers: { [SERVER_NAME]: shopifyMcpServer },
  allowedTools: ALLOWED_TOOLS,
};

function printAssistantText(message) {
  if (message.type !== 'assistant') return;
  for (const block of message.message.content) {
    if (block.type === 'text') {
      process.stdout.write(`${block.text}\n`);
    }
  }
}

async function runOneShot(prompt) {
  for await (const message of query({ prompt, options: queryOptions })) {
    printAssistantText(message);
  }
}

async function* userMessages(rl) {
  while (true) {
    const line = await new Promise((resolve) => rl.question('> ', resolve));
    const trimmed = line.trim();

    if (trimmed === 'exit' || trimmed === 'quit') {
      // The SDK's underlying CLI subprocess waits on bidirectional traffic
      // rather than plain generator EOF, so it won't exit on its own here.
      // Exiting directly is safe - the SDK tears down its child process via
      // its own 'exit' handler.
      process.exit(0);
    }

    if (trimmed === '') continue;

    yield {
      type: 'user',
      message: { role: 'user', content: trimmed },
      parent_tool_use_id: null,
    };
  }
}

async function runRepl() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log("Shopify Admin Agent - type 'exit' or 'quit' to leave.");

  for await (const message of query({ prompt: userMessages(rl), options: queryOptions })) {
    printAssistantText(message);
  }
}

const argPrompt = process.argv.slice(2).join(' ').trim();

if (argPrompt) {
  await runOneShot(argPrompt);
} else {
  await runRepl();
}
