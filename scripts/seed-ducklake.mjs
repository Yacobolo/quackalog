#!/usr/bin/env node
import { DuckDBInstance } from "@duckdb/node-api";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");
const options = parseArgs(process.argv.slice(2));
const seedDir = path.resolve(options.seedDir || path.join(rootDir, ".quackalog-seed"));
const quackUri = options.quackUri || process.env.QUACKALOG_SEED_QUACK_URI || "";
const appUrl = options.appUrl || process.env.QUACKALOG_APP_URL || "http://127.0.0.1:5173/";
const catalogDir = path.join(seedDir, "catalog");
const dataDir = path.join(seedDir, "data");
const catalogPath = path.join(catalogDir, "quackalog_demo.ducklake");
const summaryPath = path.join(seedDir, "summary.csv");

assertSafeSeedDir(seedDir);
await rm(seedDir, { recursive: true, force: true });
await mkdir(catalogDir, { recursive: true });
await mkdir(dataDir, { recursive: true });

const instance = await DuckDBInstance.create(":memory:");
const connection = await instance.connect();

try {
  await runMany(connection, [
    "INSTALL ducklake",
    "LOAD ducklake",
    `
      ATTACH 'ducklake:${sqlPath(catalogPath)}' AS quackalog_seed (
        DATA_PATH '${sqlPath(`${dataDir}/`)}',
        DATA_INLINING_ROW_LIMIT 10
      )
    `,
    "USE quackalog_seed",
    "CREATE SCHEMA demo",
    `
      CREATE TABLE demo.rich_orders (
        order_id INTEGER,
        customer_id INTEGER,
        region VARCHAR,
        status VARCHAR,
        amount DECIMAL(12,2),
        created_at TIMESTAMP,
        payload STRUCT(channel VARCHAR, campaign VARCHAR)
      )
    `,
    "COMMENT ON TABLE demo.rich_orders IS 'Seed table with DuckLake metadata coverage'",
    "COMMENT ON COLUMN demo.rich_orders.customer_id IS 'Customer identifier'",
    "CREATE MACRO demo.order_day(ts) AS date_trunc('day', ts)",
    `
      CREATE VIEW demo.rich_orders_open AS
      SELECT *
      FROM demo.rich_orders
      WHERE status <> 'cancelled'
    `,
    "ALTER TABLE demo.rich_orders SET PARTITIONED BY (region, month(created_at))",
    "ALTER TABLE demo.rich_orders SET SORTED BY (created_at ASC NULLS LAST, customer_id DESC)",
    `
      INSERT INTO demo.rich_orders
      SELECT
        i AS order_id,
        100 + i AS customer_id,
        CASE i % 4 WHEN 0 THEN 'eu' WHEN 1 THEN 'us' WHEN 2 THEN 'apac' ELSE 'latam' END AS region,
        CASE i % 5 WHEN 0 THEN 'cancelled' WHEN 1 THEN 'new' WHEN 2 THEN 'paid' WHEN 3 THEN 'shipped' ELSE 'returned' END AS status,
        CAST(10 + i * 7.5 AS DECIMAL(12,2)) AS amount,
        TIMESTAMP '2026-01-01 08:00:00' + (i || ' days')::INTERVAL AS created_at,
        {
          'channel': CASE i % 3 WHEN 0 THEN 'web' WHEN 1 THEN 'partner' ELSE 'store' END,
          'campaign': CASE WHEN i < 15 THEN 'winter' ELSE 'spring' END
        } AS payload
      FROM range(1, 31) t(i)
    `,
    "ALTER TABLE demo.rich_orders ADD COLUMN priority VARCHAR DEFAULT 'normal'",
    `
      INSERT INTO demo.rich_orders (order_id, customer_id, region, status, amount, created_at, payload, priority) VALUES
        (101, 901, 'eu', 'manual_review', 999.00, TIMESTAMP '2026-03-01 12:00:00', {'channel': 'sales', 'campaign': 'spring'}, 'high'),
        (102, 902, 'us', 'manual_review', 199.00, TIMESTAMP '2026-03-02 12:00:00', {'channel': 'sales', 'campaign': 'spring'}, 'high')
    `,
    `
      UPDATE demo.rich_orders
      SET status = 'shipped', priority = 'high'
      WHERE order_id IN (1, 2)
    `,
    "DELETE FROM demo.rich_orders WHERE order_id IN (3, 4, 5)",
    "CALL ducklake_flush_inlined_data('quackalog_seed', schema_name => 'demo', table_name => 'rich_orders')",
    "CALL ducklake_rewrite_data_files('quackalog_seed', 'rich_orders', schema => 'demo', delete_threshold => 0.1)",
    "ALTER TABLE demo.rich_orders DROP COLUMN priority",
    "ALTER TABLE demo.rich_orders ADD COLUMN lifecycle VARCHAR DEFAULT 'active'",
    `
      INSERT INTO demo.rich_orders (order_id, customer_id, region, status, amount, created_at, payload, lifecycle) VALUES
        (201, 777, 'eu', 'new', 70.00, TIMESTAMP '2026-04-01 14:00:00', {'channel': 'web', 'campaign': 'summer'}, 'active')
    `,
    "DELETE FROM demo.rich_orders WHERE order_id = 6",
    "CALL ducklake_flush_inlined_data('quackalog_seed', schema_name => 'demo', table_name => 'rich_orders')",
  ]);

  const summaryRows = await rows(connection, `
    SELECT 'ducklake_column' AS table_name, count(*) AS rows FROM __ducklake_metadata_quackalog_seed.main.ducklake_column UNION ALL
    SELECT 'ducklake_column_tag', count(*) FROM __ducklake_metadata_quackalog_seed.main.ducklake_column_tag UNION ALL
    SELECT 'ducklake_data_file', count(*) FROM __ducklake_metadata_quackalog_seed.main.ducklake_data_file UNION ALL
    SELECT 'ducklake_delete_file', count(*) FROM __ducklake_metadata_quackalog_seed.main.ducklake_delete_file UNION ALL
    SELECT 'ducklake_file_column_stats', count(*) FROM __ducklake_metadata_quackalog_seed.main.ducklake_file_column_stats UNION ALL
    SELECT 'ducklake_file_partition_value', count(*) FROM __ducklake_metadata_quackalog_seed.main.ducklake_file_partition_value UNION ALL
    SELECT 'ducklake_files_scheduled_for_deletion', count(*) FROM __ducklake_metadata_quackalog_seed.main.ducklake_files_scheduled_for_deletion UNION ALL
    SELECT 'ducklake_macro', count(*) FROM __ducklake_metadata_quackalog_seed.main.ducklake_macro UNION ALL
    SELECT 'ducklake_macro_impl', count(*) FROM __ducklake_metadata_quackalog_seed.main.ducklake_macro_impl UNION ALL
    SELECT 'ducklake_macro_parameters', count(*) FROM __ducklake_metadata_quackalog_seed.main.ducklake_macro_parameters UNION ALL
    SELECT 'ducklake_partition_column', count(*) FROM __ducklake_metadata_quackalog_seed.main.ducklake_partition_column UNION ALL
    SELECT 'ducklake_partition_info', count(*) FROM __ducklake_metadata_quackalog_seed.main.ducklake_partition_info UNION ALL
    SELECT 'ducklake_schema_versions', count(*) FROM __ducklake_metadata_quackalog_seed.main.ducklake_schema_versions UNION ALL
    SELECT 'ducklake_snapshot', count(*) FROM __ducklake_metadata_quackalog_seed.main.ducklake_snapshot UNION ALL
    SELECT 'ducklake_snapshot_changes', count(*) FROM __ducklake_metadata_quackalog_seed.main.ducklake_snapshot_changes UNION ALL
    SELECT 'ducklake_sort_expression', count(*) FROM __ducklake_metadata_quackalog_seed.main.ducklake_sort_expression UNION ALL
    SELECT 'ducklake_sort_info', count(*) FROM __ducklake_metadata_quackalog_seed.main.ducklake_sort_info UNION ALL
    SELECT 'ducklake_table', count(*) FROM __ducklake_metadata_quackalog_seed.main.ducklake_table UNION ALL
    SELECT 'ducklake_table_column_stats', count(*) FROM __ducklake_metadata_quackalog_seed.main.ducklake_table_column_stats UNION ALL
    SELECT 'ducklake_table_stats', count(*) FROM __ducklake_metadata_quackalog_seed.main.ducklake_table_stats UNION ALL
    SELECT 'ducklake_tag', count(*) FROM __ducklake_metadata_quackalog_seed.main.ducklake_tag UNION ALL
    SELECT 'ducklake_view', count(*) FROM __ducklake_metadata_quackalog_seed.main.ducklake_view
    ORDER BY table_name
  `);
  const currentRows = await rows(connection, "SELECT count(*) AS current_rows FROM demo.rich_orders");
  const loadUrl = quackUri ? createCatalogLoadUrl(appUrl, quackUri, "quackalog seed") : "";

  await writeFile(summaryPath, toCsv(summaryRows));

  console.log(`Seeded DuckLake fixture:
  catalog: ${catalogPath}
  data:    ${dataDir}/
  table:   demo.rich_orders
  view:    demo.rich_orders_open
  rows:    ${currentRows[0]?.current_rows ?? "unknown"}
  summary: ${summaryPath}

To inspect locally:
  duckdb -c "LOAD ducklake; ATTACH 'ducklake:${catalogPath}' AS quackalog_seed; FROM quackalog_seed.demo.rich_orders;"

To browse from Quackalog:
  expose this DuckLake through a non-production Quack endpoint, then add that Quack URI as a catalog connection.${loadUrl ? `\n\nLoad into Quackalog:\n  ${loadUrl}` : "\n\nTip:\n  pass --quack-uri quack:your-dev-host:443 to print a one-click catalog load URL."}`);
} finally {
  connection.disconnectSync();
}

function parseArgs(args) {
  const parsed = {
    appUrl: "",
    quackUri: "",
    seedDir: "",
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--quack-uri") {
      parsed.quackUri = args[index + 1] ?? "";
      index += 1;
      continue;
    }

    if (arg === "--app-url") {
      parsed.appUrl = args[index + 1] ?? "";
      index += 1;
      continue;
    }

    if (!arg.startsWith("--") && !parsed.seedDir) {
      parsed.seedDir = arg;
    }
  }

  return parsed;
}

function createCatalogLoadUrl(baseUrl, uri, name) {
  const url = new URL(baseUrl);
  url.searchParams.set("catalog_uri", uri);
  url.searchParams.set("catalog_name", name);
  url.searchParams.set("catalog_connect", "1");
  return url.toString();
}

function assertSafeSeedDir(dir) {
  const resolved = path.resolve(dir);
  const forbidden = new Set([
    rootDir,
    path.dirname(rootDir),
    process.env.HOME,
    "/",
  ]);

  if (forbidden.has(resolved)) {
    throw new Error(`Refusing to clear unsafe seed directory: ${resolved}`);
  }
}

async function runMany(connection, statements) {
  for (const statement of statements) {
    await connection.run(statement);
  }
}

async function rows(connection, sql) {
  const reader = await connection.runAndReadAll(sql);
  return reader.getRowObjectsJS();
}

function toCsv(rows) {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  return [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(",")),
  ].join("\n") + "\n";
}

function csvCell(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function sqlPath(value) {
  return value.replaceAll("'", "''");
}
