import 'dotenv/config';

let cachedToken = null; // { accessToken, expiresAt }

const EXPIRY_BUFFER_MS = 60_000;

function getEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/**
 * Exchanges the app's client credentials for an Admin API access token,
 * caching it in memory until shortly before it expires.
 */
export async function getAccessToken({ forceRefresh = false } = {}) {
  const now = Date.now();
  if (!forceRefresh && cachedToken && cachedToken.expiresAt - EXPIRY_BUFFER_MS > now) {
    return cachedToken.accessToken;
  }

  const domain = getEnv('SHOPIFY_STORE_DOMAIN');
  const clientId = getEnv('SHOPIFY_APP_CLIENT_ID');
  const clientSecret = getEnv('SHOPIFY_APP_CLIENT_SECRET');

  const response = await fetch(`https://${domain}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'client_credentials',
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Shopify OAuth token request failed (${response.status}): ${body}`);
  }

  const data = await response.json();
  const ttlMs = (data.expires_in ?? 3600) * 1000;
  cachedToken = {
    accessToken: data.access_token,
    expiresAt: now + ttlMs,
  };
  return cachedToken.accessToken;
}

export function _resetTokenCacheForTests() {
  cachedToken = null;
}
