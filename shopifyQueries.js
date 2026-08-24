const { adminRequest } = require("./adminClient");

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
const PRODUCT_VARIANTS_BY_LOCATION = `
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
              location { id name isActive }
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
 * Current stock for every product variant in the store.
 *
 * @param {{ byLocation?: boolean }} [options] byLocation adds a per-location
 *   breakdown; requires the read_inventory access scope.
 */
async function getInventoryLevels(options = {}) {
  const query = options.byLocation ? PRODUCT_VARIANTS_BY_LOCATION : PRODUCT_VARIANTS;

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
        location: level.location.name,
        locationId: level.location.id,
        isActive: level.location.isActive,
        quantities: Object.fromEntries(level.quantities.map((q) => [q.name, q.quantity])),
      }));
    }
    return row;
  });

  const tracked = items.filter((item) => item.tracked);
  return {
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

module.exports = {
  getCustomerWithOrderHistory,
  getInventoryLevels,
  listDraftOrders,
  paginate,
};
