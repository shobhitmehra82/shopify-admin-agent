export class NoMatchError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NoMatchError';
  }
}

export class AmbiguousMatchError extends Error {
  constructor(message, matches) {
    super(message);
    this.name = 'AmbiguousMatchError';
    this.matches = matches;
  }
}

/**
 * Resolves a human-typed name against a list of items by display name.
 * An exact (case-insensitive) match wins outright; otherwise falls back to
 * substring matching. Zero or multiple matches at either stage is an error
 * so callers never silently guess.
 */
export function resolveByName(items, name, { getName = (item) => item.name } = {}) {
  const needle = name.trim().toLowerCase();

  const exactMatches = items.filter((item) => getName(item).trim().toLowerCase() === needle);
  if (exactMatches.length === 1) return exactMatches[0];
  if (exactMatches.length > 1) {
    throw new AmbiguousMatchError(
      `Multiple exact matches found for "${name}": ${exactMatches.map(getName).join(', ')}`,
      exactMatches,
    );
  }

  const substringMatches = items.filter((item) => getName(item).trim().toLowerCase().includes(needle));
  if (substringMatches.length === 1) return substringMatches[0];
  if (substringMatches.length > 1) {
    throw new AmbiguousMatchError(
      `Multiple matches found for "${name}": ${substringMatches.map(getName).join(', ')}`,
      substringMatches,
    );
  }

  throw new NoMatchError(`No match found for "${name}"`);
}
