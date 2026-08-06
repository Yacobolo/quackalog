#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");
const options = parseArgs(process.argv.slice(2));
const endpoint = (options.endpoint || process.env.VITE_QUACK_URI || process.env.QUACK_URL || "").trim();

if (!endpoint) {
  throw new Error("A remote Quack endpoint is required. Set VITE_QUACK_URI or QUACK_URL.");
}

const name = options.name?.trim() || "remote catalog";
const config = {
  activeCatalog: name,
  catalogs: [{ name, endpoint }],
};
const publicDir = path.join(rootDir, "public");

await mkdir(publicDir, { recursive: true });
await writeFile(path.join(publicDir, "quackalog.config.json"), `${JSON.stringify(config, null, 2)}\n`);
console.log(`Wrote public/quackalog.config.json for ${name}.`);

function parseArgs(args) {
  const parsed = { endpoint: "", name: "" };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--endpoint") {
      parsed.endpoint = args[index + 1] ?? "";
      index += 1;
    } else if (arg === "--name") {
      parsed.name = args[index + 1] ?? "";
      index += 1;
    }
  }

  return parsed;
}
