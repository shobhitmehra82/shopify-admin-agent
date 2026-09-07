import { useCallback, useEffect, useRef, useState } from "react";
import { streamEvents } from "./sse.js";
import Markdown from "./Markdown.jsx";
import ProductCarousel from "./ProductCarousel.jsx";
import Cart from "./Cart.jsx";
import { useSpeech } from "./useSpeech.js";

// Labels for the tool chips. Falls back to the raw tool name so a tool added to
// mcp/tools.js still renders sensibly without touching the UI.
const TOOL_LABELS = {
  search_products: "Searching products",
  add_product_to_cart: "Adding to cart",
  get_customer_information: "Looking up customer",
  get_orders_for_customer: "Fetching orders",
};

const EXAMPLES = [
  "What silver bracelets do you have?",
  "Show me some backpacks",
  "Who is egnition_sample_1510@egnition.com?",
  "Show me that customer's recent orders",
];

const toolLabel = (name) => TOOL_LABELS[name] || name.replace(/_/g, " ");

/** Summarise a tool's arguments for the chip, e.g. `query: "bracelet"`. */
function describeInput(input) {
  return Object.entries(input || {})
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => {
      const text = typeof value === "string" ? value : JSON.stringify(value);
      // Long gids make the chip unreadable — keep the trailing id only.
      const short = text.startsWith("gid://") ? `…${text.split("/").pop()}` : text;
      return `${key}: ${short.length > 32 ? `${short.slice(0, 32)}…` : short}`;
    })
    .join(", ");
}

/** Newest successful result for a tool in one assistant turn, if any. */
const latestResult = (tools, name) =>
  (tools || []).filter((tool) => tool.name === name && tool.data).slice(-1)[0];

export default function App() {
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [health, setHealth] = useState(null);
  const conversationId = useRef(crypto.randomUUID());
  const scroller = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    fetch("/api/health")
      .then((response) => response.json())
      .then(setHealth)
      .catch(() => setHealth({ ok: false, error: "Backend unreachable" }));
  }, []);

  // Follow the tail of the transcript as tokens stream in.
  useEffect(() => {
    const node = scroller.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages, busy]);

  /**
   * @param {string} text Sent to the backend.
   * @param {string} [display] Shown in the transcript instead of `text`. Lets a
   *   tile's "Add to cart" pass an exact variantId without putting a raw gid in
   *   the user's own bubble.
   */
  const send = useCallback(
    async (text, display) => {
      const question = text.trim();
      if (!question || busy) return;

      setDraft("");
      setBusy(true);
      setMessages((current) => [
        ...current,
        { role: "user", text: (display || question).trim() },
        { role: "assistant", text: "", tools: [], notices: [] },
      ]);

      // Every event mutates only the last message, which is the one being built.
      const patch = (update) =>
        setMessages((current) => {
          const next = current.slice();
          const last = next[next.length - 1];
          next[next.length - 1] = { ...last, ...update(last) };
          return next;
        });

      try {
        await streamEvents(
          "/api/chat",
          { message: question, conversationId: conversationId.current },
          (event, data) => {
            if (event === "text") {
              patch((last) => ({ text: last.text + data.delta }));
            } else if (event === "tool_use") {
              patch((last) => ({
                tools: [...last.tools, { id: data.id, name: data.name, input: data.input }],
              }));
            } else if (event === "tool_result") {
              patch((last) => ({
                tools: last.tools.map((tool) =>
                  tool.id === data.id
                    ? { ...tool, done: true, isError: data.isError, data: data.data }
                    : tool
                ),
              }));
            } else if (event === "notice") {
              patch((last) => ({ notices: [...last.notices, data] }));
            }
          }
        );
      } catch (error) {
        patch((last) => ({
          notices: [...last.notices, { level: "error", message: error.message }],
        }));
      } finally {
        setBusy(false);
        inputRef.current?.focus();
      }
    },
    [busy]
  );

  // Recording is a fixed window that ends itself, so the transcript goes
  // straight out as a message — the whole point is not having to click again.
  const speech = useSpeech({
    seconds: health?.config?.voiceRecordingSeconds || 3,
    onCommand: (transcript) => send(transcript),
  });

  const addToCart = (product, variant) => {
    const label = [product.title, variant.title !== "Default Title" && variant.title]
      .filter(Boolean)
      .join(" — ");
    send(
      `Add 1 × ${label} to the cart, using variantId ${variant.variantId}. ` +
        `If a cart already exists in this conversation, add it to that cart.`,
      `Add 1 × ${label} to the cart`
    );
  };

  const reset = async () => {
    await fetch("/api/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId: conversationId.current }),
    }).catch(() => {});
    conversationId.current = crypto.randomUUID();
    setMessages([]);
    inputRef.current?.focus();
  };

  const onKeyDown = (event) => {
    // Enter sends; Shift+Enter is a newline.
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send(draft);
    }
  };

  return (
    <div className="app">
      <header>
        <div>
          <h1>Store Assistant</h1>
          <p className="sub">
            {health?.ok ? (
              <>
                {health.store} · {health.tools.length} MCP tools · {health.model}
              </>
            ) : health ? (
              <span className="bad">Backend unavailable — {health.error}</span>
            ) : (
              "Connecting…"
            )}
          </p>
        </div>
        <button className="ghost" onClick={reset} disabled={busy || !messages.length}>
          New chat
        </button>
      </header>

      <main ref={scroller}>
        {!messages.length && (
          <div className="empty">
            <p>Ask about products, carts, customers or orders — the assistant picks the tool.</p>
            <div className="examples">
              {EXAMPLES.map((example) => (
                <button key={example} onClick={() => send(example)} disabled={busy}>
                  {example}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((message, index) => {
          const cart = latestResult(message.tools, "add_product_to_cart");
          const search = latestResult(message.tools, "search_products");

          return (
            <article key={index} className={`msg ${message.role}`}>
              <div className="who">{message.role === "user" ? "You" : "Assistant"}</div>
              <div className="body">
                {message.tools?.map((tool) => (
                  <div key={tool.id} className={`tool ${tool.done ? "done" : "running"}`}>
                    <span className="dot" />
                    <span className="name">{toolLabel(tool.name)}</span>
                    {describeInput(tool.input) && (
                      <span className="args">{describeInput(tool.input)}</span>
                    )}
                    {tool.isError && <span className="bad">failed</span>}
                  </div>
                ))}

                {message.text ? (
                  <Markdown text={message.text} />
                ) : (
                  message.role === "assistant" &&
                  busy &&
                  index === messages.length - 1 && <span className="typing">Thinking…</span>
                )}

                {/* The cart is the outcome of the turn, so when a turn both
                    searched and added, show the cart rather than both. */}
                {cart ? (
                  <Cart
                    result={cart.data}
                    disabled={busy}
                    onAddMore={() => inputRef.current?.focus()}
                  />
                ) : (
                  search && (
                    <ProductCarousel result={search.data} onAddToCart={addToCart} disabled={busy} />
                  )
                )}

                {message.notices?.map((notice, i) => (
                  <p key={i} className={`notice ${notice.level}`}>
                    {notice.message}
                  </p>
                ))}
              </div>
            </article>
          );
        })}
      </main>

      <footer>
        {speech.error && <p className="notice error speech-error">{speech.error}</p>}
        {speech.listening && (
          <div className="listening" aria-live="polite">
            <div className="listening-row">
              <span className="mic-pulse" />
              <span className="listening-text">
                {speech.interim || <span className="muted">Listening… speak now</span>}
              </span>
              <span className="listening-count">{Math.ceil(speech.remaining)}s</span>
            </div>
            {/* Width mirrors the auto-stop timer, so the window is visible
                rather than something the user has to guess at. */}
            <div className="listening-bar">
              <i style={{ width: `${(speech.remaining / speech.seconds) * 100}%` }} />
            </div>
          </div>
        )}

        <div className="composer">
          <textarea
            ref={inputRef}
            rows={1}
            value={draft}
            placeholder="Ask about a product, cart, customer or order…"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            disabled={busy}
          />

          {speech.supported && (
            <button
              className={`mic ${speech.listening ? "on" : ""}`}
              onClick={speech.toggle}
              disabled={busy}
              title={
                speech.listening
                  ? "Stop and send now"
                  : `Speak a command — records for ${speech.seconds}s, then sends`
              }
              aria-label={speech.listening ? "Stop recording and send" : "Record a spoken command"}
            >
              {speech.listening ? "◼" : "🎤"}
            </button>
          )}

          <button onClick={() => send(draft)} disabled={busy || !draft.trim()}>
            {busy ? "…" : "Send"}
          </button>
        </div>
      </footer>
    </div>
  );
}
