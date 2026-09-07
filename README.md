# Shopify Admin Agent

A chatbot over the Shopify Admin GraphQL API. Ask a question in plain English
and Claude picks the right tool:

| Tool | Answers questions like |
| --- | --- |
| `search_products` | "What silver bracelets do you have?" · "Is SKU 30235 in stock?" |
| `add_product_to_cart` | "Add two of the small one to a cart" |
| `get_customer_information` | "Who is ada@example.com?" · "Find Ada Lovelace" |
| `get_orders_for_customer` | "What has she ordered?" · "Has order #1018 shipped?" |

The tools live in an **MCP server** (`mcp/server.js`), so the same four tools
serve the web chat UI, Claude Desktop, and Claude Code without being
reimplemented per client.

```
web/          React chat UI          (Vite, port 5173)
  │  POST /api/chat  → server-sent events
server/       chat backend           (Express, port 8787)
  │  Claude Messages API + tool-use loop
  │  MCP over stdio
mcp/          MCP server             (4 tools)
  │
shopifyQueries.js → adminClient.js → Shopify Admin GraphQL
```

The original **interactive menu** and **REPL** still work for the inventory and
draft-order reports — see [Usage — interactive menu](#usage--interactive-menu).

## Requirements

- Node.js 18+ (built and tested on 22) — uses the built-in `fetch`
- A Shopify custom app installed on the store, with client credentials
- An Anthropic API key (chat UI only; the MCP server and CLI tools work without one)

## Setup

```bash
npm install
npm run build     # installs and builds the React UI
```

Create a `.env` in the project root:

```dotenv
SHOPIFY_STORE_DOMAIN=your-store.myshopify.com
SHOPIFY_APP_CLIENT_ID=your-app-client-id
SHOPIFY_APP_CLIENT_SECRET=your-app-client-secret

# Chat UI only. Alternatively run `ant auth login`, which the SDK also reads.
ANTHROPIC_API_KEY=sk-ant-...
```

`.env` is gitignored — don't commit it.

Optional overrides: `ANTHROPIC_MODEL` (default `claude-opus-5`),
`ANTHROPIC_EFFORT` (default `low` — raise to `medium`/`high` if answers get
sloppy), `PORT` (default `8787`).

Verify the credentials work:

```bash
node test-admin.js
# → { "shop": { "name": "...", "email": "..." } }
```

## Access scopes

Scopes live in `shopify.app.toml` under `[access_scopes]`:

```toml
scopes = "read_products,read_inventory,read_locations,read_orders,write_draft_orders,read_customers"
```

| Scope | Needed for |
| --- | --- |
| `read_customers` | Customer contact details |
| `read_orders` | Order history |
| `read_products` | Product variants and `inventoryQuantity` |
| `read_inventory` | Per-location inventory quantities |
| `read_locations` | Location *names* in the per-location breakdown (optional — falls back to IDs) |
| `write_draft_orders` | Draft orders (implies read) |

**Editing the TOML is not enough.** The access token is minted against the app
config stored on Shopify's side, so a scope change only takes effect after:

```bash
shopify app deploy
```

Until you deploy, requests for the new scope fail with
`ACCESS_DENIED — Required access: <scope> access scope`.

## Usage — chatbot

```bash
npm run chat       # backend + Vite dev server together
```

Then open <http://localhost:5173>. Ctrl+C stops both.

To run the pieces separately — useful when only one side is being changed:

```bash
npm run server     # Express backend on :8787
npm run web        # Vite dev server on :5173, proxying /api to :8787
```

`npm run build` writes `web/dist`, which the backend then serves itself, so
`npm run build && npm run server` is a one-process deployment on :8787.

The UI shows a chip for each tool call with its arguments, so you can see which
tool answered and with what. Replies stream token by token.

Tool results reach the browser as structured data, not just prose, so two of
them render as real UI rather than a text list:

- **Product search → a carousel of product tiles** with image, title, vendor,
  price, stock, a variant picker, and an *Add to cart* button. Scroll with a
  swipe or the arrow buttons. Tile count comes from
  [`config.js`](config.js) (default 6).
- **Cart → a cart panel** with per-line images, quantities, line totals,
  subtotal, total, and a **Checkout** button that opens the draft order's
  Shopify invoice URL.

A tile's *Add to cart* button doesn't call the tool directly — it sends a chat
message naming the exact `variantId`. The assistant stays in the loop, so it
knows which cart it is adding to and can still answer follow-ups about it.

### Voice input

Press 🎤 and speak. Recording runs for a fixed window — **3 seconds** by
default — then stops on its own and sends what you said as a message. One press,
no second click, nothing to confirm.

While recording, the live transcript and a draining countdown bar show above the
composer. Pressing ◼ ends the window early and sends immediately, so a short
command needn't wait out the full three seconds.

The window length is [`voice.recordingSeconds`](config.js) — raise it if
commands are getting cut off mid-sentence.

Details worth knowing:

- Recognition runs in `continuous` mode, so a pause *within* the window
  ("add two of the… silver one") doesn't end the recording early — only the
  timer does.
- If the window closes mid-word, the unsettled transcript is sent rather than
  discarded, so a clipped command still gets through.
- Silence sends nothing and says "Didn't catch that".
- Chrome, Edge and Safari support this. Firefox has no Web Speech API, and the
  button is hidden there rather than failing on click. The first use prompts for
  microphone permission; denying it shows an inline message.

Note this is the *browser's* speech recognition, not an Anthropic API call —
audio never reaches this app, only the resulting text.

## Configuration

Display limits live in [`config.js`](config.js). Each has an environment
override, so you can try a value without editing tracked code:

| Setting | Default | Env override | Controls |
| --- | --- | --- | --- |
| `products.displayLimit` | **6** | `PRODUCT_DISPLAY_LIMIT` | Products per search — i.e. carousel tiles |
| `products.maxDisplayLimit` | 24 | `PRODUCT_MAX_DISPLAY_LIMIT` | Hard cap when the shopper asks for more |
| `products.variantLimit` | 10 | `PRODUCT_VARIANT_LIMIT` | Variants per tile picker |
| `customers.displayLimit` | 5 | `CUSTOMER_DISPLAY_LIMIT` | Customers per lookup |
| `orders.displayLimit` | 10 | `ORDER_DISPLAY_LIMIT` | Orders per customer |
| `voice.recordingSeconds` | **3** | `VOICE_RECORDING_SECONDS` | Voice recording window before auto-send (clamped 1–60) |

`displayLimit` is the default the model gets when it doesn't ask for a number;
`maxDisplayLimit` is enforced regardless, so one question can't pull the whole
catalogue into the conversation. Both are baked into the tool schemas, so the
model is told the real bounds instead of having an over-large request silently
clamped. The UI reads `productDisplayLimit` from `/api/health` rather than
hard-coding it, and a `displayLimit` above its own ceiling throws at startup.

### Carts

The Admin API has no cart — carts belong to the Storefront API. Here a cart is a
**draft order**: an unpaid, editable basket that shows up under *Orders →
Drafts* in the Shopify admin and can be converted into a real order. Adding an
item returns a `cartId`, which the assistant reuses for the rest of the
conversation so a shopper keeps one cart. Re-adding the same variant increases
its quantity rather than creating a second line.

## Usage — MCP server

The server speaks JSON-RPC over stdio, so a client spawns it rather than you
running it by hand:

```bash
npm run mcp        # only useful to check it starts
```

A `.mcp.json` is checked in, so **Claude Code** picks the four tools up
automatically in this directory. For **Claude Desktop**, add to
`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "shopify-admin-agent": {
      "command": "node",
      "args": ["/absolute/path/to/shopify-admin-agent/mcp/server.js"]
    }
  }
}
```

Credentials come from `.env` next to `adminClient.js`, not from the client's
working directory, so an absolute path is all the config needs.

Two constraints on anything added to this server: **stdout belongs to the
protocol** — log to stderr only, and a stray `console.log` (or a library banner,
which is why `dotenv` is loaded with `quiet: true`) desyncs the client. And
tool failures should be returned as `isError` results rather than thrown, so the
model can read the message and retry with better arguments.

## Usage — interactive menu

```bash
npm start          # or: node menu.js
```

```
What would you like to do?
  ↑/↓ move · Enter select · Esc back · Ctrl+C quit

❯ Customer contact details + full order history · asks for an email
  Current inventory levels across all products · asks for a stock filter
  List existing draft orders · asks for a status filter
  Run a raw GraphQL query · asks for the query
  Quit
```

Arrow keys move, Enter selects, Escape backs out of a prompt, Ctrl+C quits.
Each option then asks for whatever input it needs:

- **Customer** — asks for an email, then prints contact details and an order
  table, and offers to expand line items.
- **Inventory** — asks for a stock filter (all / out of stock / in stock),
  whether to include the per-location breakdown, and how many rows to print
  (Enter for 20, or `all`).
- **Draft orders** — asks for a status filter, prints the table, then lets you
  pick one draft to inspect in full.

Failed requests print in red and return you to the menu.

## Usage — REPL

```bash
npm run console    # or: node console.js
```

All helpers are preloaded and top-level `await` works:

```js
shopify> await getCustomerWithOrderHistory("someone@example.com")
shopify> await getInventoryLevels()
shopify> await getInventoryLevels({ byLocation: true })
shopify> await listDraftOrders({ status: "OPEN" })
shopify> await adminRequest(`query { shop { name email } }`)
```

Node truncates deep objects to `[Object]`, so use `show()` for the full tree:

```js
shopify> show(await listDraftOrders())
```

Use straight quotes `"` — smart quotes (`“ ”`) throw
`Uncaught SyntaxError: Invalid or unexpected token`. If your editor
auto-substitutes them, turn that off before pasting JS.

## The methods

From `shopifyQueries.js`, usable in any script:

```js
const {
  // Backing the four chatbot / MCP tools
  searchProducts,
  addProductToCart,
  getCustomerInformation,
  getOrdersForCustomer,
  // The original reports
  getCustomerWithOrderHistory,
  getInventoryLevels,
  listDraftOrders,
} = require("./shopifyQueries");
```

### `searchProducts({ query, limit, variantLimit, status })`

Returns `{ query, productCount, hasMore, displayLimit, products }`. `hasMore`
says whether the display limit hid further matches, so "6 products" never reads
as "all of them". `query` is Shopify's search syntax,
so plain words full-text match and filters work too (`vendor:Acme`, `tag:sale`,
`sku:1234`); omit it to list products. Each product carries status, vendor, tags,
a truncated description, price range, image URL, and its variants — each with the
`variantId` that `addProductToCart` needs.

### `addProductToCart({ variantId, sku, quantity, cartId, email })`

Adds a variant to a cart (draft order) and returns
`{ created, variant, cart }`. Identify the item by `variantId` or `sku`. Omit
`cartId` to create a cart; pass one to add to an existing cart. `email` attaches
the cart to that customer when a record matches, otherwise keeps it as a guest
email.

`draftOrderUpdate` *replaces* the line-item list rather than appending to it, so
existing lines are read back and rebuilt on every add — including custom
(non-variant) lines, which would otherwise vanish.

### `getCustomerInformation({ query, limit })`

Returns `{ query, customerCount, customers }`. A `query` containing `@` becomes
an exact email lookup; anything else full-text searches name, email and phone.
Contact details and account summary only — no orders.

### `getOrdersForCustomer({ query, customerId, limit })`

Returns `{ customer, orderCount, hasMore, orders }`, newest first. Identify the
customer by `customerId`, or by `query` and it resolves the customer first.
Unlike `getCustomerWithOrderHistory` this fetches a single page (default 10), so
one chat answer costs one request instead of walking a long history; `hasMore`
says whether older orders exist.

### `getCustomerWithOrderHistory(email)`

Returns `{ customer, orderCount, orders }`, or `null` if no customer matches.

`customer` carries name, email, phone, `defaultAddress` plus all `addresses`,
tags, note, `numberOfOrders`, and `amountSpent`. Each order carries
`displayFinancialStatus`, `displayFulfillmentStatus`, totals, refunds, shipping
address, and line items.

The email is quote-escaped, so addresses containing spaces or quotes are safe.

### `getInventoryLevels({ byLocation })`

Returns `{ variantCount, totalUnits, outOfStock, items }` covering every product
variant. `totalUnits` sums only tracked variants, because `inventoryQuantity` is
`null` for untracked ones.

`byLocation: true` adds a `locations` array per variant with available,
committed, incoming, on_hand, and reserved quantities. It needs `read_inventory`.

Location *names* sit behind a second scope, `read_locations`. Without it the
breakdown still works but labels each location by numeric ID, and the returned
`locationNames: false` flag says why (the menu prints a note). Grant the scope
and names appear automatically — no code change.

### `listDraftOrders({ status, search })`

Returns `{ draftOrderCount, draftOrders }`, newest-updated first. Each draft
carries status, timestamps, `invoiceUrl`, tags, `note2`, money fields, customer,
`order` (non-null once converted to a real order), and line items.

`status` accepts `OPEN`, `INVOICE_SENT`, or `COMPLETED`. `search` passes a raw
Shopify query string through and takes precedence over `status`:

```js
await listDraftOrders({ search: "customer_id:9465065504922" });
await listDraftOrders({ search: "created_at:>2026-08-01" });
await listDraftOrders({ search: "tag:'Multiple Fulfillments'" });
```

## Files

| File | Purpose |
| --- | --- |
| `config.js` | Display limits, with env overrides |
| `adminClient.js` | Token exchange (cached) and `adminRequest(query, variables)` |
| `shopifyQueries.js` | All GraphQL — the three reports plus the four tool methods |
| `mcp/tools.js` | The four tool definitions: schema, description, handler |
| `mcp/server.js` | MCP server over stdio |
| `server/mcpClient.js` | Spawns the MCP server; maps its tools to Messages API shape |
| `server/agent.js` | Claude streaming tool-use loop and the system prompt |
| `server/index.js` | Express: `POST /api/chat` (SSE), `/api/health`, `/api/reset` |
| `web/src/App.jsx` | Chat UI — transcript, composer, tool chips |
| `web/src/ProductCarousel.jsx` | Scrolling product tiles from a search result |
| `web/src/Cart.jsx` | Cart panel with checkout |
| `web/src/useSpeech.js` | Fixed-window voice capture (auto-stop, auto-send) |
| `web/test/voice.jsx` | jsdom tests for the voice hook |
| `web/src/format.js` | Shared money formatting |
| `web/src/sse.js` | Reads the SSE stream from `fetch` |
| `web/src/Markdown.jsx` | Minimal markdown renderer (lists, bold, code) |
| `scripts/dev.js` | Runs backend + Vite together (`npm run chat`) |
| `scripts/smoke.js` | Drives all four tools over MCP against the live store |
| `menu.js` | Interactive menu |
| `prompts.js` | Dependency-free select / input / confirm prompts |
| `console.js` | REPL with the helpers preloaded |
| `test-admin.js` | Credential smoke test |

Adding a tool means editing `mcp/tools.js` only — the backend advertises
whatever the MCP server reports, and the UI falls back to the raw tool name.

## Tests

```bash
npm test                    # read-only: all four tools over MCP, against the live store
npm test -- --write         # also tests the cart, creating a real draft order
npm --prefix web test       # voice hook: fixed window, auto-stop, auto-send (jsdom)
```

The voice suite drives `useSpeech` against a fake `SpeechRecognition`, so the
auto-stop timer, the single auto-send, the interim fallback and the
no-duplicate-send-after-early-stop cases are covered without a microphone.

## Notes and limits

**Pagination.** The three original report methods walk every page at 100 nodes
each, so nothing is silently truncated — a store with 3700 variants costs
roughly 37 sequential requests. The four tool methods deliberately do not: they
take one bounded page, because a chat answer should cost one request.

**Order history may be capped at 60 days.** Shopify restricts apps to the last
60 days of orders unless `read_all_orders` is granted, which requires app
review. Both `customer.numberOfOrders` (Shopify's count) and `orderCount` (what
was actually fetched) are returned, so comparing them tells you whether you hit
the cap. The menu prints a warning when they disagree.

**Token caching** is per-process, held in memory until 60 seconds before expiry.
Restarting picks up newly deployed scopes.

**API version** is pinned to `2026-07` in `adminClient.js`, matching
`shopify.app.toml`. Change both together. Two fields moved in this version and
the queries reflect it: `Product.featuredImage` and `ProductVariant.image` are
gone (use `featuredMedia.preview.image`), and `DraftOrderInput.customerId` is
now `purchasingEntity.customerId`.

**Conversation history** is held in memory in the backend, keyed by
`conversationId`, capped at 200 conversations and ~20 exchanges each. It is lost
on restart — fine for a single-user tool, but a multi-user deployment wants a
real store.

**Refusal fallbacks** are not enabled. The `fallbacks` parameter would force
every request onto the beta endpoint, and a store-catalogue assistant has no
realistic refusal surface. `stop_reason: "refusal"` is still handled and
surfaced in the UI.
