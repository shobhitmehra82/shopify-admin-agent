import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { requireApproval } from '../approval.js';
import { closeOrder, reopenOrder, cancelOrder } from '../shopifyClient.js';

/**
 * A real write (close/reopen/cancel). Scope: write_orders.
 * Every call must pass requireApproval() before reaching the Admin API.
 */
export const updateOrderStatus = tool(
  'update_order_status',
  'Close, reopen, or cancel a Shopify order. Requires admin/staff approval and explicit confirmation.',
  {
    orderId: z.string().describe('The Shopify order ID to update'),
    action: z.enum(['close', 'reopen', 'cancel']).describe('The status change to apply'),
    reason: z.string().optional().describe('Optional reason, used only when action is "cancel"'),
    role: z.enum(['admin', 'staff', 'shopper']).describe('The role of the caller requesting this action'),
    confirmed: z.boolean().describe('Whether the caller has explicitly confirmed this write action'),
  },
  async ({ orderId, action, reason, role, confirmed }) => {
    const approval = requireApproval({ role, confirmed });
    if (!approval.approved) {
      return {
        content: [{ type: 'text', text: `Approval denied: ${approval.reason}` }],
        isError: true,
      };
    }

    try {
      let order;
      if (action === 'close') order = await closeOrder(orderId);
      else if (action === 'reopen') order = await reopenOrder(orderId);
      else order = await cancelOrder(orderId, { reason });

      return {
        content: [{ type: 'text', text: JSON.stringify({ orderId, action, order }, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  },
);
