import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveByName, NoMatchError, AmbiguousMatchError } from '../src/matching.js';

const locations = [
  { name: 'Downtown Warehouse' },
  { name: 'Uptown Store' },
  { name: 'Uptown Store Annex' },
];

test('exact match wins even when substring matches also exist', () => {
  const result = resolveByName(locations, 'Uptown Store', { getName: (l) => l.name });
  assert.equal(result.name, 'Uptown Store');
});

test('falls back to a unique substring match when there is no exact match', () => {
  const result = resolveByName(locations, 'Downtown', { getName: (l) => l.name });
  assert.equal(result.name, 'Downtown Warehouse');
});

test('matching is case-insensitive', () => {
  const result = resolveByName(locations, 'uptown store', { getName: (l) => l.name });
  assert.equal(result.name, 'Uptown Store');
});

test('throws NoMatchError when nothing matches', () => {
  assert.throws(() => resolveByName(locations, 'Nonexistent', { getName: (l) => l.name }), NoMatchError);
});

test('throws AmbiguousMatchError for multiple substring matches', () => {
  assert.throws(() => resolveByName(locations, 'Store', { getName: (l) => l.name }), AmbiguousMatchError);
});

test('throws AmbiguousMatchError for multiple exact matches', () => {
  const duplicates = [{ name: 'Warehouse' }, { name: 'Warehouse' }];
  assert.throws(() => resolveByName(duplicates, 'Warehouse', { getName: (l) => l.name }), AmbiguousMatchError);
});

test('throws NoMatchError on empty item list', () => {
  assert.throws(() => resolveByName([], 'Anything', { getName: (l) => l.name }), NoMatchError);
});
