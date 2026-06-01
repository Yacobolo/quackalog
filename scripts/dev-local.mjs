#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");
const options = parseArgs(process.argv.slice(2));
const env = { ...readDotEnv(await readOptional(path.join(rootDir, ".env"))), ...process.env };
const appHost = options.host || env.QUACKALOG_APP_HOST || "127.0.0.1";
const appPort = options.port || env.QUACKALOG_APP_PORT || "5173";
const appUrl = `http://${appHost}:${appPort}/`;
const quackCommand = options.quackCommand || env.QUACKALOG_QUACK_COMMAND || "";
const seedQuackUri = options.seedQuackUri || env.QUACKALOG_SEED_QUACK_URI || "quack:127.0.0.1:9494";
const seedToken = options.seedToken || env.QUACKALOG_SEED_TOKEN || env.VITE_QUACK_TOKEN || env.token || "quackalog-dev-token";
const catalogs = collectCatalogs(options, env, seedQuackUri);

await mkdir(path.join(rootDir, "public"), { recursive: true });

if (seedQuackUri) {
  await run("node", [
    "scripts/seed-ducklake.mjs",
    "--quack-uri",
    seedQuackUri,
    "--app-url",
    appUrl,
  ]);
}

await writeRuntimeConfig(catalogs, options.activeCatalog || env.QUACKALOG_ACTIVE_CATALOG || catalogs[0]?.name || "");

const children = [];

if (quackCommand) {
  children.push(spawnShell(quackCommand, "quack"));
} else if (seedQuackUri) {
  children.push(spawnProcess("node", [
    "scripts/serve-local-quack.mjs",
    "--uri",
    seedQuackUri,
    "--token",
    seedToken,
  ], "quack"));
} else {
  console.log("No QUACKALOG_QUACK_COMMAND set; assuming Quack endpoints are already running.");
}

children.push(spawnProcess("npm", ["run", "dev", "--", "--host", appHost, "--port", appPort], "vite", {
  ...process.env,
  VITE_QUACK_TOKEN: env.VITE_QUACK_TOKEN || env.token || seedToken,
}));

const stop = () => {
  for (const child of children) {
    child.kill("SIGTERM");
  }
};

process.on("SIGINT", () => {
  stop();
  process.exit(130);
});
process.on("SIGTERM", () => {
  stop();
  process.exit(143);
});

function collectCatalogs(options, env, seedUri) {
  const catalogs = [];
  const primaryUri = options.remoteUri || env.VITE_QUACK_URI || env.uri || "";

  if (primaryUri) {
    catalogs.push({
      name: options.remoteName || env.QUACKALOG_REMOTE_NAME || "remote dev",
      endpoint: primaryUri,
    });
  }

  if (seedUri) {
    catalogs.push({
      name: options.seedName || env.QUACKALOG_SEED_NAME || "local seed",
      endpoint: seedUri,
    });
  }

  for (const catalog of options.catalogs) {
    catalogs.push(catalog);
  }

  return dedupeCatalogs(catalogs);
}

function dedupeCatalogs(catalogs) {
  const byEndpoint = new Map();

  for (const catalog of catalogs) {
    const endpoint = catalog.endpoint.trim();

    if (!endpoint) continue;

    byEndpoint.set(endpoint, {
      name: catalog.name.trim() || endpoint.replace(/^quack:/, "").replace(/\..*$/, "") || "catalog",
      endpoint,
    });
  }

  return Array.from(byEndpoint.values());
}

async function writeRuntimeConfig(catalogs, activeCatalog) {
  const configPath = path.join(rootDir, "public", "quackalog.config.json");
  const config = {
    activeCatalog,
    catalogs,
  };

  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`Wrote ${path.relative(rootDir, configPath)} with ${catalogs.length} ${catalogs.length === 1 ? "catalog" : "catalogs"}.`);
}

function spawnProcess(command, args, label, childEnv = process.env) {
  const child = spawn(command, args, {
    cwd: rootDir,
    env: childEnv,
    stdio: "inherit",
  });

  child.on("exit", (code) => {
    if (code && code !== 130 && code !== 143) {
      console.error(`${label} exited with code ${code}.`);
    }
  });

  return child;
}

function spawnShell(command, label) {
  const child = spawn(command, {
    cwd: rootDir,
    env: process.env,
    shell: true,
    stdio: "inherit",
  });

  child.on("exit", (code) => {
    if (code && code !== 130 && code !== 143) {
      console.error(`${label} exited with code ${code}.`);
    }
  });

  return child;
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      env: process.env,
      stdio: "inherit",
    });

    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
      }
    });
  });
}

async function readOptional(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

function readDotEnv(contents) {
  const values = {};

  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const index = trimmed.indexOf("=");

    if (index === -1) {
      continue;
    }

    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    values[key] = value;
  }

  return values;
}

function parseArgs(args) {
  const parsed = {
    activeCatalog: "",
    catalogs: [],
    host: "",
    port: "",
    quackCommand: "",
    remoteName: "",
    remoteUri: "",
    seedName: "",
    seedQuackUri: "",
    seedToken: "",
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--catalog") {
      const value = args[index + 1] ?? "";
      const separator = value.indexOf("=");
      if (separator > 0) {
        parsed.catalogs.push({
          name: value.slice(0, separator),
          endpoint: value.slice(separator + 1),
        });
      }
      index += 1;
      continue;
    }

    const optionMap = {
      "--active-catalog": "activeCatalog",
      "--host": "host",
      "--port": "port",
      "--quack-command": "quackCommand",
      "--remote-name": "remoteName",
      "--remote-uri": "remoteUri",
      "--seed-name": "seedName",
      "--seed-quack-uri": "seedQuackUri",
      "--seed-token": "seedToken",
    };

    const key = optionMap[arg];

    if (key) {
      parsed[key] = args[index + 1] ?? "";
      index += 1;
    }
  }

  return parsed;
}
