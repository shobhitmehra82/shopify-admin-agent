// The four Shopify tools, defined once and shared by the MCP server
// (mcp/server.js) and the docs. Keeping the list declarative means the server
// is a loop rather than four near-identical registrations.
//
// The `description` text is the only thing the model sees when deciding which
// tool to reach for, so it carries the routing hints — when to use the tool,
// where its ids come from, and what it returns.

const { z } = require("zod");
const queries = require("../shopifyQueries");
const config = require("../config");

// The schemas advertise the configured ceilings, so the model is told the real
// bounds up front instead of having a too-large limit silently clamped.
const { products, customers, orders } = config;

const tools = [
  {
    name: "search_products",
    title: "Search products",
    description:
      "Search the store's product catalogue. Use this whenever the shopper asks " +
      "what is available, what something costs, whether an item is in stock, or " +
      "wants to find a product by name, SKU, vendor or tag. Returns each match " +
      "with its variants, prices and inventory, plus the variantId that " +
      "add_product_to_cart needs. Always search before adding to a cart so the " +
      "variantId is real rather than guessed.",
    inputSchema: {
      query: z
        .string()
        .optional()
        .describe(
          "Free-text search over title, SKU, vendor and tags, e.g. 'silver bracelet'. " +
            "Shopify filter syntax also works: 'vendor:Acme', 'tag:sale', 'sku:1234'. " +
            "Omit to list products."
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(products.maxDisplayLimit)
        .optional()
        .describe(
          `Maximum products to return (default ${products.displayLimit}, max ` +
            `${products.maxDisplayLimit}). Leave unset unless the shopper asks for a ` +
            `specific number — the default is what the product carousel is sized for.`
        ),
      variantLimit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe(`Maximum variants per product (default ${products.variantLimit}).`),
      status: z
        .enum(["ACTIVE", "ARCHIVED", "DRAFT"])
        .optional()
        .describe("Restrict to products with this status."),
    },
    handler: (args) => queries.searchProducts(args),
  },

  {
    name: "add_product_to_cart",
    title: "Add a product to a cart",
    description:
      "Add a product variant to a cart. The cart is a Shopify draft order — an " +
      "unpaid, editable basket visible in the Shopify admin. Identify the item " +
      "by variantId (preferred, from search_products) or by sku. " +
      "Omit cartId to start a new cart; pass the cartId returned by an earlier " +
      "call to keep adding to the same one. Adding a variant already in the cart " +
      "increases its quantity instead of duplicating the line. Returns the full " +
      "cart contents and total after the change.",
    inputSchema: {
      variantId: z
        .string()
        .optional()
        .describe(
          "Product variant id from search_products, e.g. " +
            "'gid://shopify/ProductVariant/123' or the bare number. Required unless sku is given."
        ),
      sku: z
        .string()
        .optional()
        .describe("Variant SKU, used only when variantId is unknown."),
      quantity: z.number().int().min(1).optional().describe("Units to add (default 1)."),
      cartId: z
        .string()
        .optional()
        .describe(
          "Existing cart (draft order) id to add to. Omit to create a new cart. " +
            "Reuse the cartId from earlier in this conversation so the shopper keeps one cart."
        ),
      email: z
        .string()
        .optional()
        .describe(
          "Attach the cart to this customer. Linked to their customer record when " +
            "one matches, otherwise kept as a guest email."
        ),
    },
    handler: (args) => queries.addProductToCart(args),
  },

  {
    name: "get_customer_information",
    title: "Get customer information",
    description:
      "Look up a customer's contact details and account summary by email, name or " +
      "phone. Returns name, email, phone, marketing state, tags, notes, default " +
      "address, lifetime spend and total order count — but not the orders " +
      "themselves. Use get_orders_for_customer for order history.",
    inputSchema: {
      query: z
        .string()
        .describe(
          "Email (exact match), or a name or phone number to search for, e.g. 'ada@example.com' or 'Ada Lovelace'."
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(customers.maxDisplayLimit)
        .optional()
        .describe(`Maximum customers to return (default ${customers.displayLimit}).`),
    },
    handler: (args) => queries.getCustomerInformation(args),
  },

  {
    name: "get_orders_for_customer",
    title: "Get orders for a customer",
    description:
      "List a customer's orders, newest first, with payment and fulfilment status, " +
      "totals, refunds, shipping address and line items. Identify the customer by " +
      "customerId when known, otherwise by query (email, name or phone). Use this " +
      "for questions about past purchases, order status, or 'where is my order'.",
    inputSchema: {
      query: z
        .string()
        .optional()
        .describe("Email, name or phone of the customer. Required unless customerId is given."),
      customerId: z
        .string()
        .optional()
        .describe(
          "Customer id from get_customer_information, e.g. 'gid://shopify/Customer/123' or the bare number."
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(orders.maxDisplayLimit)
        .optional()
        .describe(`Maximum orders to return, newest first (default ${orders.displayLimit}).`),
    },
    handler: (args) => queries.getOrdersForCustomer(args),
  },
];

module.exports = { tools };
