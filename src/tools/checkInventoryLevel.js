import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { listProductsByTitle, listLocations, getInventoryLevels } from '../shopifyClient.js';
import { resolveByName } from '../matching.js';

/**
 * Read-only. Scopes: read_inventory, read_products, read_locations.
 * Takes human-readable product/location names, not raw Shopify IDs.
 */
export const checkInventoryLevel = tool(
  'check_inventory_level',
  "Look up available inventory for a product's variants at a specific location, " +
    'using the product and location names as they appear in Shopify (not IDs).',
  {
    productName: z.string().describe('The product title exactly (or approximately) as it appears in Shopify'),
    locationName: z.string().describe('The location name exactly (or approximately) as it appears in Shopify'),
  },
  async ({ productName, locationName }) => {
    try {
      const products = await listProductsByTitle(productName);
      const product = resolveByName(products, productName, { getName: (p) => p.title });

      const locations = await listLocations();
      const location = resolveByName(locations, locationName, { getName: (l) => l.name });

      const variants = product.variants ?? [];
      const inventoryItemIds = variants.map((v) => v.inventory_item_id);
      const levels = await getInventoryLevels({ inventoryItemIds, locationId: location.id });
      const availableByItemId = new Map(levels.map((l) => [l.inventory_item_id, l.available]));

      const result = {
        product: product.title,
        location: location.name,
        variants: variants.map((v) => ({
          variantId: v.id,
          variantTitle: v.title,
          sku: v.sku,
          available: availableByItemId.get(v.inventory_item_id) ?? null,
        })),
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  },
);
