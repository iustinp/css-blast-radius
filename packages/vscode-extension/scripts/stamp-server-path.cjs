// Records where this repo's server CLI is, so a .vsix installed elsewhere can
// still start it (the installed extension no longer sits next to the backend).
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const cli = path.resolve(__dirname, "../../backend/dist/cli.js");
if (!fs.existsSync(cli)) {
  console.error(`Server not built: ${cli} is missing. Run "npm run build" in the repository root first.`);
  process.exit(1);
}
fs.writeFileSync(path.resolve(__dirname, "../dist/server-path.json"), JSON.stringify({ cli }, null, 2) + "\n");
console.log(`Packaged extension will start the server from ${cli}`);
