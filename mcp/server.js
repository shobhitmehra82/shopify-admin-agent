#!/usr/bin/env node
// MCP server exposing the four Shopify tools over stdio.
//
//   node mcp/server.js
//
// It is not meant to be run by hand — a client spawns it and speaks JSON-RPC
// over stdin/stdout. The chatbot backend (server/mcpClient.js) is one such
// client; Claude Desktop and Claude Code are others (see README).
//
// NOTHING may write to stdout in this process except the transport: stdout *is*
// the protocol channel, and one stray line desyncs the client. All logging goes
// to stderr.

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { tools } = require("./tools");

const server = new McpServer({
  name: "shopify-admin-agent",
  version: "1.0.0",
});

for (const tool of tools) {
  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
    },
    async (args) => {
      try {
        const result = await tool.handler(args);
        return {
          // JSON rather than prose: the caller is a model, and the raw shape
          // keeps ids intact for follow-up calls.
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        // Reported as a tool error, not a thrown exception — the model can then
        // read the message and retry with better arguments.
        console.error(`[${tool.name}] ${error.stack || error.message}`);
        return {
          isError: true,
          content: [{ type: "text", text: `${tool.name} failed: ${error.message}` }],
        };
      }
    }
  );
}

async function main() {
  const missing = [
    "SHOPIFY_STORE_DOMAIN",
    "SHOPIFY_APP_CLIENT_ID",
    "SHOPIFY_APP_CLIENT_SECRET",
  ].filter((key) => !process.env[key]);
  if (missing.length) {
    // Fail at startup rather than on the first tool call, so a misconfigured
    // server is obvious instead of looking like a broken tool.
    throw new Error(`Missing environment variables: ${missing.join(", ")}. See README.`);
  }

  await server.connect(new StdioServerTransport());
  console.error(
    `shopify-admin-agent MCP server ready on stdio — ${tools.length} tools: ` +
      tools.map((t) => t.name).join(", ")
  );
}

main().catch((error) => {
  console.error("MCP server failed to start:", error.message);
  process.exit(1);
});
