import { useEffect, useRef, useState } from "react";
import { money } from "./format.js";

/**
 * Horizontally scrolling product tiles built from a `search_products` result.
 *
 * Scrolling is native overflow rather than a transform, so a trackpad swipe and
 * the arrow buttons drive the same thing and keyboard focus still works.
 */
export default function ProductCarousel({ result, onAddToCart, disabled }) {
  const track = useRef(null);
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(false);

  const products = result?.products || [];

  // Arrow enabled-state has to follow real scroll position, whether it changed
  // from a button, a swipe, or the container being resized.
  useEffect(() => {
    const node = track.current;
    if (!node) return;

    const sync = () => {
      const max = node.scrollWidth - node.clientWidth;
      setAtStart(node.scrollLeft <= 1);
      // A 1px tolerance: fractional layout widths mean scrollLeft rarely lands
      // exactly on max.
      setAtEnd(node.scrollLeft >= max - 1);
    };

    sync();
    node.addEventListener("scroll", sync, { passive: true });
    const observer = new ResizeObserver(sync);
    observer.observe(node);
    return () => {
      node.removeEventListener("scroll", sync);
      observer.disconnect();
    };
  }, [products.length]);

  if (!products.length) return null;

  const scrollByTile = (direction) => {
    const node = track.current;
    if (!node) return;
    const tile = node.querySelector(".tile");
    // Fall back to most of the viewport when there is no tile to measure.
    const step = tile ? tile.offsetWidth + 12 : node.clientWidth * 0.8;
    node.scrollBy({ left: step * direction, behavior: "smooth" });
  };

  return (
    <section className="carousel" aria-label="Product results">
      <header className="carousel-head">
        <span>
          {products.length} product{products.length === 1 ? "" : "s"}
          {result.hasMore && <span className="muted"> · more available</span>}
        </span>
        {products.length > 1 && (
          <div className="carousel-nav">
            <button onClick={() => scrollByTile(-1)} disabled={atStart} aria-label="Previous products">
              ‹
            </button>
            <button onClick={() => scrollByTile(1)} disabled={atEnd} aria-label="Next products">
              ›
            </button>
          </div>
        )}
      </header>

      <div className="carousel-track" ref={track}>
        {products.map((product) => (
          <ProductTile
            key={product.productId}
            product={product}
            onAddToCart={onAddToCart}
            disabled={disabled}
          />
        ))}
      </div>
    </section>
  );
}

function ProductTile({ product, onAddToCart, disabled }) {
  const variants = product.variants || [];
  const [variantId, setVariantId] = useState(variants[0]?.variantId);
  const variant = variants.find((v) => v.variantId === variantId) || variants[0];

  // A variant price is exact; the range is only a fallback for a tile with no
  // variants at all.
  const price = variant?.price
    ? money(variant.price, product.priceRange?.min?.currencyCode)
    : money(product.priceRange?.min?.amount, product.priceRange?.min?.currencyCode);

  const stock = variant?.inventoryQuantity;
  const soldOut = variant ? variant.availableForSale === false : false;

  return (
    <article className="tile">
      <div className="tile-media">
        {product.imageUrl ? (
          <img src={product.imageUrl} alt={product.title} loading="lazy" />
        ) : (
          <div className="tile-noimage">No image</div>
        )}
        {soldOut && <span className="tile-badge">Sold out</span>}
      </div>

      <div className="tile-body">
        <h5 title={product.title}>{product.title}</h5>
        {product.vendor && <p className="tile-vendor">{product.vendor}</p>}
        <p className="tile-price">{price}</p>

        {variants.length > 1 ? (
          <select
            value={variantId}
            onChange={(event) => setVariantId(event.target.value)}
            aria-label={`Variant of ${product.title}`}
          >
            {variants.map((option) => (
              <option key={option.variantId} value={option.variantId}>
                {option.title}
                {option.availableForSale === false ? " — sold out" : ""}
              </option>
            ))}
          </select>
        ) : (
          variant?.title &&
          variant.title !== "Default Title" && <p className="tile-variant">{variant.title}</p>
        )}

        <p className="tile-stock">
          {typeof stock === "number" ? `${stock} in stock` : "Stock not tracked"}
          {variant?.sku && <span className="muted"> · {variant.sku}</span>}
        </p>

        <button
          className="tile-add"
          disabled={disabled || !variant}
          // Routed back through the chat rather than calling the tool directly,
          // so the assistant stays aware of the cart it is talking about.
          onClick={() => onAddToCart(product, variant)}
        >
          Add to cart
        </button>
      </div>
    </article>
  );
}
