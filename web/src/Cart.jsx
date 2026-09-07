import { money } from "./format.js";

/**
 * The cart, rendered from an `add_product_to_cart` result.
 *
 * The cart is a Shopify draft order, so "Checkout" opens its `invoiceUrl` —
 * the real hosted checkout Shopify generates for that draft.
 */
export default function Cart({ result, onAddMore, disabled }) {
  const cart = result?.cart;
  if (!cart) return null;

  const currency = cart.currencyCode || cart.total?.currencyCode;
  const lineItems = cart.lineItems || [];

  return (
    <section className="cart" aria-label="Cart">
      <header className="cart-head">
        <span className="cart-title">
          Cart <span className="muted">{cart.name}</span>
        </span>
        <span className="muted">
          {cart.itemCount} item{cart.itemCount === 1 ? "" : "s"}
        </span>
      </header>

      {cart.customer && (
        <p className="cart-customer">
          {cart.customer.displayName}
          {cart.customer.email && <span className="muted"> · {cart.customer.email}</span>}
        </p>
      )}

      <ul className="cart-lines">
        {lineItems.map((line, index) => (
          // Draft order line items have no stable id in this payload, and the
          // same variant can legitimately appear twice, so index is the key.
          <li key={index}>
            {line.imageUrl ? (
              <img src={line.imageUrl} alt={line.title} loading="lazy" />
            ) : (
              <div className="cart-noimage" />
            )}

            <div className="cart-line-body">
              <span className="cart-line-title">{line.title}</span>
              {line.variantTitle && line.variantTitle !== "Default Title" && (
                <span className="muted">{line.variantTitle}</span>
              )}
              <span className="muted">
                {money(line.unitPrice?.amount, line.unitPrice?.currencyCode || currency)} each
                {line.sku && ` · ${line.sku}`}
              </span>
            </div>

            <div className="cart-line-right">
              <span className="cart-qty">{`×${line.quantity}`}</span>
              <span className="cart-line-total">
                {money(line.lineTotal?.amount, line.lineTotal?.currencyCode || currency)}
              </span>
            </div>
          </li>
        ))}
      </ul>

      <dl className="cart-totals">
        {/* Shopify only fills subtotal once it differs from the total, so
            showing both unconditionally would often print the same number twice. */}
        {cart.subtotal && cart.subtotal.amount !== cart.total?.amount && (
          <div>
            <dt>Subtotal</dt>
            <dd>{money(cart.subtotal.amount, cart.subtotal.currencyCode || currency)}</dd>
          </div>
        )}
        <div className="cart-total-row">
          <dt>Total</dt>
          <dd>{money(cart.total?.amount, cart.total?.currencyCode || currency)}</dd>
        </div>
      </dl>

      <div className="cart-actions">
        {cart.invoiceUrl ? (
          <a
            className="cart-checkout"
            href={cart.invoiceUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            Checkout
          </a>
        ) : (
          <button className="cart-checkout" disabled title="Shopify has not issued an invoice URL for this draft yet">
            Checkout
          </button>
        )}
        <button className="ghost" onClick={onAddMore} disabled={disabled}>
          Keep shopping
        </button>
      </div>

      <p className="cart-note muted">
        Checkout opens the Shopify invoice for draft order {cart.name}.
      </p>
    </section>
  );
}
