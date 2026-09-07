const { adminRequest } = require("./adminClient");
adminRequest(`
query {
customers(first: 3) {
edges { node { id firstName lastName email numberOfOrders } }
}
}
`).then((data) => console.log(JSON.stringify(data, null, 2))).catch(console.error);