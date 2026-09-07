const { adminRequest } = require("./adminClient");
const config = require("./config");

// Shopify caps connections at 250 nodes per page, so anything that can return
// an unbounded list is walked page by page until hasNextPage goes false.
const PAGE_SIZE = 100;

async function paginate(query, variables, pickConnection) {
  const nodes = [];
  let cursor = null;
  do {
    const data = await adminRequest(query, { ...variables, cursor });
    const connection = pickConnection(data);
    if (!connection) break;
    nodes.push(...connection.nodes);
    cursor = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (cursor);
  return nodes;
}

/* ------------------------------------------------------------------ *
 * 1. Customer contact details + full order history, looked up by email
 * ------------------------------------------------------------------ */

const CUSTOMER_BY_EMAIL = `
  query customerByEmail($search: String!) {
    customers(first: 1, query: $search) {
      nodes {
        id
        firstName
        lastName
        displayName
        email
        phone
        note
        tags
        verifiedEmail
        createdAt
        updatedAt
        numberOfOrders
        amountSpent { amount currencyCode }
        defaultEmailAddress { emailAddress marketingState }
        defaultPhoneNumber { phoneNumber }
        defaultAddress {
          address1
          address2
          city
          province
          provinceCode
          country
          countryCodeV2
          zip
          company
          phone
        }
        addresses {
          address1
          address2
          city
          province
          country
          zip
        }
      }
    }
  }
`;

const CUSTOMER_ORDERS = `
  query customerOrders($id: ID!, $pageSize: Int!, $cursor: String) {
    customer(id: $id) {
      orders(first: $pageSize, after: $cursor, sortKey: CREATED_AT, reverse: true) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          name
          createdAt
          processedAt
          cancelledAt
          displayFinancialStatus
          displayFulfillmentStatus
          currentTotalPriceSet { shopMoney { amount currencyCode } }
          totalPriceSet { shopMoney { amount currencyCode } }
          totalRefundedSet { shopMoney { amount currencyCode } }
          shippingAddress { address1 city province country zip }
          lineItems(first: 50) {
            nodes {
              title
              quantity
              sku
              variantTitle
              originalTotalSet { shopMoney { amount currencyCode } }
            }
          }
        }
      }
    }
  }
`;

/**
 * Look up one customer by email and pull their entire order history.
 *
 * @param {string} email
 * @returns {Promise<null|object>} null when no customer matches the email
 */
async function getCustomerWithOrderHistory(email) {
  if (!email || typeof email !== "string") {
    throw new Error("getCustomerWithOrderHistory(email): an email string is required");
  }

  // Quote + escape so addresses containing spaces or quotes can't break the
  // search syntax.
  const search = `email:"${email.trim().replace(/(["\\])/g, "\\$1")}"`;
  const { customers } = await adminRequest(CUSTOMER_BY_EMAIL, { search });
  const customer = customers.nodes[0];
  if (!customer) return null;

  const orders = await paginate(
    CUSTOMER_ORDERS,
    { id: customer.id, pageSize: PAGE_SIZE },
    (data) => data.customer && data.customer.orders
  );

  return {
    customer,
    orderCount: orders.length,
    orders: orders.map((order) => ({
      ...order,
      lineItems: order.lineItems.nodes,
    })),
  };
}

/* ------------------------------------------------------- *
 * 2. Current inventory levels across all products/variants
 * ------------------------------------------------------- */

const PRODUCT_VARIANTS = `
  query inventoryLevels($pageSize: Int!, $cursor: String) {
    productVariants(first: $pageSize, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        title
        sku
        barcode
        price
        inventoryQuantity
        inventoryPolicy
        product { id title status vendor productType handle }
        inventoryItem {
          id
          tracked
          unitCost { amount currencyCode }
        }
      }
    }
  }
`;

// Per-location breakdown needs the read_inventory scope (see shopify.app.toml).
// Kept as an opt-in query so the default call stays cheap — one page of
// variants instead of a nested fan-out across every location.
//
// location.name and location.isActive sit behind a *second* scope,
// read_locations, so the name fields are selected only when that scope is
// granted. Location IDs are always readable.
const byLocationQuery = (withNames) => `
  query inventoryLevelsByLocation($pageSize: Int!, $cursor: String) {
    productVariants(first: $pageSize, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        title
        sku
        inventoryQuantity
        product { id title status }
        inventoryItem {
          id
          tracked
          inventoryLevels(first: 25) {
            nodes {
              location { id ${withNames ? "name isActive" : ""} }
              quantities(names: ["available", "committed", "incoming", "on_hand", "reserved"]) {
                name
                quantity
              }
            }
          }
        }
      }
    }
  }
`;

/**
 * Whether the token can read location names. Probed with a single cheap request
 * so a missing read_locations scope degrades the breakdown to IDs rather than
 * failing the whole inventory walk partway through.
 */
async function canReadLocationNames() {
  try {
    await adminRequest(`query { locations(first: 1) { nodes { name } } }`);
    return true;
  } catch (error) {
    if (error.message.includes("read_locations")) return false;
    throw error;
  }
}

/**
 * Current stock for every product variant in the store.
 *
 * @param {{ byLocation?: boolean }} [options] byLocation adds a per-location
 *   breakdown; needs read_inventory, plus read_locations for location names.
 */
async function getInventoryLevels(options = {}) {
  // Only relevant to the byLocation path, so don't spend a request otherwise.
  const locationNames = options.byLocation ? await canReadLocationNames() : false;
  const query = options.byLocation ? byLocationQuery(locationNames) : PRODUCT_VARIANTS;

  const variants = await paginate(
    query,
    { pageSize: PAGE_SIZE },
    (data) => data.productVariants
  );

  const items = variants.map((variant) => {
    const row = {
      variantId: variant.id,
      productId: variant.product.id,
      product: variant.product.title,
      variant: variant.title,
      sku: variant.sku,
      status: variant.product.status,
      tracked: variant.inventoryItem ? variant.inventoryItem.tracked : null,
      available: variant.inventoryQuantity,
    };
    if (options.byLocation && variant.inventoryItem) {
      row.locations = variant.inventoryItem.inventoryLevels.nodes.map((level) => ({
        // Falls back to the numeric ID when read_locations is not granted.
        location: level.location.name || level.location.id.split("/").pop(),
        locationId: level.location.id,
        isActive: level.location.isActive === undefined ? null : level.location.isActive,
        quantities: Object.fromEntries(level.quantities.map((q) => [q.name, q.quantity])),
      }));
    }
    return row;
  });

  const tracked = items.filter((item) => item.tracked);
  return {
    // Lets callers tell the user why locations are showing as IDs.
    locationNames,
    variantCount: items.length,
    // inventoryQuantity is null for untracked variants, so only sum tracked ones.
    totalUnits: tracked.reduce((sum, item) => sum + (item.available || 0), 0),
    outOfStock: tracked.filter((item) => (item.available || 0) <= 0).length,
    items,
  };
}

/* --------------------------- *
 * 3. List existing draft orders
 * --------------------------- */

const DRAFT_ORDERS = `
  query draftOrders($pageSize: Int!, $cursor: String, $search: String) {
    draftOrders(first: $pageSize, after: $cursor, query: $search, sortKey: UPDATED_AT, reverse: true) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        name
        status
        createdAt
        updatedAt
        completedAt
        invoiceUrl
        invoiceSentAt
        note2
        tags
        currencyCode
        totalPriceSet { shopMoney { amount currencyCode } }
        subtotalPriceSet { shopMoney { amount currencyCode } }
        totalTaxSet { shopMoney { amount currencyCode } }
        customer { id displayName email phone }
        order { id name }
        lineItems(first: 50) {
          nodes {
            title
            variantTitle
            sku
            quantity
            originalUnitPriceSet { shopMoney { amount currencyCode } }
          }
        }
      }
    }
  }
`;

/**
 * All draft orders, newest-updated first.
 *
 * @param {{ status?: "OPEN"|"INVOICE_SENT"|"COMPLETED", search?: string }} [options]
 *   status filters via the search syntax; search passes a raw query string
 *   through and takes precedence over status.
 */
async function listDraftOrders(options = {}) {
  let search = options.search || null;
  if (!search && options.status) {
    search = `status:${String(options.status).toLowerCase()}`;
  }

  const drafts = await paginate(
    DRAFT_ORDERS,
    { pageSize: PAGE_SIZE, search },
    (data) => data.draftOrders
  );

  return {
    draftOrderCount: drafts.length,
    draftOrders: drafts.map((draft) => ({
      ...draft,
      lineItems: draft.lineItems.nodes,
    })),
  };
}

/* ------------------------------------------------------------------ *
 * Shared helpers for the chatbot tools below
 * ------------------------------------------------------------------ */

// Shopify's search syntax is quote-delimited, so a stray " or \ in user input
// would otherwise change the meaning of the query rather than being matched.
const escapeSearch = (value) => String(value).trim().replace(/(["\\])/g, "\\$1");

/**
 * Accept either a full gid or a bare numeric id, since a chatbot user will
 * paste whichever one they happen to be looking at.
 */
function toGid(type, value) {
  const id = String(value).trim();
  if (id.startsWith("gid://")) return id;
  if (/^\d+$/.test(id)) return `gid://shopify/${type}/${id}`;
  throw new Error(`Not a valid ${type} id: ${value}`);
}

/**
 * Shopify mutations report business-rule failures in `userErrors` with a 200 OK,
 * so these never surface as GraphQL errors and have to be checked explicitly.
 */
function assertNoUserErrors(payload, label) {
  const errors = (payload && payload.userErrors) || [];
  if (errors.length) {
    const detail = errors
      .map((e) => [(e.field || []).join("."), e.message].filter(Boolean).join(": "))
      .join("; ");
    throw new Error(`${label}: ${detail}`);
  }
}

/* ------------------------------------------------------------------ *
 * 4. Product search
 * ------------------------------------------------------------------ */

// featuredImage and ProductVariant.image were both removed in API 2026-07 —
// images now hang off featuredMedia.preview.
const PRODUCT_SEARCH = `
  query productSearch($first: Int!, $variantLimit: Int!, $search: String) {
    products(first: $first, query: $search, sortKey: RELEVANCE) {
      pageInfo { hasNextPage }
      nodes {
        id
        title
        handle
        status
        vendor
        productType
        tags
        totalInventory
        description(truncateAt: 200)
        featuredMedia { preview { image { url altText } } }
        priceRangeV2 {
          minVariantPrice { amount currencyCode }
          maxVariantPrice { amount currencyCode }
        }
        variants(first: $variantLimit) {
          nodes {
            id
            title
            sku
            price
            compareAtPrice
            availableForSale
            inventoryQuantity
          }
        }
      }
    }
  }
`;

/**
 * Free-text product search across titles, SKUs, vendors and tags.
 *
 * @param {{ query?: string, limit?: number, variantLimit?: number,
 *           status?: "ACTIVE"|"ARCHIVED"|"DRAFT" }} [options]
 *   query is passed to Shopify's search syntax, so filters like
 *   `vendor:Acme` or `tag:sale` work alongside plain words. Omit it to list
 *   products. status appends a status filter. limit defaults to
 *   config.products.displayLimit and is capped at maxDisplayLimit.
 * @returns {Promise<object>} matches, newest-relevance first
 */
async function searchProducts(options = {}) {
  const { displayLimit, maxDisplayLimit, variantLimit: defaultVariants } = config.products;
  const limit = Math.min(Math.max(Number(options.limit) || displayLimit, 1), maxDisplayLimit);
  const variantLimit = Math.min(Math.max(Number(options.variantLimit) || defaultVariants, 1), 100);

  const terms = [];
  // A bare term is a full-text match; quoting it would force a phrase match and
  // miss "Blue Shirt" for the query "shirt blue".
  if (options.query && options.query.trim()) terms.push(options.query.trim());
  if (options.status) terms.push(`status:${escapeSearch(options.status).toLowerCase()}`);
  const search = terms.length ? terms.join(" AND ") : null;

  const { products } = await adminRequest(PRODUCT_SEARCH, { first: limit, variantLimit, search });

  return {
    query: search,
    productCount: products.nodes.length,
    // The display limit is a real cap, so say when it hid something rather
    // than letting "6 products" read as "all the matches".
    hasMore: products.pageInfo.hasNextPage,
    displayLimit: limit,
    products: products.nodes.map((product) => ({
      productId: product.id,
      title: product.title,
      handle: product.handle,
      status: product.status,
      vendor: product.vendor,
      productType: product.productType,
      tags: product.tags,
      description: product.description,
      totalInventory: product.totalInventory,
      imageUrl: product.featuredMedia?.preview?.image?.url || null,
      priceRange: {
        min: product.priceRangeV2.minVariantPrice,
        max: product.priceRangeV2.maxVariantPrice,
      },
      // variantId is what add_product_to_cart needs, so it's surfaced per variant.
      variants: product.variants.nodes.map((variant) => ({
        variantId: variant.id,
        title: variant.title,
        sku: variant.sku,
        price: variant.price,
        compareAtPrice: variant.compareAtPrice,
        availableForSale: variant.availableForSale,
        inventoryQuantity: variant.inventoryQuantity,
      })),
    })),
  };
}

/* ------------------------------------------------------------------ *
 * 5. Add a product to a cart
 *
 * The Admin API has no cart — carts live in the Storefront API. A draft order
 * is the Admin-side equivalent: a mutable, unpaid basket that shows up in the
 * Shopify admin and can be converted to a real order, so "cart id" below is
 * always a draft order gid.
 * ------------------------------------------------------------------ */

const CART_FIELDS = `
  id
  name
  status
  invoiceUrl
  currencyCode
  subtotalPriceSet { shopMoney { amount currencyCode } }
  totalPriceSet { shopMoney { amount currencyCode } }
  customer { id displayName email }
  lineItems(first: 100) {
    nodes {
      title
      variantTitle
      sku
      quantity
      custom
      requiresShipping
      taxable
      variant { id }
      image { url altText }
      originalUnitPriceSet { shopMoney { amount currencyCode } }
      discountedTotalSet { shopMoney { amount currencyCode } }
    }
  }
`;

const CART_BY_ID = `query cart($id: ID!) { draftOrder(id: $id) { ${CART_FIELDS} } }`;

const DRAFT_ORDER_CREATE = `
  mutation draftOrderCreate($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder { ${CART_FIELDS} }
      userErrors { field message }
    }
  }
`;

const DRAFT_ORDER_UPDATE = `
  mutation draftOrderUpdate($id: ID!, $input: DraftOrderInput!) {
    draftOrderUpdate(id: $id, input: $input) {
      draftOrder { ${CART_FIELDS} }
      userErrors { field message }
    }
  }
`;

const VARIANT_BY_SKU = `
  query variantBySku($search: String!) {
    productVariants(first: 5, query: $search) {
      nodes {
        id
        title
        sku
        price
        availableForSale
        inventoryQuantity
        product { id title status }
      }
    }
  }
`;

const CUSTOMER_ID_BY_EMAIL = `
  query customerIdByEmail($search: String!) {
    customers(first: 1, query: $search) { nodes { id email displayName } }
  }
`;

/** Shape a draft order into the flatter cart view the chatbot reports back. */
function formatCart(draftOrder) {
  return {
    cartId: draftOrder.id,
    name: draftOrder.name,
    status: draftOrder.status,
    invoiceUrl: draftOrder.invoiceUrl,
    currencyCode: draftOrder.currencyCode,
    customer: draftOrder.customer,
    subtotal: draftOrder.subtotalPriceSet?.shopMoney || null,
    total: draftOrder.totalPriceSet?.shopMoney || null,
    itemCount: draftOrder.lineItems.nodes.reduce((sum, li) => sum + li.quantity, 0),
    lineItems: draftOrder.lineItems.nodes.map((li) => ({
      title: li.title,
      variantTitle: li.variantTitle,
      variantId: li.variant ? li.variant.id : null,
      sku: li.sku,
      quantity: li.quantity,
      unitPrice: li.originalUnitPriceSet?.shopMoney || null,
      lineTotal: li.discountedTotalSet?.shopMoney || null,
      imageUrl: li.image?.url || null,
    })),
  };
}

/**
 * draftOrderUpdate *replaces* the whole line-item list rather than appending to
 * it, so every existing line has to be rebuilt in the input or it silently
 * disappears. Variant lines collapse to {variantId, quantity}; custom lines
 * (no variant) have to be re-sent field by field to survive the round trip.
 */
function rebuildLineItems(existing, variantGid, quantity) {
  const items = existing.map((li) => {
    if (li.variant && li.variant.id) {
      return { variantId: li.variant.id, quantity: li.quantity };
    }
    const money = li.originalUnitPriceSet.shopMoney;
    return {
      title: li.title,
      sku: li.sku || undefined,
      quantity: li.quantity,
      requiresShipping: li.requiresShipping,
      taxable: li.taxable,
      originalUnitPriceWithCurrency: {
        amount: money.amount,
        currencyCode: money.currencyCode,
      },
    };
  });

  // Adding a variant that's already in the cart bumps its quantity instead of
  // creating a duplicate line.
  const match = items.find((item) => item.variantId === variantGid);
  if (match) match.quantity += quantity;
  else items.push({ variantId: variantGid, quantity });

  return items;
}

/**
 * Add a product variant to a cart (draft order), creating the cart when no
 * cartId is supplied.
 *
 * @param {{ variantId?: string, sku?: string, quantity?: number,
 *           cartId?: string, email?: string }} options
 *   One of variantId or sku identifies the variant. Pass the cartId returned by
 *   a previous call to keep adding to the same cart. email attaches the cart to
 *   a customer — matched to a real customer record when one exists.
 * @returns {Promise<object>} the cart after the add
 */
async function addProductToCart(options = {}) {
  const quantity = Math.max(Number(options.quantity) || 1, 1);

  if (!options.variantId && !options.sku) {
    throw new Error("addProductToCart: either variantId or sku is required");
  }

  // Resolve the variant first — a bad SKU should fail before we touch a cart.
  let variantGid;
  let resolvedVariant = null;
  if (options.variantId) {
    variantGid = toGid("ProductVariant", options.variantId);
  } else {
    const search = `sku:"${escapeSearch(options.sku)}"`;
    const { productVariants } = await adminRequest(VARIANT_BY_SKU, { search });
    if (!productVariants.nodes.length) {
      throw new Error(`No product variant found with SKU "${options.sku}"`);
    }
    resolvedVariant = productVariants.nodes[0];
    variantGid = resolvedVariant.id;
  }

  // customerId moved under purchasingEntity in API 2026-07; DraftOrderInput has
  // no customerId field any more.
  const purchasing = {};
  if (options.email) {
    const search = `email:"${escapeSearch(options.email)}"`;
    const { customers } = await adminRequest(CUSTOMER_ID_BY_EMAIL, { search });
    const customer = customers.nodes[0];
    if (customer) purchasing.purchasingEntity = { customerId: customer.id };
    // No matching customer record — keep the address as a plain guest email.
    else purchasing.email = options.email.trim();
  }

  if (!options.cartId) {
    const data = await adminRequest(DRAFT_ORDER_CREATE, {
      input: { lineItems: [{ variantId: variantGid, quantity }], ...purchasing },
    });
    assertNoUserErrors(data.draftOrderCreate, "Could not create cart");
    return {
      created: true,
      variant: resolvedVariant,
      cart: formatCart(data.draftOrderCreate.draftOrder),
    };
  }

  const cartGid = toGid("DraftOrder", options.cartId);
  const { draftOrder } = await adminRequest(CART_BY_ID, { id: cartGid });
  if (!draftOrder) throw new Error(`No cart found with id ${options.cartId}`);
  if (draftOrder.status === "COMPLETED") {
    throw new Error(`Cart ${draftOrder.name} is already completed and cannot be changed`);
  }

  const data = await adminRequest(DRAFT_ORDER_UPDATE, {
    id: cartGid,
    input: {
      lineItems: rebuildLineItems(draftOrder.lineItems.nodes, variantGid, quantity),
      ...purchasing,
    },
  });
  assertNoUserErrors(data.draftOrderUpdate, "Could not update cart");

  return {
    created: false,
    variant: resolvedVariant,
    cart: formatCart(data.draftOrderUpdate.draftOrder),
  };
}

/* ------------------------------------------------------------------ *
 * 6. Customer information (contact details only, no order history)
 * ------------------------------------------------------------------ */

const CUSTOMER_SEARCH = `
  query customerSearch($first: Int!, $search: String) {
    customers(first: $first, query: $search, sortKey: RELEVANCE) {
      nodes {
        id
        firstName
        lastName
        displayName
        email
        phone
        note
        tags
        verifiedEmail
        createdAt
        updatedAt
        numberOfOrders
        amountSpent { amount currencyCode }
        defaultEmailAddress { emailAddress marketingState }
        defaultAddress {
          address1
          address2
          city
          province
          provinceCode
          country
          countryCodeV2
          zip
          company
          phone
        }
      }
    }
  }
`;

/**
 * Look up customers by email, name or phone.
 *
 * @param {{ query: string, limit?: number }} options
 *   A query containing "@" is treated as an exact email lookup; anything else
 *   is a full-text search across name, email and phone.
 * @returns {Promise<object>} matching customers (possibly empty)
 */
async function getCustomerInformation(options = {}) {
  const term = (options.query || "").trim();
  if (!term) throw new Error("getCustomerInformation: a query is required");
  const { displayLimit, maxDisplayLimit } = config.customers;
  const limit = Math.min(Math.max(Number(options.limit) || displayLimit, 1), maxDisplayLimit);

  // An exact email match is both cheaper and unambiguous, so prefer it when the
  // query obviously is one.
  const search = term.includes("@") ? `email:"${escapeSearch(term)}"` : term;
  const { customers } = await adminRequest(CUSTOMER_SEARCH, { first: limit, search });

  return {
    query: search,
    customerCount: customers.nodes.length,
    customers: customers.nodes.map((customer) => ({
      customerId: customer.id,
      displayName: customer.displayName,
      firstName: customer.firstName,
      lastName: customer.lastName,
      email: customer.email,
      phone: customer.phone,
      verifiedEmail: customer.verifiedEmail,
      marketingState: customer.defaultEmailAddress?.marketingState || null,
      note: customer.note,
      tags: customer.tags,
      numberOfOrders: customer.numberOfOrders,
      amountSpent: customer.amountSpent,
      defaultAddress: customer.defaultAddress,
      createdAt: customer.createdAt,
      updatedAt: customer.updatedAt,
    })),
  };
}

/* ------------------------------------------------------------------ *
 * 7. Orders for one customer
 * ------------------------------------------------------------------ */

/**
 * Recent orders for a single customer, newest first.
 *
 * Unlike getCustomerWithOrderHistory this takes one page instead of walking the
 * whole history — a chatbot answer only ever shows the last handful, and a
 * long-standing customer would otherwise cost many requests per question.
 *
 * @param {{ query?: string, customerId?: string, limit?: number }} options
 *   Identify the customer by customerId, or by query (email / name / phone).
 * @returns {Promise<object>} null-safe result; `customer` is null when nothing matched
 */
async function getOrdersForCustomer(options = {}) {
  const { displayLimit, maxDisplayLimit } = config.orders;
  const limit = Math.min(Math.max(Number(options.limit) || displayLimit, 1), maxDisplayLimit);

  let customerId = options.customerId ? toGid("Customer", options.customerId) : null;
  let customer = null;

  if (!customerId) {
    const found = await getCustomerInformation({ query: options.query, limit: 1 });
    if (!found.customers.length) {
      return { customer: null, orderCount: 0, orders: [], query: found.query };
    }
    customer = found.customers[0];
    customerId = customer.customerId;
  }

  const data = await adminRequest(CUSTOMER_ORDERS, { id: customerId, pageSize: limit, cursor: null });
  if (!data.customer) throw new Error(`No customer found with id ${customerId}`);

  const orders = data.customer.orders.nodes;
  return {
    customer: customer || { customerId },
    orderCount: orders.length,
    // Signals to the caller that older orders exist beyond this page.
    hasMore: data.customer.orders.pageInfo.hasNextPage,
    orders: orders.map((order) => ({
      orderId: order.id,
      name: order.name,
      createdAt: order.createdAt,
      processedAt: order.processedAt,
      cancelledAt: order.cancelledAt,
      financialStatus: order.displayFinancialStatus,
      fulfillmentStatus: order.displayFulfillmentStatus,
      total: order.currentTotalPriceSet?.shopMoney || null,
      originalTotal: order.totalPriceSet?.shopMoney || null,
      refunded: order.totalRefundedSet?.shopMoney || null,
      shippingAddress: order.shippingAddress,
      lineItems: order.lineItems.nodes,
    })),
  };
}

module.exports = {
  getCustomerWithOrderHistory,
  getInventoryLevels,
  listDraftOrders,
  paginate,
  // Backing the four chatbot / MCP tools
  searchProducts,
  addProductToCart,
  getCustomerInformation,
  getOrdersForCustomer,
};
