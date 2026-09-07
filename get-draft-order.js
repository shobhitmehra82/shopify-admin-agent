const { adminRequest } = require("./adminClient");
async function main() {
const draftOrderId = "gid://shopify/DraftOrder/1202400559258";
const data = await adminRequest(`
query getDraftOrder($id: ID!) {
draftOrder(id: $id) {
id
name
invoiceUrl
totalPrice
lineItems(first: 5) { edges { node { title quantity } } }
}
}
`, { id: draftOrderId });
console.log("Fetched back:", JSON.stringify(data.draftOrder, null, 2));
}
main().catch(console.error);