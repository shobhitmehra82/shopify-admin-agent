// Shopify returns money as a decimal string plus a currency code
// (`{ amount: "578.00", currencyCode: "USD" }`), so formatting is shared rather
// than re-derived in every component.

/**
 * @param {string|number|null} amount
 * @param {string} [currencyCode]
 * @returns {string} e.g. "$578.00", or "—" when there is no amount
 */
export function money(amount, currencyCode = "USD") {
  if (amount === null || amount === undefined || amount === "") return "—";
  const value = Number(amount);
  if (!Number.isFinite(value)) return "—";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currencyCode || "USD",
    }).format(value);
  } catch {
    // An unrecognised currency code would otherwise throw a RangeError and take
    // the whole tile down with it.
    return `${value.toFixed(2)} ${currencyCode || ""}`.trim();
  }
}
