// Exercises all four tools through the MCP protocol against the live store.
//
//   npm test
//
// This is the check that matters before wiring up the chatbot: it proves the
// MCP server starts, advertises its tools, and that each one returns real data.
// No Anthropic API key is needed — the model is not involved.
//
// Read-only by default. Pass --write to also test the cart, which creates a
// real (unpaid) draft order in the store.

const path = require("path");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

const WRITE = process.argv.includes("--write");

let passed = 0;
let failed = 0;

function check(label, condition, detail = "") {
  if (condition) {
    passed++;
    console.log(`  ok   ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(__dirname, "..", "mcp", "server.js")],
    stderr: "ignore",
  });
  const client = new Client({ name: "smoke-test", version: "1.0.0" });
  await client.connect(transport);

  /** Call a tool and parse its JSON payload back out. */
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    const text = result.content.map((block) => block.text).join("\n");
    if (result.isError) throw new Error(text);
    return JSON.parse(text);
  };

  console.log("\nhandshake");
  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name).sort();
  check("advertises 4 tools", names.length === 4, names.join(", "));
  check(
    "every tool has a description and schema",
    tools.every((tool) => tool.description && tool.inputSchema?.type === "object")
  );

  console.log("\nsearch_products");
  const listed = await call("search_products", { limit: 3, variantLimit: 2 });
  check("lists products", listed.productCount > 0, `${listed.productCount} returned`);
  const sample = listed.products[0];
  check("exposes a variantId for the cart", Boolean(sample?.variants[0]?.variantId));
  check("includes a price", Boolean(sample?.priceRange.min.amount), sample?.priceRange.min.amount);

  const term = sample.title.split(" ")[0];
  const searched = await call("search_products", { query: term, limit: 3 });
  check(`free-text search "${term}" matches`, searched.productCount > 0, `${searched.productCount} hits`);

  console.log("\nget_customer_information");
  const customers = await call("get_customer_information", { query: "a", limit: 3 });
  check("finds customers", customers.customerCount > 0, `${customers.customerCount} returned`);
  const withOrders = customers.customers.find((customer) => customer.numberOfOrders > 0);
  check("returns contact details", Boolean(customers.customers[0]?.displayName));

  const missing = await call("get_customer_information", { query: "nobody@nowhere.invalid" });
  check("unknown customer returns empty, not an error", missing.customerCount === 0);

  console.log("\nget_orders_for_customer");
  if (withOrders) {
    const orders = await call("get_orders_for_customer", {
      query: withOrders.email || withOrders.displayName,
      limit: 3,
    });
    check("returns orders", orders.orderCount > 0, `${orders.orderCount} for ${withOrders.displayName}`);
    check("orders carry status and total", Boolean(orders.orders[0]?.financialStatus && orders.orders[0]?.total));
    const byId = await call("get_orders_for_customer", {
      customerId: withOrders.customerId,
      limit: 1,
    });
    check("customerId lookup agrees", byId.orderCount > 0);
  } else {
    console.log("  skip  no sample customer has orders");
  }

  const noCustomer = await call("get_orders_for_customer", { query: "nobody@nowhere.invalid" });
  check("unknown customer yields no orders", noCustomer.customer === null && noCustomer.orderCount === 0);

  console.log("\nadd_product_to_cart");
  if (!WRITE) {
    console.log("  skip  pass --write to create a real draft order");
  } else {
    const variant = sample.variants[0];
    const created = await call("add_product_to_cart", { variantId: variant.variantId, quantity: 2 });
    check("creates a cart", created.created === true, created.cart.name);
    check("cart holds the item", created.cart.itemCount === 2, `total ${created.cart.total.amount}`);

    const merged = await call("add_product_to_cart", {
      cartId: created.cart.cartId,
      variantId: variant.variantId,
      quantity: 3,
    });
    check(
      "same variant merges instead of duplicating",
      merged.cart.lineItems.length === 1 && merged.cart.lineItems[0].quantity === 5,
      `${merged.cart.lineItems.length} line, qty ${merged.cart.lineItems[0].quantity}`
    );

    const second = listed.products.find((product) => product.variants[0].variantId !== variant.variantId);
    if (second) {
      const added = await call("add_product_to_cart", {
        cartId: created.cart.cartId,
        variantId: second.variants[0].variantId,
      });
      check("a different variant adds a line", added.cart.lineItems.length === 2, `${added.cart.itemCount} items`);
    }

    const bad = await client.callTool({
      name: "add_product_to_cart",
      arguments: { sku: "__definitely-not-a-sku__" },
    });
    check("unknown SKU reports a tool error", bad.isError === true);
    console.log(`  note  created draft order ${created.cart.name} (${created.cart.cartId})`);
  }

  await client.close();

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error("\nsmoke test crashed:", error.message);
  process.exit(1);
});
