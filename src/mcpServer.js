import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { checkInventoryLevel } from './tools/checkInventoryLevel.js';
import { updateOrderStatus } from './tools/updateOrderStatus.js';

export const SERVER_NAME = 'shopify';

export const shopifyMcpServer = createSdkMcpServer({
  name: SERVER_NAME,
  version: '1.0.0',
  tools: [checkInventoryLevel, updateOrderStatus],
});
