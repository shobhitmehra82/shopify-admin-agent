// Runs the chat backend and the Vite dev server together.
//
//   npm run chat   → UI on http://localhost:5173, API on :8787
//
// Both are plain child processes; killing this script kills both.

const { spawn } = require("child_process");
const path = require("path");

const root = path.join(__dirname, "..");

const processes = [
  { label: "api", command: process.execPath, args: [path.join(root, "server", "index.js")], cwd: root },
  { label: "web", command: "npm", args: ["run", "dev", "--silent"], cwd: path.join(root, "web") },
];

const children = processes.map(({ label, command, args, cwd }) => {
  const child = spawn(command, args, {
    cwd,
    // Prefix every line so interleaved output stays readable.
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });

  const prefix = (stream, target) => {
    let buffer = "";
    stream.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) target.write(`[${label}] ${line}\n`);
    });
  };
  prefix(child.stdout, process.stdout);
  prefix(child.stderr, process.stderr);

  child.on("exit", (code) => {
    process.stdout.write(`[${label}] exited (${code})\n`);
    shutdown();
  });

  return child;
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
  // Give each side a moment to close its own children (the MCP server, esbuild).
  setTimeout(() => process.exit(0), 400);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log("Starting chat backend + UI…  (Ctrl+C to stop)\n");
