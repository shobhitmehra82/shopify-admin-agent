import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requireApproval } from '../src/approval.js';

test('shopper is rejected even when confirmed', () => {
  const result = requireApproval({ role: 'shopper', confirmed: true });
  assert.equal(result.approved, false);
});

test('shopper is rejected when not confirmed', () => {
  const result = requireApproval({ role: 'shopper', confirmed: false });
  assert.equal(result.approved, false);
});

test('admin is rejected without confirmation', () => {
  const result = requireApproval({ role: 'admin', confirmed: false });
  assert.equal(result.approved, false);
});

test('staff is rejected without confirmation', () => {
  const result = requireApproval({ role: 'staff', confirmed: false });
  assert.equal(result.approved, false);
});

test('admin + confirmed passes', () => {
  const result = requireApproval({ role: 'admin', confirmed: true });
  assert.equal(result.approved, true);
});

test('staff + confirmed passes', () => {
  const result = requireApproval({ role: 'staff', confirmed: true });
  assert.equal(result.approved, true);
});

test('unrecognized role is rejected even when confirmed', () => {
  const result = requireApproval({ role: 'guest', confirmed: true });
  assert.equal(result.approved, false);
});
