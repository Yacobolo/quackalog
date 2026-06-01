#!/usr/bin/env node
import { DuckDBInstance } from "@duckdb/node-api";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");
const options = parseArgs(process.argv.slice(2));
const uri = options.uri || process.env.QUACKALOG_SEED_QUACK_URI || "quack:127.0.0.1:9494";
const token = options.token || process.env.QUACKALOG_SEED_TOKEN || "quackalog-dev-token";
const seedDir = path.resolve(options.seedDir || process.env.QUACKALOG_SEED_DIR || path.join(rootDir, ".quackalog-seed"));
const catalogPath = path.join(seedDir, "catalog", "quackalog_demo.ducklake");

const instance = await DuckDBInstance.create(":memory:");
const connection = await instance.connect();
let stopped = false;

try {
  await runMany([
    "INSTALL ducklake",
    "LOAD ducklake",
    "INSTALL quack",
    "LOAD quack",
    `
      ATTACH 'ducklake:${sqlPath(catalogPath)}' AS quackalog_seed
    `,
    `
      CALL quack_identify(
        name => 'quackalog local seed',
        provider => 'local',
        region => 'dev',
        meta => '{"catalog":"quackalog_seed"}'
      )
    `,
  ]);

  const reader = await connection.runAndReadAll(
    `CALL quack_serve(${sqlString(uri)}, token => ${sqlString(token)})`,
  );
  const [server] = reader.getRowObjectsJS();

  console.log(`Quack local seed is listening:
  uri:   ${server?.listen_uri ?? uri}
  http:  ${server?.listen_url ?? "unknown"}
  token: ${server?.auth_token ?? token}
  data:  ${catalogPath}`);

  await waitForStop();
} finally {
  if (!stopped) {
    await stopServer();
  }
  connection.disconnectSync();
}

async function runMany(statements) {
  for (const statement of statements) {
    await connection.run(statement);
  }
}

function waitForStop() {
  return new Promise((resolve) => {
    const keepalive = setInterval(() => {}, 60_000);
    const stop = () => {
      clearInterval(keepalive);
      resolve();
    };

    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

async function stopServer() {
  stopped = true;

  try {
    await connection.run(`CALL quack_stop(${sqlString(uri)})`);
  } catch {
    // The server may already be stopped or may not have finished starting.
  }
}

function parseArgs(args) {
  const parsed = {
    seedDir: "",
    token: "",
    uri: "",
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const optionMap = {
      "--seed-dir": "seedDir",
      "--token": "token",
      "--uri": "uri",
    };
    const key = optionMap[arg];

    if (key) {
      parsed[key] = args[index + 1] ?? "";
      index += 1;
    }
  }

  return parsed;
}

function sqlPath(value) {
  return value.replaceAll("'", "''");
}

function sqlString(value) {
  return `'${value.replaceAll("'", "''")}'`;
}
