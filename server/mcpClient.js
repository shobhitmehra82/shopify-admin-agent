// Bridges the MCP server to the Claude Messages API.
//
// The chat backend never imports shopifyQueries directly — it only knows the
// tools the MCP server advertises. That keeps MCP the single source of truth
// for the tool surface: adding a tool in mcp/tools.js exposes it to the chatbot
// with no change here.

const path = require("path");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

const SERVER_PATH = path.join(__dirname, "..", "mcp", "server.js");

// One long-lived child process for the whole backend. Spawning per request
// would pay process startup and a fresh Shopify token exchange every message.
let connecting = null;

async function getConnection() {
  // Cache the promise, not the result, so concurrent first requests share one
  // spawn instead of racing to start two servers.
  if (!connecting) {
    connecting = (async () => {
      const transport = new StdioClientTransport({
        // process.execPath rather than "node" so we inherit this exact runtime.
        command: process.execPath,
        args: [SERVER_PATH],
        // Let the server's stderr logging surface in the backend's own output.
        stderr: "inherit",
      });

      const client = new Client({ name: "shopify-chatbot", version: "1.0.0" });
      await client.connect(transport);
      const { tools } = await client.listTools();

      // A dead child (bad credentials, crash) should not leave a permanently
      // broken cached connection behind.
      transport.onclose = () => {
        connecting = null;
      };

      return { client, tools };
    })().catch((error) => {
      connecting = null;
      throw error;
    });
  }
  return connecting;
}

/**
 * MCP advertises JSON Schema, which is exactly what the Messages API wants —
 * so this is a rename rather than a translation. `$schema` is dropped because
 * it is metadata about the schema rather than part of it.
 */
function toAnthropicTools(mcpTools) {
  return mcpTools.map((tool) => {
    const { $schema, ...inputSchema } = tool.inputSchema || { type: "object", properties: {} };
    return {
      name: tool.name,
      description: tool.description,
      input_schema: inputSchema,
    };
  });
}

/** Tool definitions in Messages API shape, ready to pass as `tools`. */
async function listAnthropicTools() {
  const { tools } = await getConnection();
  return toAnthropicTools(tools);
}

/**
 * Run one tool and flatten the MCP result into the string a `tool_result`
 * block carries.
 *
 * @returns {Promise<{ text: string, isError: boolean }>}
 */
async function callTool(name, args) {
  const { client } = await getConnection();
  try {
    const result = await client.callTool({ name, arguments: args || {} });
    const text = (result.content || [])
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    return { text: text || "(no output)", isError: Boolean(result.isError) };
  } catch (error) {
    // A transport-level failure (server died, unknown tool) still has to come
    // back as a tool result, or the conversation stalls with no explanation.
    return { text: `${name} could not be called: ${error.message}`, isError: true };
  }
}

async function close() {
  if (!connecting) return;
  const pending = connecting;
  connecting = null;
  try {
    const { client } = await pending;
    await client.close();
  } catch {
    // Already gone — nothing to clean up.
  }
}

module.exports = { listAnthropicTools, callTool, close };
