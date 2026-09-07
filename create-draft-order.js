const { adminRequest } = require("./adminClient");
async function main() {
const variantId = "gid://shopify/ProductVariant/49024905183386";
const data = await adminRequest(`
mutation createDraftOrder($variantId: ID!) {
draftOrderCreate(input: { lineItems: [{ variantId: $variantId, quantity: 1 }] }) {
draftOrder { id name invoiceUrl }
userErrors { field message }
}
}
`, { variantId });
if (data.draftOrderCreate.userErrors.length) {
throw new Error(JSON.stringify(data.draftOrderCreate.userErrors));
}
console.log("Draft order created:", data.draftOrderCreate.draftOrder);
}
main().catch(console.error);