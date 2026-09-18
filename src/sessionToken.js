import crypto from 'node:crypto';

function base64UrlDecode(segment) {
  const padded = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padLength = (4 - (padded.length % 4)) % 4;
  return Buffer.from(padded + '='.repeat(padLength), 'base64');
}

/**
 * Verifies a Shopify App Bridge session token (HS256 JWT) using only
 * node:crypto - the shared secret is the app's own client secret, so a
 * general-purpose JWT library would add a dependency for a single
 * well-defined signature check.
 */
export function verifySessionToken(token, { clientId, clientSecret, shopDomain }) {
  if (typeof token !== 'string' || token === '') {
    throw new Error('Missing session token');
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Malformed session token');
  }
  const [headerB64, payloadB64, signatureB64] = parts;

  let header;
  let payload;
  try {
    header = JSON.parse(base64UrlDecode(headerB64).toString('utf8'));
    payload = JSON.parse(base64UrlDecode(payloadB64).toString('utf8'));
  } catch {
    throw new Error('Malformed session token');
  }

  if (header.alg !== 'HS256') {
    throw new Error(`Unsupported session token algorithm: ${header.alg}`);
  }

  const expectedSignature = crypto.createHmac('sha256', clientSecret).update(`${headerB64}.${payloadB64}`).digest();
  const actualSignature = base64UrlDecode(signatureB64);

  const signatureValid =
    expectedSignature.length === actualSignature.length && crypto.timingSafeEqual(expectedSignature, actualSignature);
  if (!signatureValid) {
    throw new Error('Invalid session token signature');
  }

  if (payload.aud !== clientId) {
    throw new Error('Session token audience mismatch');
  }

  if (payload.dest !== `https://${shopDomain}`) {
    throw new Error('Session token destination mismatch');
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp <= nowSeconds) {
    throw new Error('Session token expired');
  }

  return payload;
}
