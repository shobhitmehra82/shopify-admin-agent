# Shopify Admin Agent

A CLI agent, built on the Claude Agent SDK, that can check Shopify inventory
levels and update order status through two scoped tools.

## Requirements

- Node.js 18+
- A Shopify custom app with client credentials configured for the
  `client_credentials` OAuth grant
- An Anthropic API key

## Setup

1. Install dependencies:

   ```sh
   npm install
   ```

2. Create a `.env` file in the project root (already git-ignored) with:

   ```env
   SHOPIFY_STORE_DOMAIN=your-store.myshopify.com
   SHOPIFY_APP_CLIENT_ID=your-client-id
   SHOPIFY_APP_CLIENT_SECRET=your-client-secret
   ANTHROPIC_API_KEY=your-anthropic-api-key

   # Optional, defaults to 2026-07
   SHOPIFY_API_VERSION=2026-07
   ```

3. Make sure your Shopify app's access scopes (in `shopify.app.toml`, or the
   Partner Dashboard) include:

   - `read_products`, `read_inventory`, `read_locations` — for
     `check_inventory_level`
   - `write_orders` — for `update_order_status`

## Running

**One-shot mode** — pass a prompt as a command-line argument, get one
response, and exit:

```sh
npm start "What's the available inventory for the Classic Tee at the Downtown Warehouse?"
```

**REPL mode** — run with no arguments to start a conversational session.
Type `exit` or `quit` to leave:

```sh
npm start
```

## Tools

### `check_inventory_level` (read-only)

Takes a product name and a location name as they appear in Shopify (not
IDs), resolves each to the matching Shopify record, and reports available
inventory per variant at that location.

Name resolution: an exact (case-insensitive) match wins; otherwise it falls
back to a unique substring match. Zero or multiple matches is treated as an
error rather than a guess.

Requires scopes: `read_inventory`, `read_products`, `read_locations`.

### `update_order_status` (write)

Closes, reopens, or cancels an order by ID. Every call must pass through an
approval gate before it reaches the Admin API:

- `role` must be `'admin'` or `'staff'` (never `'shopper'`)
- `confirmed` must be `true`

Both conditions are required. If either fails, the tool returns a tool
error (not an uncaught exception) and never calls Shopify.

Requires scope: `write_orders`.

## Testing

Unit tests cover the approval gate and the name-matching logic in isolation
— no network calls, no Shopify credentials required:

```sh
npm test
```

## Project structure

```
src/
  shopifyAuth.js          OAuth client_credentials exchange + in-memory token cache
  shopifyClient.js        Admin API requests (products, locations, inventory, orders)
  matching.js             Pure name-resolution logic (exact match, then substring fallback)
  approval.js             requireApproval({ role, confirmed }) gate for writes
  mcpServer.js            SDK MCP server wiring both tools together
  cli.js                  One-shot and REPL entry point built on query()
  tools/
    checkInventoryLevel.js
    updateOrderStatus.js
test/
  approval.test.js
  matching.test.js
```
