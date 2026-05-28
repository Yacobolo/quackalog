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

export type PreviewResult = {
  columns: string[];
  rows: PreviewRow[];
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
    private readonly db: duckdb.AsyncDuckDB,
    private readonly conn: duckdb.AsyncDuckDBConnection,
  ) {}

  static async create(uri: string, token: string): Promise<QuackClient> {
    const bundle = await duckdb.selectBundle(MANUAL_BUNDLES);
    const worker = new Worker(bundle.mainWorker!);
    const logger = new duckdb.ConsoleLogger();
    const db = new duckdb.AsyncDuckDB(logger, worker);

    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);

    const conn = await db.connect();
    const scope = normalizeScope(uri);
    const attachUri = attachUriFromScope(scope);

    await loadQuackExtension(conn);
    await attachRemote(conn, scope, attachUri, token);

    return new QuackClient(db, conn);
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

    return {
      columns: columnsFromTable(result),
      rows: rowsFromTable<PreviewRow>(result),
    };
  }

  async close(): Promise<void> {
    await this.conn.close();
    await this.db.terminate();
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

function columnsFromTable(table: { schema: { fields: Array<{ name: string }> } }): string[] {
  return table.schema.fields.map((field) => field.name);
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
