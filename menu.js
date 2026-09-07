// Interactive menu for the Admin API helpers.
//   node menu.js     (or: npm start)
//
// Pick a method with the arrow keys; the menu then asks for whatever input
// that method needs.

const util = require("util");
const { adminRequest } = require("./adminClient");
const {
  getCustomerWithOrderHistory,
  getInventoryLevels,
  listDraftOrders,
} = require("./shopifyQueries");
const { select, ask, confirm, pause, bold, dim, green, yellow, red, exit } = require("./prompts");

const money = (set) => (set ? `${set.shopMoney.amount} ${set.shopMoney.currencyCode}` : "—");
const dump = (value) => console.log(util.inspect(value, { depth: null, colors: process.stdout.isTTY }));

function heading(text) {
  console.log(`\n${bold(text)}\n${dim("─".repeat(text.length))}`);
}

/* ------------------------------- actions ------------------------------- */

async function customerAction() {
  const email = await ask("Customer email:", { required: true });

  console.log(dim("\nfetching customer and order history…"));
  const result = await getCustomerWithOrderHistory(email);

  if (!result) {
    console.log(yellow(`\nNo customer found with email "${email}".`));
    return;
  }

  const { customer, orders, orderCount } = result;
  const address = customer.defaultAddress;

  heading("Contact details");
  console.log(`Name          ${customer.displayName || "—"}`);
  console.log(`Email         ${customer.email || "—"}${customer.verifiedEmail ? green(" (verified)") : ""}`);
  console.log(`Phone         ${customer.phone || customer.defaultPhoneNumber?.phoneNumber || "—"}`);
  console.log(`Customer ID   ${customer.id}`);
  console.log(`Created       ${customer.createdAt}`);
  console.log(`Tags          ${customer.tags.length ? customer.tags.join(", ") : "—"}`);
  console.log(`Note          ${customer.note || "—"}`);
  console.log(`Lifetime spend ${money({ shopMoney: customer.amountSpent })}`);
  console.log(
    `Address       ${
      address
        ? [address.address1, address.address2, address.city, address.province, address.zip, address.country]
            .filter(Boolean)
            .join(", ")
        : "—"
    }`
  );

  heading(`Order history (${orderCount})`);
  if (!orderCount) {
    console.log(dim("This customer has no orders."));
  } else {
    console.table(
      orders.map((order) => ({
        order: order.name,
        placed: order.createdAt.slice(0, 10),
        payment: order.displayFinancialStatus,
        fulfillment: order.displayFulfillmentStatus,
        total: money(order.currentTotalPriceSet),
        refunded: money(order.totalRefundedSet),
        items: order.lineItems.length,
      }))
    );

    // Shopify hides orders older than 60 days unless read_all_orders is granted,
    // so a shortfall here is a scope limit rather than missing data.
    const reported = Number(customer.numberOfOrders);
    if (Number.isFinite(reported) && reported > orderCount) {
      console.log(
        yellow(
          `Shopify reports ${reported} orders but only ${orderCount} are readable — ` +
            "older orders need the read_all_orders scope (requires app review)."
        )
      );
    }

    if (await confirm("Show line items for these orders?")) {
      orders.forEach((order) => {
        heading(`${order.name} — ${money(order.currentTotalPriceSet)}`);
        console.table(
          order.lineItems.map((item) => ({
            item: item.title,
            variant: item.variantTitle || "—",
            sku: item.sku || "—",
            qty: item.quantity,
            total: money(item.originalTotalSet),
          }))
        );
      });
    }
  }
}

async function inventoryAction() {
  const filter = await select("Which variants?", [
    { label: "All variants", value: "all" },
    { label: "Out of stock only", hint: "(available ≤ 0)", value: "out" },
    { label: "In stock only", hint: "(available > 0)", value: "in" },
  ]);
  if (filter === null) return;

  const byLocation = await confirm("Include per-location breakdown? (needs read_inventory + read_locations)");

  console.log(dim("\nfetching every product variant — this walks all pages, give it a moment…"));
  const result = await getInventoryLevels({ byLocation });

  const rows = result.items.filter((item) => {
    if (filter === "out") return (item.available || 0) <= 0;
    if (filter === "in") return (item.available || 0) > 0;
    return true;
  });

  if (byLocation && !result.locationNames) {
    console.log(
      yellow(
        "Location names need the read_locations scope, which is not granted — " +
          "showing location IDs instead. Add it to shopify.app.toml and run `shopify app deploy`."
      )
    );
  }

  heading("Inventory summary");
  console.log(`Variants in store   ${result.variantCount}`);
  console.log(`Total units (tracked) ${result.totalUnits}`);
  console.log(`Out of stock        ${result.outOfStock}`);
  console.log(`Matching filter     ${rows.length}`);

  if (!rows.length) {
    console.log(dim("\nNo variants match that filter."));
    return;
  }

  const limitInput = await ask(
    `How many rows to display? ${dim(`(1–${rows.length}, Enter for 20, "all" for every row)`)}`,
    { fallback: "20" }
  );
  const limit = limitInput.toLowerCase() === "all" ? rows.length : Math.max(1, parseInt(limitInput, 10) || 20);
  const shown = rows.slice(0, limit);

  console.table(
    shown.map((item) => ({
      product: item.product,
      variant: item.variant,
      sku: item.sku || "—",
      status: item.status,
      tracked: item.tracked,
      available: item.available,
    }))
  );
  if (shown.length < rows.length) {
    console.log(dim(`Showing ${shown.length} of ${rows.length} matching variants.`));
  }

  if (byLocation && (await confirm("Show the per-location breakdown?"))) {
    shown.forEach((item) => {
      heading(`${item.product} — ${item.variant}`);
      console.table(
        (item.locations || []).map((location) => ({ location: location.location, ...location.quantities }))
      );
    });
  }
}

async function draftOrderAction() {
  const status = await select("Filter by status?", [
    { label: "All draft orders", value: "" },
    { label: "Open", value: "OPEN" },
    { label: "Invoice sent", value: "INVOICE_SENT" },
    { label: "Completed", value: "COMPLETED" },
  ]);
  if (status === null) return;

  console.log(dim("\nfetching draft orders…"));
  const { draftOrderCount, draftOrders } = await listDraftOrders(status ? { status } : {});

  heading(`Draft orders (${draftOrderCount})`);
  if (!draftOrderCount) {
    console.log(dim("No draft orders match that filter."));
    return;
  }

  console.table(
    draftOrders.map((draft) => ({
      draft: draft.name,
      status: draft.status,
      updated: draft.updatedAt.slice(0, 10),
      customer: draft.customer ? draft.customer.email : dim("no customer"),
      total: money(draft.totalPriceSet),
      items: draft.lineItems.length,
      order: draft.order ? draft.order.name : "—",
    }))
  );

  const pick = await select("Inspect one in detail?", [
    { label: "No, back to the menu", value: null },
    ...draftOrders.map((draft) => ({
      label: `${draft.name} — ${money(draft.totalPriceSet)}`,
      hint: draft.customer ? `(${draft.customer.email})` : "(no customer)",
      value: draft,
    })),
  ]);

  if (pick) {
    heading(`${pick.name} (${pick.status})`);
    console.log(`Created      ${pick.createdAt}`);
    console.log(`Updated      ${pick.updatedAt}`);
    console.log(`Customer     ${pick.customer ? `${pick.customer.displayName} <${pick.customer.email}>` : "—"}`);
    console.log(`Subtotal     ${money(pick.subtotalPriceSet)}`);
    console.log(`Tax          ${money(pick.totalTaxSet)}`);
    console.log(`Total        ${money(pick.totalPriceSet)}`);
    console.log(`Tags         ${pick.tags.length ? pick.tags.join(", ") : "—"}`);
    console.log(`Note         ${pick.note2 || "—"}`);
    console.log(`Invoice URL  ${pick.invoiceUrl || "—"}`);
    console.table(
      pick.lineItems.map((item) => ({
        item: item.title,
        variant: item.variantTitle || "—",
        sku: item.sku || "—",
        qty: item.quantity,
        unitPrice: money(item.originalUnitPriceSet),
      }))
    );
  }
}

async function rawQueryAction() {
  const query = await ask("GraphQL query:", { required: true });
  console.log(dim("\nrunning…"));
  dump(await adminRequest(query));
}

const ACTIONS = [
  {
    label: "Customer contact details + full order history",
    hint: "· asks for an email",
    run: customerAction,
  },
  {
    label: "Current inventory levels across all products",
    hint: "· asks for a stock filter",
    run: inventoryAction,
  },
  {
    label: "List existing draft orders",
    hint: "· asks for a status filter",
    run: draftOrderAction,
  },
  { label: "Run a raw GraphQL query", hint: "· asks for the query", run: rawQueryAction },
  { label: "Quit", value: "quit" },
];

/* -------------------------------- loop -------------------------------- */

async function main() {
  console.log(
    `\n${bold("Shopify Admin Agent")}  ${dim(`· ${process.env.SHOPIFY_STORE_DOMAIN}`)}`
  );

  for (;;) {
    const action = await select(
      "What would you like to do?",
      ACTIONS.map((item) => ({ label: item.label, hint: item.hint, value: item }))
    );

    // Escape at the top level means quit — there is nowhere further back.
    if (!action || action.value === "quit") {
      console.log(dim("\nBye.\n"));
      return exit(0);
    }

    try {
      await action.run();
    } catch (error) {
      console.log(red(`\nRequest failed: ${error.message}`));
    }

    await pause();
  }
}

main().catch((error) => {
  console.error(red(`\n${error.stack || error.message}`));
  exit(1);
});
