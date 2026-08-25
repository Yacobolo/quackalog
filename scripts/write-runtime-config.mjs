#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildRuntimeConfig } from "./runtime-config.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");
const options = parseArgs(process.argv.slice(2));
const endpoint = (options.endpoint || process.env.VITE_QUACK_URI || process.env.QUACK_URL || "").trim();
const name = options.name?.trim() || "remote catalog";
const config = buildRuntimeConfig({ endpoint, name });
const publicDir = path.join(rootDir, "public");

await mkdir(publicDir, { recursive: true });
await writeFile(path.join(publicDir, "quackalog.config.json"), `${JSON.stringify(config, null, 2)}\n`);

if (config.catalogs.length === 0) {
  console.log("Wrote public/quackalog.config.json without a default catalog; users can add one in the app.");
} else {
  console.log(`Wrote public/quackalog.config.json for ${name}.`);
}

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
