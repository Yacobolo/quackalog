import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  type ColumnDef,
  type SortingState,
  type VisibilityState,
  useReactTable,
} from "@tanstack/react-table";
import {
  AlertTriangle,
  ArrowDownUp,
  CheckCircle2,
  ChevronDown,
  Columns3,
  Database,
  KeyRound,
  Loader2,
  Monitor,
  Moon,
  Search,
  Server,
  Sun,
  Table2,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip } from "@/components/ui/tooltip";
import {
  formatError,
  PREVIEW_LIMIT,
  type PreviewResult,
  type PreviewRow,
  QuackClient,
  type RemoteTable,
  stringifyCell,
  tableKey,
} from "@/lib/quack-client";
import { readStoredBoolean, readStoredString, writeStoredBoolean, writeStoredString } from "@/lib/storage";
import { cn } from "@/lib/utils";

type ConnectionState = "idle" | "connecting" | "ready" | "error";
type MessageKind = "info" | "success" | "warning" | "error";
type ThemeMode = "light" | "dark" | "system";

type PreviewState = {
  isLoading: boolean;
  table: RemoteTable | null;
  result: PreviewResult | null;
};

type Message = {
  kind: MessageKind;
  text: string;
};

const DEFAULT_URI = import.meta.env.VITE_QUACK_URI || "";
const DEV_TOKEN = import.meta.env.DEV ? import.meta.env.VITE_QUACK_TOKEN || "" : "";
const ENDPOINT_KEY = "quackalog.endpoint";
const HIDE_SYSTEM_KEY = "quackalog.hide-system-schemas";
const THEME_KEY = "quackalog.theme";
const SYSTEM_SCHEMAS = new Set(["information_schema", "pg_catalog"]);

export function App(): React.ReactElement {
  const clientRef = useRef<QuackClient | null>(null);
  const previewRunRef = useRef(0);
  const [endpoint, setEndpoint] = useState(() => readStoredString(ENDPOINT_KEY, DEFAULT_URI));
  const [theme, setTheme] = useState<ThemeMode>(() => parseTheme(readStoredString(THEME_KEY, "system")));
  const [token, setToken] = useState("");
  const [connectionState, setConnectionState] = useState<ConnectionState>("idle");
  const [message, setMessage] = useState<Message>({
    kind: "info",
    text: "Connect to inspect a remote DuckDB catalog from this static app.",
  });
  const [tables, setTables] = useState<RemoteTable[]>([]);
  const [selectedTableKey, setSelectedTableKey] = useState("");
  const [catalogSearch, setCatalogSearch] = useState("");
  const [hideSystemSchemas, setHideSystemSchemas] = useState(() => readStoredBoolean(HIDE_SYSTEM_KEY, true));
  const [preview, setPreview] = useState<PreviewState>({
    isLoading: false,
    table: null,
    result: null,
  });

  useEffect(() => {
    writeStoredString(ENDPOINT_KEY, endpoint.trim());
  }, [endpoint]);

  useEffect(() => {
    writeStoredBoolean(HIDE_SYSTEM_KEY, hideSystemSchemas);
  }, [hideSystemSchemas]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const applyTheme = () => {
      const resolvedTheme = resolveTheme(theme);
      document.documentElement.classList.toggle("dark", resolvedTheme === "dark");
      document.documentElement.dataset.colorMode = resolvedTheme;
      document.documentElement.dataset.lightTheme = "light";
      document.documentElement.dataset.darkTheme = "dark";
      document.documentElement.style.colorScheme = resolvedTheme;
    };

    writeStoredString(THEME_KEY, theme);
    applyTheme();

    if (theme !== "system") {
      return;
    }

    media.addEventListener("change", applyTheme);

    return () => media.removeEventListener("change", applyTheme);
  }, [theme]);

  useEffect(() => {
    return () => {
      void clientRef.current?.close();
    };
  }, []);

  const visibleTables = useMemo(() => {
    const query = catalogSearch.trim().toLowerCase();

    return tables.filter((table) => {
      if (hideSystemSchemas && SYSTEM_SCHEMAS.has(table.table_schema)) {
        return false;
      }

      if (!query) {
        return true;
      }

      return `${table.table_schema}.${table.table_name}`.toLowerCase().includes(query);
    });
  }, [catalogSearch, hideSystemSchemas, tables]);

  const schemaGroups = useMemo(() => groupTablesBySchema(visibleTables), [visibleTables]);
  const status = getStatusMeta(connectionState);
  const themeMeta = getThemeMeta(theme);

  async function handleConnect(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    const uri = endpoint.trim();
    const secret = token.trim() || DEV_TOKEN;

    if (!uri) {
      setMessage({ kind: "error", text: "Enter a Quack URI before connecting." });
      return;
    }

    if (!secret) {
      setMessage({ kind: "error", text: "Enter a token before connecting." });
      return;
    }

    let nextClient: QuackClient | null = null;

    setConnectionState("connecting");
    setMessage({ kind: "info", text: "Starting DuckDB-Wasm and attaching the remote catalog." });
    setTables([]);
    setSelectedTableKey("");
    setPreview({ isLoading: false, table: null, result: null });

    try {
      if (clientRef.current) {
        await clientRef.current.close();
        clientRef.current = null;
      }

      nextClient = await QuackClient.create(uri, secret);
      const remoteTables = await nextClient.listTables();

      clientRef.current = nextClient;
      nextClient = null;
      setTables(remoteTables);
      setConnectionState("ready");
      setMessage({
        kind: "success",
        text: `Connected. Loaded ${remoteTables.length} table${remoteTables.length === 1 ? "" : "s"}.`,
      });
    } catch (error) {
      if (nextClient) {
        await nextClient.close();
      }

      setConnectionState("error");
      setMessage({ kind: "error", text: formatError(error) });
    }
  }

  async function handlePreviewTable(table: RemoteTable): Promise<void> {
    const client = clientRef.current;

    if (!client) {
      setMessage({ kind: "error", text: "Connect before previewing a table." });
      return;
    }

    const runId = previewRunRef.current + 1;
    previewRunRef.current = runId;
    setSelectedTableKey(tableKey(table));
    setPreview({ isLoading: true, table, result: null });
    setMessage({ kind: "info", text: `Loading ${table.table_schema}.${table.table_name}.` });

    try {
      const result = await client.previewTable(table.table_schema, table.table_name);

      if (previewRunRef.current !== runId) {
        return;
      }

      setPreview({ isLoading: false, table, result });
      setMessage({
        kind: "success",
        text: `Showing up to ${PREVIEW_LIMIT} rows from ${table.table_schema}.${table.table_name}.`,
      });
    } catch (error) {
      if (previewRunRef.current !== runId) {
        return;
      }

      setPreview({ isLoading: false, table, result: null });
      setMessage({ kind: "error", text: formatError(error) });
    }
  }

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex min-h-screen w-full max-w-[1800px] flex-col px-3 py-3 sm:px-5 sm:py-5">
        <header className="grid gap-4 border-b border-border pb-4 lg:grid-cols-[minmax(220px,340px)_1fr]">
          <section className="flex items-end justify-between gap-4 lg:block">
            <div>
              <div className="mb-3 inline-flex items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1 text-xs font-semibold text-muted-foreground">
                <Database className="size-3.5" />
                Static DuckDB-Wasm catalog
              </div>
              <h1 className="text-3xl font-black leading-none tracking-normal text-foreground sm:text-5xl">Quackalog</h1>
            </div>
            <div className="flex items-center gap-2 lg:mt-5">
              <Badge variant={status.badgeVariant}>
                <status.Icon className={cn("mr-1 size-3.5", connectionState === "connecting" && "animate-spin")} />
                {status.label}
              </Badge>
              <Button
                aria-label={`Theme: ${themeMeta.label}`}
                size="icon"
                title={`Theme: ${themeMeta.label}`}
                type="button"
                variant="outline"
                onClick={() => setTheme(getNextTheme(theme))}
              >
                <themeMeta.Icon />
              </Button>
            </div>
          </section>

          <section className="rounded-lg border border-border bg-card shadow-sm">
            <form className="grid gap-3 p-3 xl:grid-cols-[minmax(280px,1fr)_minmax(190px,280px)_auto]" onSubmit={handleConnect}>
              <label className="grid gap-1.5">
                <span className="flex items-center gap-2 text-xs font-semibold uppercase text-muted-foreground">
                  <Server className="size-3.5" />
                  Endpoint
                </span>
                <Input
                  autoComplete="off"
                  placeholder="quack:host:443"
                  spellCheck={false}
                  value={endpoint}
                  onChange={(event) => setEndpoint(event.target.value)}
                />
              </label>

              <label className="grid gap-1.5">
                <span className="flex items-center gap-2 text-xs font-semibold uppercase text-muted-foreground">
                  <KeyRound className="size-3.5" />
                  Token
                </span>
                <Input
                  autoComplete="off"
                  placeholder={DEV_TOKEN ? "Uses local .env token if empty" : "Paste token"}
                  type="password"
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                />
              </label>

              <div className="flex items-end">
                <Button className="w-full xl:w-auto" disabled={connectionState === "connecting"} type="submit">
                  {connectionState === "connecting" ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <Database />
                  )}
                  Connect
                </Button>
              </div>
            </form>

            <div className="grid gap-2 border-t border-border p-3 lg:grid-cols-[1fr_minmax(280px,42%)]">
              <Alert variant={message.kind}>{message.text}</Alert>
              <Alert className="flex items-start gap-2" variant="warning">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <span>Static sites cannot hide a token from the active browser user. Use scoped, read-only, short-lived tokens.</span>
              </Alert>
            </div>
          </section>
        </header>

        <section className="grid min-h-0 flex-1 gap-4 pt-4 xl:grid-cols-[360px_minmax(0,1fr)]">
          <CatalogSidebar
            filteredCount={visibleTables.length}
            groups={schemaGroups}
            hideSystemSchemas={hideSystemSchemas}
            isConnected={connectionState === "ready"}
            search={catalogSearch}
            selectedTableKey={selectedTableKey}
            tableCount={tables.length}
            onHideSystemSchemasChange={setHideSystemSchemas}
            onPreviewTable={handlePreviewTable}
            onSearchChange={setCatalogSearch}
          />

          <PreviewWorkspace preview={preview} />
        </section>
      </div>
    </main>
  );
}

type CatalogSidebarProps = {
  filteredCount: number;
  groups: Array<[string, RemoteTable[]]>;
  hideSystemSchemas: boolean;
  isConnected: boolean;
  search: string;
  selectedTableKey: string;
  tableCount: number;
  onHideSystemSchemasChange: (checked: boolean) => void;
  onPreviewTable: (table: RemoteTable) => Promise<void>;
  onSearchChange: (value: string) => void;
};

function CatalogSidebar({
  filteredCount,
  groups,
  hideSystemSchemas,
  isConnected,
  search,
  selectedTableKey,
  tableCount,
  onHideSystemSchemasChange,
  onPreviewTable,
  onSearchChange,
}: CatalogSidebarProps): React.ReactElement {
  return (
    <aside className="min-h-[420px] rounded-lg border border-border bg-card shadow-sm xl:max-h-[calc(100vh-190px)]">
      <div className="flex items-center justify-between gap-3 border-b border-border p-4">
        <div>
          <p className="text-xs font-semibold uppercase text-muted-foreground">Catalog</p>
          <h2 className="text-lg font-bold">Schemas and tables</h2>
        </div>
        <Badge variant="outline">{filteredCount}/{tableCount}</Badge>
      </div>

      <div className="grid gap-3 border-b border-border p-3">
        <label className="relative block">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-9"
            disabled={!isConnected}
            placeholder="Search schema or table"
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
          />
        </label>

        <div className="flex items-center justify-between gap-3 rounded-md bg-muted/65 px-3 py-2">
          <span className="text-sm font-medium text-muted-foreground">Hide system schemas</span>
          <Switch
            checked={hideSystemSchemas}
            disabled={!isConnected}
            onCheckedChange={onHideSystemSchemasChange}
          />
        </div>
      </div>

      <div className="max-h-[58vh] overflow-auto p-2 xl:max-h-[calc(100vh-365px)]">
        {!isConnected ? (
          <EmptyCatalog />
        ) : groups.length === 0 ? (
          <div className="rounded-md border border-dashed border-border p-6 text-sm text-muted-foreground">
            No tables match the current filters.
          </div>
        ) : (
          groups.map(([schema, schemaTables]) => (
            <details className="group/schema mb-2 rounded-md border border-border/80 bg-background" key={schema} open>
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-sm font-bold">
                <span className="flex min-w-0 items-center gap-2">
                  <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform group-open/schema:rotate-180" />
                  <span className="truncate">{schema}</span>
                </span>
                <Badge variant="secondary">{schemaTables.length}</Badge>
              </summary>
              <div className="grid gap-1 px-1.5 pb-1.5">
                {schemaTables.map((table) => {
                  const key = tableKey(table);
                  const isSelected = key === selectedTableKey;

                  return (
                    <button
                      className={cn(
                        "grid min-h-10 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors hover:bg-muted",
                        isSelected && "bg-primary text-primary-foreground hover:bg-primary",
                      )}
                      key={key}
                      type="button"
                      onClick={() => void onPreviewTable(table)}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <Table2 className="size-4 shrink-0 opacity-70" />
                        <span className="truncate font-semibold">{table.table_name}</span>
                      </span>
                      <span
                        className={cn(
                          "rounded-sm bg-muted px-1.5 py-0.5 text-[0.68rem] font-bold uppercase text-muted-foreground",
                          isSelected && "bg-primary-foreground/18 text-primary-foreground",
                        )}
                      >
                        {table.table_type || "TABLE"}
                      </span>
                    </button>
                  );
                })}
              </div>
            </details>
          ))
        )}
      </div>
    </aside>
  );
}

function EmptyCatalog(): React.ReactElement {
  return (
    <div className="grid gap-3 rounded-md border border-dashed border-border p-6 text-sm text-muted-foreground">
      <Database className="size-7 text-accent-foreground" />
      <p>Connect to load remote schemas and browse table previews.</p>
    </div>
  );
}

function PreviewWorkspace({ preview }: { preview: PreviewState }): React.ReactElement {
  const title = preview.table ? `${preview.table.table_schema}.${preview.table.table_name}` : "Select a table";
  const rowCount = preview.result?.rows.length ?? 0;
  const columnCount = preview.result?.columns.length ?? 0;

  return (
    <section className="min-h-[520px] rounded-lg border border-border bg-card shadow-sm xl:max-h-[calc(100vh-190px)]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-4">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase text-muted-foreground">Preview</p>
          <h2 className="truncate text-xl font-black">{title}</h2>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline">{rowCount} rows</Badge>
          <Badge variant="outline">{columnCount} columns</Badge>
        </div>
      </div>

      {preview.isLoading ? (
        <PreviewSkeleton />
      ) : preview.result ? (
        <PreviewGrid preview={preview.result} />
      ) : (
        <div className="grid min-h-[420px] place-items-center p-8">
          <div className="max-w-md text-center">
            <div className="mx-auto mb-4 grid size-12 place-items-center rounded-md bg-muted text-accent-foreground">
              <Table2 className="size-6" />
            </div>
            <h3 className="text-lg font-bold">No table selected</h3>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              Pick a table in the catalog sidebar to fetch up to {PREVIEW_LIMIT} rows through the remote Quack connection.
            </p>
          </div>
        </div>
      )}
    </section>
  );
}

function PreviewGrid({ preview }: { preview: PreviewResult }): React.ReactElement {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});

  useEffect(() => {
    setSorting([]);
    setColumnVisibility({});
  }, [preview.columns]);

  const columns = useMemo<ColumnDef<PreviewRow>[]>(
    () =>
      preview.columns.map((column) => ({
        id: column,
        header: column,
        accessorFn: (row) => stringifyCell(row[column]),
        cell: ({ getValue }) => {
          const value = String(getValue());
          return (
            <Tooltip label={value}>
              <span className="block max-w-80 truncate font-medium tabular-nums">{value}</span>
            </Tooltip>
          );
        },
      })),
    [preview.columns],
  );

  const table = useReactTable({
    columns,
    data: preview.rows,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    onColumnVisibilityChange: setColumnVisibility,
    onSortingChange: setSorting,
    state: {
      columnVisibility,
      sorting,
    },
  });

  if (preview.rows.length === 0) {
    return (
      <div className="grid min-h-[420px] place-items-center p-8">
        <div className="rounded-md border border-dashed border-border p-6 text-sm text-muted-foreground">
          This table returned no rows.
        </div>
      </div>
    );
  }

  return (
    <div className="grid min-h-0">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2">
        <div className="text-sm text-muted-foreground">
          Sort columns from the header. Values are rendered client-side from the Arrow result.
        </div>
        <details className="relative">
          <summary className="list-none">
            <Button size="sm" type="button" variant="outline">
              <Columns3 />
              Columns
            </Button>
          </summary>
          <div className="absolute right-0 z-20 mt-2 grid max-h-72 w-64 gap-1 overflow-auto rounded-md border border-border bg-popover p-2 text-sm shadow-lg">
            {table.getAllLeafColumns().map((column) => (
              <label className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 hover:bg-muted" key={column.id}>
                <input
                  checked={column.getIsVisible()}
                  className="size-4 accent-[var(--primary)]"
                  type="checkbox"
                  onChange={column.getToggleVisibilityHandler()}
                />
                <span className="min-w-0 truncate">{column.id}</span>
              </label>
            ))}
          </div>
        </details>
      </div>

      <div className="max-h-[66vh] overflow-auto xl:max-h-[calc(100vh-326px)]">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-card">
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow className="hover:bg-transparent" key={headerGroup.id}>
                <TableHead className="sticky left-0 z-20 w-14 bg-card text-right">#</TableHead>
                {headerGroup.headers.map((header) => (
                  <TableHead className="bg-card" key={header.id}>
                    {header.isPlaceholder ? null : (
                      <button
                        className="inline-flex max-w-80 items-center gap-2 truncate text-left"
                        type="button"
                        onClick={header.column.getToggleSortingHandler()}
                      >
                        <span className="truncate">
                          {flexRender(header.column.columnDef.header, header.getContext())}
                        </span>
                        <ArrowDownUp className="size-3.5 shrink-0 text-muted-foreground" />
                      </button>
                    )}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.map((row, index) => (
              <TableRow key={row.id}>
                <TableCell className="sticky left-0 bg-card text-right text-xs font-semibold text-muted-foreground">
                  {index + 1}
                </TableCell>
                {row.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function PreviewSkeleton(): React.ReactElement {
  return (
    <div className="grid gap-3 p-4">
      <div className="flex gap-2">
        <Skeleton className="h-8 w-28" />
        <Skeleton className="h-8 w-24" />
      </div>
      <div className="grid gap-2">
        {Array.from({ length: 10 }).map((_, index) => (
          <Skeleton className="h-9 w-full" key={index} />
        ))}
      </div>
    </div>
  );
}

function groupTablesBySchema(tables: RemoteTable[]): Array<[string, RemoteTable[]]> {
  const grouped = new Map<string, RemoteTable[]>();

  for (const table of tables) {
    const tablesInSchema = grouped.get(table.table_schema);

    if (tablesInSchema) {
      tablesInSchema.push(table);
    } else {
      grouped.set(table.table_schema, [table]);
    }
  }

  return Array.from(grouped.entries());
}

function parseTheme(value: string): ThemeMode {
  if (value === "light" || value === "dark" || value === "system") {
    return value;
  }

  return "system";
}

function resolveTheme(theme: ThemeMode): "light" | "dark" {
  if (theme !== "system") {
    return theme;
  }

  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function getNextTheme(theme: ThemeMode): ThemeMode {
  if (theme === "system") {
    return "light";
  }

  if (theme === "light") {
    return "dark";
  }

  return "system";
}

function getThemeMeta(theme: ThemeMode): {
  Icon: typeof Sun;
  label: string;
} {
  if (theme === "light") {
    return { Icon: Sun, label: "Light" };
  }

  if (theme === "dark") {
    return { Icon: Moon, label: "Dark" };
  }

  return { Icon: Monitor, label: "System" };
}

function getStatusMeta(state: ConnectionState): {
  Icon: typeof CheckCircle2;
  badgeVariant: "outline" | "success" | "warning" | "destructive";
  label: string;
} {
  if (state === "connecting") {
    return { Icon: Loader2, badgeVariant: "warning", label: "Connecting" };
  }

  if (state === "ready") {
    return { Icon: CheckCircle2, badgeVariant: "success", label: "Ready" };
  }

  if (state === "error") {
    return { Icon: XCircle, badgeVariant: "destructive", label: "Error" };
  }

  return { Icon: Database, badgeVariant: "outline", label: "Idle" };
}
