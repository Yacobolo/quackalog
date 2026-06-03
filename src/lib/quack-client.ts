import * as duckdb from "@duckdb/duckdb-wasm";
import duckdbWasmEh from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import duckdbWorkerEh from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";
import duckdbWasmMvp from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";
import duckdbWorkerMvp from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";

export type RemoteTable = {
  table_schema: string;
  table_name: string;
  table_type: string;
};

export type PreviewRow = Record<string, unknown>;

export type PreviewColumn = {
  name: string;
  type: string;
  nullable: boolean | null;
};

export type PreviewResult = {
  columns: string[];
  columnMetadata: PreviewColumn[];
  rows: PreviewRow[];
};

export type TableStorage = {
  estimated_size: number;
  column_count: number;
  row_count: number;
  has_primary_key: boolean;
};

export type ColumnStat = {
  column_name: string;
  column_type: string;
  min: string | null;
  max: string | null;
  approx_unique: number | null;
  avg: number | null;
  std: number | null;
  q25: string | null;
  q50: string | null;
  q75: string | null;
  count: number;
  null_percentage: number;
  contains_null?: boolean;
};

export type ColumnDetail = {
  column_name: string;
  ordinal_position: number;
  column_default: string | null;
  is_nullable: string;
  data_type: string;
  character_maximum_length: number | null;
};

export type TableDDL = {
  sql: string;
};

export type SnapshotRow = {
  snapshot_id: number;
  snapshot_time: string;
  author: string | null;
  commit_message: string | null;
};

export type DucklakeMetadataSection = {
  id: string;
  label: string;
  rows: PreviewRow[];
};

export type DucklakeMetadata = {
  table_id: number | null;
  sections: DucklakeMetadataSection[];
};

export const PREVIEW_LIMIT = 100;

const MANUAL_BUNDLES: duckdb.DuckDBBundles = {
  mvp: {
    mainModule: duckdbWasmMvp,
    mainWorker: duckdbWorkerMvp,
  },
  eh: {
    mainModule: duckdbWasmEh,
    mainWorker: duckdbWorkerEh,
  },
};

export class QuackClient {
  private constructor(
    private readonly conn: duckdb.AsyncDuckDBConnection,
  ) {}

  static async create(uri: string, token: string): Promise<QuackClient> {
    const db = await warmDuckDB();
    const conn = await db.connect();
    const scope = normalizeScope(uri);
    const attachUri = attachUriFromScope(scope);

    await loadQuackExtension(conn);
    await attachRemote(conn, scope, attachUri, token);

    return new QuackClient(conn);
  }

  async listTables(): Promise<RemoteTable[]> {
    let result: Awaited<ReturnType<duckdb.AsyncDuckDBConnection["query"]>>;

    try {
      result = await this.conn.query(`
        SELECT *
        FROM remote.query(${sqlString(`
          SELECT
            schema_name AS table_schema,
            table_name,
            CASE WHEN internal THEN 'INTERNAL' ELSE 'BASE TABLE' END AS table_type
          FROM duckdb_tables()
          ORDER BY schema_name, table_name
        `)});
      `);
    } catch {
      result = await this.conn.query(`
        SELECT *
        FROM remote.query(${sqlString(`
          SELECT table_schema, table_name, table_type
          FROM information_schema."tables"
          ORDER BY table_schema, table_name
        `)});
      `);
    }

    return rowsFromTable<RemoteTable>(result);
  }

  async previewTable(schema: string, table: string): Promise<PreviewResult> {
    const result = await this.previewRemoteCandidates([
      `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`,
      quoteIdentifier(table),
    ]);

    const columnMetadata = columnMetadataFromTable(result);

    return {
      columns: columnMetadata.map((column) => column.name),
      columnMetadata,
      rows: rowsFromTable<PreviewRow>(result),
    };
  }

  async close(): Promise<void> {
    await this.conn.close();
  }

  async getTableDDL(schema: string, table: string): Promise<TableDDL> {
    const [row] = await this.queryRemoteRows<TableDDL>(`
      SELECT sql
      FROM duckdb_tables()
      WHERE schema_name = ${sqlString(schema)}
        AND table_name = ${sqlString(table)}
        AND NOT internal
    `);

    return row ?? { sql: "" };
  }

  async getTableStats(schema: string, table: string): Promise<ColumnStat[]> {
    const meta = await this.getDucklakeMetaPrefix();
    const remoteSql = `
      SELECT
        c.column_name,
        c.data_type AS column_type,
        CAST(cs.min_value AS VARCHAR) AS min,
        CAST(cs.max_value AS VARCHAR) AS max,
        NULL AS approx_unique,
        NULL AS avg,
        NULL AS std,
        NULL AS q25,
        NULL AS q50,
        NULL AS q75,
        0 AS count,
        0 AS null_percentage,
        cs.contains_null
      FROM ${meta}.ducklake_table t
      JOIN ${meta}.ducklake_schema s ON t.schema_id = s.schema_id
      JOIN information_schema."columns" c ON c.table_schema = s.schema_name AND c.table_name = t.table_name
      JOIN ${meta}.ducklake_table_column_stats cs ON t.table_id = cs.table_id AND cs.column_id = c.ordinal_position
      WHERE t.end_snapshot IS NULL
        AND s.schema_name = ${sqlString(schema)}
        AND t.table_name = ${sqlString(table)}
      ORDER BY c.ordinal_position
    `;

    return this.queryRemoteRows<ColumnStat>(remoteSql);
  }

  async getColumnDetails(schema: string, table: string): Promise<ColumnDetail[]> {
    return this.queryRemoteRows<ColumnDetail>(`
      SELECT
        column_name,
        ordinal_position,
        column_default,
        is_nullable,
        data_type,
        character_maximum_length
      FROM information_schema."columns"
      WHERE table_schema = ${sqlString(schema)}
        AND table_name = ${sqlString(table)}
      ORDER BY ordinal_position
    `);
  }

  async getTableStorage(schema: string, table: string): Promise<TableStorage> {
    const [ddRow] = await this.queryRemoteRows<Pick<TableStorage, "estimated_size" | "column_count" | "has_primary_key">>(`
      SELECT
        COALESCE(estimated_size, 0) AS estimated_size,
        column_count,
        COALESCE(has_primary_key, false) AS has_primary_key
      FROM duckdb_tables()
      WHERE schema_name = ${sqlString(schema)}
        AND table_name = ${sqlString(table)}
        AND NOT internal
    `);

    const meta = await this.getDucklakeMetaPrefix();
    const [dlRow] = await this.queryRemoteRows<Pick<TableStorage, "row_count" | "estimated_size">>(`
      SELECT
        COALESCE(st.record_count, 0) AS row_count,
        COALESCE(st.file_size_bytes, 0) AS estimated_size
      FROM ${meta}.ducklake_table t
      JOIN ${meta}.ducklake_schema s ON t.schema_id = s.schema_id
      LEFT JOIN ${meta}.ducklake_table_stats st ON t.table_id = st.table_id
      WHERE t.end_snapshot IS NULL
        AND s.schema_name = ${sqlString(schema)}
        AND t.table_name = ${sqlString(table)}
    `);

    return {
      estimated_size: Number(dlRow?.estimated_size ?? ddRow?.estimated_size ?? 0),
      column_count: Number(ddRow?.column_count ?? 0),
      row_count: Number(dlRow?.row_count ?? 0),
      has_primary_key: ddRow?.has_primary_key ?? false,
    };
  }

  async getSnapshotHistory(schema: string, table: string): Promise<SnapshotRow[]> {
    const meta = await this.getDucklakeMetaPrefix();

    return this.queryRemoteRows<SnapshotRow>(`
      SELECT DISTINCT s.snapshot_id, s.snapshot_time, sc.author, sc.commit_message
      FROM ${meta}.ducklake_table t
      JOIN ${meta}.ducklake_schema sch ON t.schema_id = sch.schema_id
      CROSS JOIN ${meta}.ducklake_snapshot s
      LEFT JOIN ${meta}.ducklake_snapshot_changes sc ON s.snapshot_id = sc.snapshot_id
      WHERE t.end_snapshot IS NULL
        AND sch.schema_name = ${sqlString(schema)}
        AND t.table_name = ${sqlString(table)}
        AND s.snapshot_id >= COALESCE(t.begin_snapshot, 0)
      ORDER BY s.snapshot_id DESC
    `);
  }

  async getDucklakeMetadata(schema: string, table: string): Promise<DucklakeMetadata> {
    const meta = await this.getDucklakeMetaPrefix();
    const [tableRow] = await this.queryRemoteRows<{ table_id: number; begin_snapshot: number | null }>(`
      SELECT t.table_id, t.begin_snapshot
      FROM ${meta}.ducklake_table t
      JOIN ${meta}.ducklake_schema sch ON t.schema_id = sch.schema_id
      WHERE t.end_snapshot IS NULL
        AND sch.schema_name = ${sqlString(schema)}
        AND t.table_name = ${sqlString(table)}
    `);

    if (!tableRow) {
      return { table_id: null, sections: [] };
    }

    const tableId = Number(tableRow.table_id);
    const beginSnapshot = Number(tableRow.begin_snapshot ?? 0);
    const tableFilter = `table_id = ${tableId}`;
    const dataFileFilter = `data_file_id IN (SELECT data_file_id FROM ${meta}.ducklake_data_file WHERE table_id = ${tableId})`;
    const sortFilter = `sort_id IN (SELECT sort_id FROM ${meta}.ducklake_sort_info WHERE table_id = ${tableId})`;
    const snapshotFilter = `snapshot_id >= ${beginSnapshot}`;

    const specs = [
      metadataSpec("table", "Table", `${meta}.ducklake_table`, tableFilter),
      metadataSpec("columns", "Columns", `${meta}.ducklake_column`, tableFilter),
      metadataSpec("table-stats", "Table stats", `${meta}.ducklake_table_stats`, tableFilter),
      metadataSpec("column-stats", "Column stats", `${meta}.ducklake_table_column_stats`, tableFilter),
      metadataSpec("data-files", "Data files", `${meta}.ducklake_data_file`, tableFilter, "data_file_id"),
      metadataSpec("delete-files", "Delete files", `${meta}.ducklake_delete_file`, tableFilter, "delete_file_id"),
      metadataSpec("file-column-stats", "File column stats", `${meta}.ducklake_file_column_stats`, tableFilter, "data_file_id, column_id"),
      metadataSpec("partition-values", "Partition values", `${meta}.ducklake_file_partition_value`, dataFileFilter, "data_file_id, partition_key_index"),
      metadataSpec("partitions", "Partitions", `${meta}.ducklake_partition_info`, tableFilter, "partition_id"),
      metadataSpec("partition-columns", "Partition columns", `${meta}.ducklake_partition_column`, tableFilter, "partition_key_index"),
      metadataSpec("sort-info", "Sort info", `${meta}.ducklake_sort_info`, tableFilter, "sort_id"),
      metadataSpec("sort-expressions", "Sort expressions", `${meta}.ducklake_sort_expression`, sortFilter, "sort_id, sort_key_index"),
      metadataSpec("column-tags", "Column tags", `${meta}.ducklake_column_tag`, tableFilter, "column_id, key"),
      metadataSpec("schema-versions", "Schema versions", `${meta}.ducklake_schema_versions`, tableFilter, "begin_snapshot"),
      metadataSpec("snapshots", "Snapshots", `${meta}.ducklake_snapshot`, snapshotFilter, "snapshot_id DESC"),
      metadataSpec("snapshot-changes", "Snapshot changes", `${meta}.ducklake_snapshot_changes`, snapshotFilter, "snapshot_id DESC"),
      metadataSpec("inlined-data", "Inlined data tables", `${meta}.ducklake_inlined_data_tables`, tableFilter),
    ];

    const settled = await Promise.allSettled(
      specs.map(async (spec) => ({
        id: spec.id,
        label: spec.label,
        rows: await this.queryRemoteRows<PreviewRow>(`
          SELECT *
          FROM ${spec.source}
          WHERE ${spec.where}
          ORDER BY ${spec.orderBy}
          LIMIT 100
        `),
      })),
    );

    return {
      table_id: tableId,
      sections: settled
        .filter((result): result is PromiseFulfilledResult<DucklakeMetadataSection> => result.status === "fulfilled")
        .map((result) => result.value),
    };
  }

  private ducklakeMetaDb: string | null = null;
  private ducklakeMetaSchema: string | null = null;

  private async getDucklakeMetaDb(): Promise<string> {
    if (this.ducklakeMetaDb) return this.ducklakeMetaDb;

    const rows = await this.queryRemoteRows<{ database_name: string }>(`
      SELECT DISTINCT database_name
      FROM duckdb_tables()
      WHERE database_name LIKE '__ducklake_metadata_%'
    `);

    this.ducklakeMetaDb = rows[0]?.database_name ?? "__ducklake_metadata_unknown";
    return this.ducklakeMetaDb;
  }

  private async getDucklakeMetaSchema(): Promise<string> {
    if (this.ducklakeMetaSchema) return this.ducklakeMetaSchema;

    const metaDb = await this.getDucklakeMetaDb();
    const rows = await this.queryRemoteRows<{ schema_name: string }>(`
      SELECT DISTINCT schema_name
      FROM duckdb_tables()
      WHERE database_name = ${sqlString(metaDb)}
        AND table_name = 'ducklake_table'
      ORDER BY CASE WHEN schema_name = 'public' THEN 0 ELSE 1 END, schema_name
    `);

    this.ducklakeMetaSchema = rows[0]?.schema_name ?? "public";
    return this.ducklakeMetaSchema;
  }

  private async getDucklakeMetaPrefix(): Promise<string> {
    const metaDb = await this.getDucklakeMetaDb();
    const metaSchema = await this.getDucklakeMetaSchema();

    return `${quoteIdentifier(metaDb)}.${quoteIdentifier(metaSchema)}`;
  }

  private async queryRemoteRows<T extends Record<string, unknown>>(remoteSql: string): Promise<T[]> {
    const result = await this.conn.query(`
      SELECT *
      FROM remote.query(${sqlString(remoteSql)});
    `);

    return rowsFromTable<T>(result);
  }

  private async previewRemoteCandidates(
    candidates: string[],
  ): Promise<Awaited<ReturnType<duckdb.AsyncDuckDBConnection["query"]>>> {
    let firstError: unknown = null;
    const attempted = new Set<string>();

    for (const candidate of candidates) {
      if (attempted.has(candidate)) {
        continue;
      }

      attempted.add(candidate);

      try {
        return await this.previewRemoteSql(candidate);
      } catch (error) {
        firstError ??= error;

        const suggestedName = getSuggestedQualifiedName(error);

        if (suggestedName && !attempted.has(suggestedName)) {
          candidates.splice(attempted.size, 0, suggestedName);
        }
      }
    }

    throw firstError;
  }

  private previewRemoteSql(qualifiedName: string): Promise<Awaited<ReturnType<duckdb.AsyncDuckDBConnection["query"]>>> {
    const remoteSql = `
      SELECT *
      FROM ${qualifiedName}
      LIMIT ${PREVIEW_LIMIT}
    `;

    return this.conn.query(`
      SELECT *
      FROM remote.query(${sqlString(remoteSql)});
    `);
  }
}

function metadataSpec(id: string, label: string, source: string, where: string, orderBy = "1"): {
  id: string;
  label: string;
  orderBy: string;
  source: string;
  where: string;
} {
  return { id, label, orderBy, source, where };
}

let duckDBPromise: Promise<duckdb.AsyncDuckDB> | null = null;

export async function warmDuckDB(): Promise<duckdb.AsyncDuckDB> {
  duckDBPromise ??= instantiateDuckDB();

  return duckDBPromise;
}

async function instantiateDuckDB(): Promise<duckdb.AsyncDuckDB> {
  const bundle = await duckdb.selectBundle(MANUAL_BUNDLES);
  const worker = new Worker(bundle.mainWorker!);
  const logger = new duckdb.ConsoleLogger();
  const db = new duckdb.AsyncDuckDB(logger, worker);

  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);

  try {
    const conn = await db.connect();
    await loadQuackExtension(conn);
    await conn.close();
  } catch {
    // A connection attempt will surface extension-loading failures with endpoint context.
  }

  return db;
}

export function tableKey(table: RemoteTable): string {
  return `${table.table_schema}.${table.table_name}`;
}

export function formatError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  if (/cors|failed to fetch|networkerror|load failed/i.test(message)) {
    return `${message} Check that the Quack endpoint allows this browser origin with CORS.`;
  }

  return message;
}

export function stringifyCell(value: unknown): string {
  if (value === null || value === undefined) {
    return "NULL";
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof Uint8Array) {
    return `[${value.byteLength} bytes]`;
  }

  if (typeof value === "object") {
    const stringValue = String(value);

    if (stringValue !== "[object Object]") {
      return stringValue;
    }

    return JSON.stringify(value);
  }

  return String(value);
}

function normalizeScope(uri: string): string {
  return uri.replace(/^quack:quack:/, "quack:");
}

function attachUriFromScope(scope: string): string {
  return scope.startsWith("quack:quack:") ? scope : `quack:${scope}`;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function rowsFromTable<T extends Record<string, unknown>>(table: { toArray(): unknown[] }): T[] {
  return table.toArray().map((row) => {
    if (row && typeof row === "object" && "toJSON" in row && typeof row.toJSON === "function") {
      return row.toJSON() as T;
    }

    return row as T;
  });
}

function columnMetadataFromTable(table: {
  schema: { fields: Array<{ name: string; type?: unknown; nullable?: unknown }> };
}): PreviewColumn[] {
  return table.schema.fields.map((field) => ({
    name: field.name,
    nullable: typeof field.nullable === "boolean" ? field.nullable : null,
    type: field.type ? String(field.type) : "unknown",
  }));
}

function getSuggestedQualifiedName(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/Did you mean "([^"]+)"/i);

  if (!match) {
    return null;
  }

  const parts = match[1].split(".");

  if (parts.length < 2 || parts.some((part) => part.length === 0)) {
    return null;
  }

  return parts.map(quoteIdentifier).join(".");
}

async function loadQuackExtension(conn: duckdb.AsyncDuckDBConnection): Promise<void> {
  try {
    await conn.query("INSTALL quack;");
  } catch {
    // The extension may already be bundled or installed in this DuckDB-Wasm build.
  }

  await conn.query("LOAD quack;");
}

async function attachRemote(
  conn: duckdb.AsyncDuckDBConnection,
  scope: string,
  attachUri: string,
  token: string,
): Promise<void> {
  try {
    await conn.query(`
      CREATE OR REPLACE SECRET quack_credentials (
        TYPE quack,
        SCOPE ${sqlString(scope)},
        TOKEN ${sqlString(token)}
      );
    `);
    await conn.query(`ATTACH ${sqlString(attachUri)} AS remote (TYPE quack);`);
  } catch (secretError) {
    try {
      await conn.query(`
        ATTACH ${sqlString(scope)} AS remote (
          TYPE quack,
          TOKEN ${sqlString(token)}
        );
      `);
    } catch (attachError) {
      throw new Error(`${formatError(secretError)} Fallback attach failed: ${formatError(attachError)}`);
    }
  }
}
