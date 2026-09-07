// The chat turn: stream a Claude response, run whatever MCP tools it asks for,
// feed the results back, repeat until it answers in prose.

const Anthropic = require("@anthropic-ai/sdk");
const mcp = require("./mcpClient");

const MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-5";
// Routing to one of four tools is not a hard reasoning problem, so the default
// trades depth for latency and cost. Raise it (medium/high) if answers get sloppy.
const EFFORT = process.env.ANTHROPIC_EFFORT || "low";

// A turn is user question -> tool -> answer, occasionally with a lookup chained
// in front of it. Ten rounds is well clear of that and stops a pathological
// loop from billing forever.
const MAX_ROUNDS = 10;

const client = new Anthropic();

const SYSTEM_PROMPT = `You are the shopping assistant for the Shopify store "${
  process.env.SHOPIFY_STORE_DOMAIN || "this store"
}". You answer staff and shopper questions by calling tools against the live store.

You have exactly four tools: search_products, add_product_to_cart,
get_customer_information, and get_orders_for_customer.

Rules:
- Never state a product, price, stock level, customer detail or order status from
  memory. That data lives only in the store, so call a tool and report what it
  returns. If a tool returns nothing, say nothing matched rather than guessing.
- Call search_products before add_product_to_cart so the variantId is real. If
  the shopper's wording matches several products or variants (sizes, colours),
  list the options and ask which one instead of picking for them.
- A cart is a Shopify draft order. Once a cart exists in this conversation, pass
  its cartId on every later add so the shopper keeps a single cart. Report the
  cart total and what is in it after each change.
- When a request needs two steps, chain the tools yourself — look the customer up,
  then fetch their orders — rather than asking the user for ids they do not have.
- If a request falls outside those four tools (refunds, editing products,
  shipping labels), say plainly that you cannot do it here.

Answer in short prose or compact markdown lists. Include prices with their
currency, and quote order and product names as the store spells them. Do not dump
raw JSON or internal gids at the user unless they ask for an id.`;

/**
 * Tool handlers return JSON, but an error result is a plain sentence. Anything
 * unparseable is simply not rendered — the assistant's prose still covers it.
 */
function parseToolData(result) {
  if (result.isError) return null;
  try {
    return JSON.parse(result.text);
  } catch {
    return null;
  }
}

/**
 * Run one assistant turn.
 *
 * @param {object} options
 * @param {Array} options.messages Conversation so far, mutated in place so the
 *   caller keeps the assistant turns and tool results for the next question.
 * @param {(event: string, data: object) => void} options.emit Progress sink;
 *   receives `text`, `tool_use`, `tool_result` and `notice` events.
 * @returns {Promise<string>} the assistant's final prose
 */
async function runTurn({ messages, emit }) {
  const tools = await mcp.listAnthropicTools();
  let answer = "";
  // Claude often narrates before a tool call ("Let me look that up") and then
  // answers in a later round. Those are separate messages, so without a break
  // between them the UI renders "...look that up.Found 3 bracelets" as one run.
  let streamedText = false;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      output_config: { effort: EFFORT },
      // The system prompt and tool schemas are identical on every request, and
      // tools render ahead of system, so one breakpoint here caches both.
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      tools,
      messages,
    });

    let roundHasText = false;
    stream.on("text", (delta) => {
      if (!roundHasText && streamedText) emit("text", { delta: "\n\n" });
      roundHasText = true;
      streamedText = true;
      emit("text", { delta });
    });

    const message = await stream.finalMessage();

    // Thinking blocks have to go back verbatim, so append the whole content
    // array rather than just the text.
    messages.push({ role: "assistant", content: message.content });

    const text = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    if (text) answer = text;

    if (message.stop_reason === "refusal") {
      const reason = message.stop_details?.explanation || "the request was declined";
      emit("notice", { level: "error", message: `Claude declined to answer: ${reason}` });
      return answer;
    }

    if (message.stop_reason === "max_tokens") {
      emit("notice", { level: "warn", message: "Response hit the length limit and was cut off." });
      return answer;
    }

    // No server-side tools are in play, but a paused turn just needs resending.
    if (message.stop_reason === "pause_turn") continue;

    const toolUses = message.content.filter((block) => block.type === "tool_use");
    if (!toolUses.length) return answer;

    // Claude may ask for several tools at once; they must all come back in a
    // single user message or it learns to stop batching them.
    const results = await Promise.all(
      toolUses.map(async (toolUse) => {
        emit("tool_use", { id: toolUse.id, name: toolUse.name, input: toolUse.input });
        const result = await mcp.callTool(toolUse.name, toolUse.input);
        emit("tool_result", {
          id: toolUse.id,
          name: toolUse.name,
          isError: result.isError,
          // The parsed payload, so the UI can render product tiles and the cart
          // from the same data the model sees rather than scraping its prose.
          data: parseToolData(result),
        });
        return {
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: result.text,
          is_error: result.isError,
        };
      })
    );

    messages.push({ role: "user", content: results });
  }

  emit("notice", {
    level: "warn",
    message: `Stopped after ${MAX_ROUNDS} tool rounds without a final answer.`,
  });
  return answer;
}

module.exports = { runTurn, MODEL };
