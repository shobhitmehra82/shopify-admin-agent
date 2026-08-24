// Interactive console with the Admin API helpers preloaded.
//   node console.js
//
//   > await getCustomerWithOrderHistory("someone@example.com")
//   > await getInventoryLevels()
//   > await listDraftOrders({ status: "OPEN" })
//   > show(await listDraftOrders())     // pretty-print without depth truncation

const repl = require("repl");
const util = require("util");
const { adminRequest } = require("./adminClient");
const queries = require("./shopifyQueries");

console.log(`Shopify Admin console — store: ${process.env.SHOPIFY_STORE_DOMAIN}

Available:
  getCustomerWithOrderHistory(email)
  getInventoryLevels({ byLocation })
  listDraftOrders({ status, search })
  adminRequest(query, variables)
  show(value)   // full-depth JSON dump
`);

const session = repl.start({ prompt: "shopify> " });

Object.assign(session.context, queries, {
  adminRequest,
  show: (value) => console.log(util.inspect(value, { depth: null, colors: true })),
});
