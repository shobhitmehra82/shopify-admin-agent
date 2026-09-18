import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { verifySessionToken } from '../src/sessionToken.js';

const CLIENT_ID = 'test-client-id';
const CLIENT_SECRET = 'test-client-secret';
const SHOP_DOMAIN = 'test-shop.myshopify.com';

function base64Url(input) {
  return Buffer.from(JSON.stringify(input)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function signToken(payload, { secret = CLIENT_SECRET, alg = 'HS256' } = {}) {
  const header = base64Url({ alg, typ: 'JWT' });
  const body = base64Url(payload);
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${header}.${body}`)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${header}.${body}.${signature}`;
}

function validPayload(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    aud: CLIENT_ID,
    dest: `https://${SHOP_DOMAIN}`,
    exp: now + 60,
    iat: now,
    ...overrides,
  };
}

function verify(token) {
  return verifySessionToken(token, { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, shopDomain: SHOP_DOMAIN });
}

test('valid token passes', () => {
  const token = signToken(validPayload());
  const payload = verify(token);
  assert.equal(payload.aud, CLIENT_ID);
});

test('rejects a token signed with the wrong secret', () => {
  const token = signToken(validPayload(), { secret: 'wrong-secret' });
  assert.throws(() => verify(token), /signature/i);
});

test('rejects an expired token', () => {
  const token = signToken(validPayload({ exp: Math.floor(Date.now() / 1000) - 10 }));
  assert.throws(() => verify(token), /expired/i);
});

test('rejects a mismatched audience', () => {
  const token = signToken(validPayload({ aud: 'someone-elses-client-id' }));
  assert.throws(() => verify(token), /audience/i);
});

test('rejects a mismatched destination', () => {
  const token = signToken(validPayload({ dest: 'https://a-different-shop.myshopify.com' }));
  assert.throws(() => verify(token), /destination/i);
});

test('rejects a malformed token', () => {
  assert.throws(() => verify('not-a-jwt'), /malformed/i);
});

test('rejects a missing token', () => {
  assert.throws(() => verify(''), /missing/i);
});

test('rejects an unsupported algorithm', () => {
  const token = signToken(validPayload(), { alg: 'none' });
  assert.throws(() => verify(token), /algorithm/i);
});
