import { getAccessToken } from './shopifyAuth.js';

const API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-07';

function getDomain() {
  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  if (!domain) {
    throw new Error('Missing required environment variable: SHOPIFY_STORE_DOMAIN');
  }
  return domain;
}

async function adminRequest(path, { method = 'GET', body, searchParams } = {}) {
  const accessToken = await getAccessToken();
  const url = new URL(`https://${getDomain()}/admin/api/${API_VERSION}${path}`);

  if (searchParams) {
    for (const [key, value] of Object.entries(searchParams)) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
  }

  const response = await fetch(url, {
    method,
    headers: {
      'X-Shopify-Access-Token': accessToken,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Shopify Admin API request failed (${response.status} ${method} ${path}): ${text}`);
  }

  return response.json();
}

/** Uses the Admin API's product title filter. Scope: read_products. */
export async function listProductsByTitle(title) {
  const data = await adminRequest('/products.json', { searchParams: { title } });
  return data.products ?? [];
}

/** Scope: read_locations. */
export async function listLocations() {
  const data = await adminRequest('/locations.json');
  return data.locations ?? [];
}

/** Scope: read_inventory. */
export async function getInventoryLevels({ inventoryItemIds, locationId }) {
  if (inventoryItemIds.length === 0) return [];
  const data = await adminRequest('/inventory_levels.json', {
    searchParams: {
      inventory_item_ids: inventoryItemIds.join(','),
      location_ids: String(locationId),
    },
  });
  return data.inventory_levels ?? [];
}

/** Scope: write_orders. */
export async function closeOrder(orderId) {
  const data = await adminRequest(`/orders/${orderId}/close.json`, { method: 'POST', body: {} });
  return data.order;
}

/** Scope: write_orders. */
export async function reopenOrder(orderId) {
  const data = await adminRequest(`/orders/${orderId}/open.json`, { method: 'POST', body: {} });
  return data.order;
}

/** Scope: write_orders. */
export async function cancelOrder(orderId, { reason } = {}) {
  const data = await adminRequest(`/orders/${orderId}/cancel.json`, {
    method: 'POST',
    body: reason ? { reason } : {},
  });
  return data.order;
}
