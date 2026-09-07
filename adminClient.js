// Two things matter here, both for the MCP server:
//   quiet — dotenv's startup banner goes to stdout, and the MCP server talks
//     JSON-RPC over stdout. One stray line there breaks the protocol.
//   path  — dotenv resolves .env against the cwd, but an MCP client spawns the
//     server from wherever it happens to be running. Anchor to this file.
require("dotenv").config({
  path: require("path").join(__dirname, ".env"),
  quiet: true,
});
const domain = process.env.SHOPIFY_STORE_DOMAIN;
const clientId = process.env.SHOPIFY_APP_CLIENT_ID;
const clientSecret = process.env.SHOPIFY_APP_CLIENT_SECRET;
let cachedToken = null, cachedTokenExpiresAt = 0;
async function getAdminAccessToken() {
if (cachedToken && Date.now() < cachedTokenExpiresAt) return cachedToken;
const res = await fetch(`https://${domain}/admin/oauth/access_token`, {
method: "POST",
headers: { "Content-Type": "application/json" },
body: JSON.stringify({
client_id: clientId,
client_secret: clientSecret,
grant_type: "client_credentials",
}),
});
const data = await res.json();
if (!data.access_token) throw new Error("Token exchange failed: " + JSON.stringify(data));
cachedToken = data.access_token;
cachedTokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
return cachedToken;
}
async function adminRequest(query, variables) {
const token = await getAdminAccessToken();
const res = await fetch(`https://${domain}/admin/api/2026-07/graphql.json`, {
method: "POST",
headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
body: JSON.stringify({ query, variables }),
});
const json = await res.json();
if (json.errors) throw new Error(JSON.stringify(json.errors));
return json.data;
}
module.exports = { adminRequest };