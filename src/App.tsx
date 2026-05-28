import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  type ColumnDef,
  type SortingState,
  useReactTable,
} from "@tanstack/react-table";
import {
  AlertTriangle,
  ArrowDownUp,
  CheckCircle2,
  ChevronRight,
  Database,
  FileCode2,
  Info,
  KeyRound,
  Loader2,
  Monitor,
  Moon,
  Rows3,
  Search,
  Server,
  Settings2,
  Sun,
  Table2,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
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
type WorkspaceTab = "preview" | "metadata" | "query";

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
const WORKSPACE_TABS: Array<{ id: WorkspaceTab; label: string; Icon: typeof Table2 }> = [
  { id: "preview", label: "Preview", Icon: Rows3 },
  { id: "metadata", label: "Metadata", Icon: Info },
  { id: "query", label: "Query", Icon: FileCode2 },
];

export function App(): React.ReactElement {
  const clientRef = useRef<QuackClient | null>(null);
  const previewRunRef = useRef(0);
  const [endpoint, setEndpoint] = useState(() => readStoredString(ENDPOINT_KEY, DEFAULT_URI));
  const [theme, setTheme] = useState<ThemeMode>(() => parseTheme(readStoredString(THEME_KEY, "system")));
  const [token, setToken] = useState("");
  const [connectionState, setConnectionState] = useState<ConnectionState>("idle");
  const [message, setMessage] = useState<Message>({
    kind: "info",
    text: "",
  });
  const [tables, setTables] = useState<RemoteTable[]>([]);
  const [selectedSchema, setSelectedSchema] = useState("");
  const [selectedTableKey, setSelectedTableKey] = useState("");
  const [catalogSearch, setCatalogSearch] = useState("");
  const [hideSystemSchemas, setHideSystemSchemas] = useState(() => readStoredBoolean(HIDE_SYSTEM_KEY, true));
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("preview");
  const [isConnectionDialogOpen, setIsConnectionDialogOpen] = useState(true);
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
  const selectedTable = preview.table;
  const selectedSchemaTables = useMemo(
    () => tables.filter((table) => table.table_schema === selectedSchema),
    [selectedSchema, tables],
  );
  const status = getStatusMeta(connectionState);
  const themeMeta = getThemeMeta(theme);
  const endpointLabel = endpoint.trim() ? formatEndpoint(endpoint) : "No endpoint";

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
    setSelectedSchema("");
    setSelectedTableKey("");
    setActiveTab("preview");
    setPreview({ isLoading: false, table: null, result: null });

    try {
      if (clientRef.current) {
        await clientRef.current.close();
        clientRef.current = null;
      }

      nextClient = await QuackClient.create(uri, secret);
      const remoteTables = await nextClient.listTables();

      clientRef.current = nextClient;
      const connectedClient = nextClient;
      nextClient = null;
      setTables(remoteTables);
      setConnectionState("ready");
      setIsConnectionDialogOpen(false);

      const initialTable = getInitialTable(remoteTables);

      if (initialTable) {
        await previewTableWithClient(connectedClient, initialTable);
      } else {
        setMessage({
          kind: "success",
          text: "Connected. No remote tables were found.",
        });
      }
    } catch (error) {
      if (nextClient) {
        await nextClient.close();
      }

      setConnectionState("error");
      setIsConnectionDialogOpen(true);
      setMessage({ kind: "error", text: formatError(error) });
    }
  }

  async function handlePreviewTable(table: RemoteTable): Promise<void> {
    const client = clientRef.current;

    if (!client) {
      setMessage({ kind: "error", text: "Connect before previewing a table." });
      return;
    }

    await previewTableWithClient(client, table);
  }

  function handleSelectSchema(schema: string): void {
    const schemaTableCount = tables.filter((table) => table.table_schema === schema).length;

    previewRunRef.current += 1;
    setSelectedSchema(schema);
    setSelectedTableKey("");
    setActiveTab("preview");
    setPreview({ isLoading: false, table: null, result: null });
    setMessage({
      kind: "success",
      text: `Showing ${schemaTableCount} ${schemaTableCount === 1 ? "table" : "tables"} in ${schema}.`,
    });
  }

  async function previewTableWithClient(client: QuackClient, table: RemoteTable): Promise<void> {
    const runId = previewRunRef.current + 1;
    previewRunRef.current = runId;
    setSelectedSchema("");
    setSelectedTableKey(tableKey(table));
    setActiveTab("preview");
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
    <main className="h-dvh overflow-hidden bg-background text-foreground">
      <div className="grid h-full min-h-0 grid-cols-[300px_minmax(0,1fr)] overflow-hidden">
        <ConnectionDialog
          connectionState={connectionState}
          endpoint={endpoint}
          message={message}
          open={isConnectionDialogOpen}
          token={token}
          onEndpointChange={setEndpoint}
          onOpenChange={setIsConnectionDialogOpen}
          onSubmit={handleConnect}
          onTokenChange={setToken}
        />

        <CatalogSidebar
          connectionState={connectionState}
          endpointLabel={endpointLabel}
          filteredCount={visibleTables.length}
          groups={schemaGroups}
          hideSystemSchemas={hideSystemSchemas}
          isConnected={connectionState === "ready"}
          message={message}
          search={catalogSearch}
          selectedSchema={selectedSchema}
          selectedTableKey={selectedTableKey}
          status={status}
          tableCount={tables.length}
          themeMeta={themeMeta}
          onConnectionOpen={() => setIsConnectionDialogOpen(true)}
          onHideSystemSchemasChange={setHideSystemSchemas}
          onPreviewTable={handlePreviewTable}
          onSearchChange={setCatalogSearch}
          onSelectSchema={handleSelectSchema}
          onThemeChange={() => setTheme(getNextTheme(theme))}
        />

        <PreviewWorkspace
          activeTab={activeTab}
          preview={preview}
          schemaTables={selectedSchemaTables}
          selectedSchema={selectedSchema}
          selectedTable={selectedTable}
          onActiveTabChange={setActiveTab}
          onPreviewTable={handlePreviewTable}
          onSelectSchema={handleSelectSchema}
        />
      </div>
    </main>
  );
}

type ConnectionDialogProps = {
  connectionState: ConnectionState;
  endpoint: string;
  message: Message;
  open: boolean;
  token: string;
  onEndpointChange: (value: string) => void;
  onOpenChange: (open: boolean) => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
  onTokenChange: (value: string) => void;
};

function ConnectionDialog({
  connectionState,
  endpoint,
  message,
  open,
  token,
  onEndpointChange,
  onOpenChange,
  onSubmit,
  onTokenChange,
}: ConnectionDialogProps): React.ReactElement {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Connection" onOpenChange={onOpenChange}>
        <div className="border-b border-border px-4 py-3 pr-12">
          <h2 className="text-lg font-black">Remote DuckDB</h2>
        </div>

        <form className="grid gap-3 p-4" onSubmit={(event) => void onSubmit(event)}>
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
              onChange={(event) => onEndpointChange(event.target.value)}
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
              onChange={(event) => onTokenChange(event.target.value)}
            />
          </label>

          <Alert className="flex items-start gap-2" variant="warning">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span>Static sites cannot hide browser tokens. Use scoped, read-only, short-lived tokens.</span>
          </Alert>

          {message.kind === "error" || connectionState === "connecting" ? (
            <Alert variant={message.kind}>{message.text}</Alert>
          ) : null}

          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-3">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button disabled={connectionState === "connecting"} type="submit">
              {connectionState === "connecting" ? <Loader2 className="animate-spin" /> : <Database />}
              Connect
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type CatalogSidebarProps = {
  connectionState: ConnectionState;
  endpointLabel: string;
  filteredCount: number;
  groups: Array<[string, RemoteTable[]]>;
  hideSystemSchemas: boolean;
  isConnected: boolean;
  message: Message;
  search: string;
  selectedSchema: string;
  selectedTableKey: string;
  status: ReturnType<typeof getStatusMeta>;
  tableCount: number;
  themeMeta: ReturnType<typeof getThemeMeta>;
  onConnectionOpen: () => void;
  onHideSystemSchemasChange: (checked: boolean) => void;
  onPreviewTable: (table: RemoteTable) => Promise<void>;
  onSearchChange: (value: string) => void;
  onSelectSchema: (schema: string) => void;
  onThemeChange: () => void;
};

function CatalogSidebar({
  connectionState,
  endpointLabel,
  filteredCount,
  groups,
  hideSystemSchemas,
  isConnected,
  message,
  search,
  selectedSchema,
  selectedTableKey,
  status,
  tableCount,
  themeMeta,
  onConnectionOpen,
  onHideSystemSchemasChange,
  onPreviewTable,
  onSearchChange,
  onSelectSchema,
  onThemeChange,
}: CatalogSidebarProps): React.ReactElement {
  return (
    <aside className="flex min-h-0 flex-col overflow-hidden border-r border-border bg-sidebar text-sidebar-foreground">
      <div className="border-b border-sidebar-border p-3">
        <div className="flex items-center gap-2">
          <div className="grid size-8 shrink-0 place-items-center rounded-md border border-border bg-card text-primary">
            <Database className="size-4.5" />
          </div>
          <h1 className="min-w-0 flex-1 truncate text-base font-black leading-5">quackalog</h1>
          <Badge variant="outline">{filteredCount}/{tableCount}</Badge>
        </div>
      </div>

      <div className="grid gap-2 border-b border-sidebar-border p-2.5">
        <label className="relative block">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="h-8 pl-9"
            disabled={!isConnected}
            placeholder="Search schema or table"
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
          />
        </label>

        <div className="flex items-center justify-between gap-3 rounded-md border border-sidebar-border bg-sidebar-accent px-2.5 py-1.5">
          <span className="text-sm font-medium text-muted-foreground">Hide system schemas</span>
          <Switch
            checked={hideSystemSchemas}
            disabled={!isConnected}
            onCheckedChange={onHideSystemSchemasChange}
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-1">
        {!isConnected ? (
          <EmptyCatalog />
        ) : groups.length === 0 ? (
          <div className="p-3 text-sm text-muted-foreground">No matches</div>
        ) : (
          groups.map(([schema, schemaTables]) => {
            const isSchemaSelected = selectedSchema === schema;

            return (
              <details className="group/schema" key={schema} open>
                <summary
                  className={cn(
                    "grid h-8 cursor-pointer list-none grid-cols-[14px_18px_minmax(0,1fr)_auto] items-center gap-2 rounded-md px-2 text-sm font-bold outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring",
                    isSchemaSelected && "bg-sidebar-accent text-sidebar-accent-foreground",
                  )}
                  onClick={(event) => {
                    if ((event.target as HTMLElement).closest("[data-schema-toggle]")) {
                      return;
                    }

                    event.preventDefault();
                    onSelectSchema(schema);
                  }}
                >
                  <span data-schema-toggle>
                    <ChevronRight className="size-3.5 text-muted-foreground transition-transform group-open/schema:rotate-90" />
                  </span>
                  <Database className="size-4 text-muted-foreground" />
                  <span className="truncate">{schema}</span>
                  <span className="rounded-sm bg-muted px-1.5 py-0.5 text-[0.68rem] font-bold leading-none text-muted-foreground">
                    {schemaTables.length}
                  </span>
                </summary>
                <div className="grid gap-0.5 pb-1 pl-7 pr-1">
                  {schemaTables.map((table) => {
                    const key = tableKey(table);
                    const isSelected = key === selectedTableKey;

                    return (
                      <button
                        className={cn(
                          "grid h-7 grid-cols-[18px_minmax(0,1fr)] items-center gap-2 rounded-md px-2 text-left text-sm transition-colors hover:bg-muted",
                          isSelected && "bg-primary text-primary-foreground hover:bg-primary",
                        )}
                        key={key}
                        type="button"
                        onClick={() => void onPreviewTable(table)}
                      >
                        <Table2 className="size-3.5 shrink-0 opacity-70" />
                        <span className="truncate font-semibold">{table.table_name}</span>
                      </button>
                    );
                  })}
                </div>
              </details>
            );
          })
        )}
      </div>

      <div className="flex min-h-9 shrink-0 items-center gap-1 border-t border-sidebar-border px-1.5 py-1">
        <Badge className="justify-center" variant={status.badgeVariant}>
          <status.Icon className={cn("mr-1 size-3.5", connectionState === "connecting" && "animate-spin")} />
          {status.label}
        </Badge>

        <div
          className={cn(
            "flex min-w-0 flex-1 items-center gap-1.5 px-1 text-xs text-muted-foreground",
            message.text && message.kind === "error" && "font-medium text-destructive",
          )}
          title={message.text && message.kind === "error" ? message.text : endpointLabel}
        >
          <Server className="size-3.5 shrink-0" />
          <span className="truncate">{message.text && message.kind === "error" ? message.text : endpointLabel}</span>
        </div>

        <Button
          aria-label={connectionState === "ready" ? "Connection" : "Connect"}
          disabled={connectionState === "connecting"}
          size="icon"
          title={connectionState === "ready" ? "Connection" : "Connect"}
          type="button"
          variant="quiet"
          onClick={onConnectionOpen}
        >
          <Settings2 />
        </Button>
        <Button
          aria-label={`Theme: ${themeMeta.label}`}
          size="icon"
          title={`Theme: ${themeMeta.label}`}
          type="button"
          variant="quiet"
          onClick={onThemeChange}
        >
          <themeMeta.Icon />
        </Button>
      </div>
    </aside>
  );
}

function EmptyCatalog(): React.ReactElement {
  return (
    <div className="grid h-full place-items-center p-6">
      <div className="grid justify-items-center gap-3 text-center">
        <div className="grid size-10 place-items-center rounded-md bg-accent text-accent-foreground">
          <Database className="size-5" />
        </div>
        <p className="text-sm font-semibold text-muted-foreground">No catalog</p>
      </div>
    </div>
  );
}

type PreviewWorkspaceProps = {
  activeTab: WorkspaceTab;
  preview: PreviewState;
  schemaTables: RemoteTable[];
  selectedSchema: string;
  selectedTable: RemoteTable | null;
  onActiveTabChange: (tab: WorkspaceTab) => void;
  onPreviewTable: (table: RemoteTable) => Promise<void>;
  onSelectSchema: (schema: string) => void;
};

function PreviewWorkspace({
  activeTab,
  preview,
  schemaTables,
  selectedSchema,
  selectedTable,
  onActiveTabChange,
  onPreviewTable,
  onSelectSchema,
}: PreviewWorkspaceProps): React.ReactElement {
  const rowCount = preview.result?.rows.length ?? 0;
  const columnCount = preview.result?.columns.length ?? 0;
  const selectedTableType = selectedTable ? getDisplayTableType(selectedTable) : "";
  const isSchemaView = selectedSchema.length > 0;

  return (
    <section className="flex min-h-0 min-w-0 flex-col overflow-hidden bg-background">
      <div className="border-b border-border bg-card px-3 py-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            {isSchemaView ? (
              <h2 className="truncate text-lg font-black leading-6">{selectedSchema}</h2>
            ) : selectedTable ? (
              <nav aria-label="Table location" className="flex min-w-0 items-center gap-1.5 text-lg font-black leading-6">
                <button
                  className="min-w-0 truncate rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  type="button"
                  onClick={() => onSelectSchema(selectedTable.table_schema)}
                >
                  {selectedTable.table_schema}
                </button>
                <span className="text-muted-foreground">/</span>
                <span className="min-w-0 truncate">{selectedTable.table_name}</span>
              </nav>
            ) : (
              <h2 className="truncate text-lg font-black leading-6">Select a table</h2>
            )}
          </div>
          <div className="flex items-center gap-2">
            {isSchemaView ? (
              <Badge variant="outline">{schemaTables.length} tables</Badge>
            ) : (
              <>
                {selectedTableType ? <Badge variant="secondary">{selectedTableType}</Badge> : null}
                <Badge variant="outline">{rowCount} rows</Badge>
                <Badge variant="outline">{columnCount} columns</Badge>
              </>
            )}
          </div>
        </div>
      </div>

      {isSchemaView ? null : (
        <div className="flex gap-1 overflow-x-auto border-b border-border bg-card px-2.5">
          {WORKSPACE_TABS.map((tab) => (
            <button
              className={cn(
                "inline-flex h-9 shrink-0 items-center gap-1.5 border-b-2 border-transparent px-2.5 text-sm font-semibold text-muted-foreground transition-colors hover:text-foreground",
                activeTab === tab.id && "border-primary text-foreground",
              )}
              key={tab.id}
              type="button"
              onClick={() => onActiveTabChange(tab.id)}
            >
              <tab.Icon className="size-3.5" />
              {tab.label}
            </button>
          ))}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-hidden">
        {isSchemaView ? (
          <SchemaTablesPanel tables={schemaTables} onPreviewTable={onPreviewTable} />
        ) : (
          <>
            {activeTab === "preview" ? <PreviewPanel preview={preview} /> : null}
            {activeTab === "metadata" ? <MetadataPanel selectedTable={selectedTable} preview={preview} /> : null}
            {activeTab === "query" ? <QueryPanel selectedTable={selectedTable} /> : null}
          </>
        )}
      </div>
    </section>
  );
}

function SchemaTablesPanel({
  tables,
  onPreviewTable,
}: {
  tables: RemoteTable[];
  onPreviewTable: (table: RemoteTable) => Promise<void>;
}): React.ReactElement {
  if (tables.length === 0) {
    return <EmptyWorkspacePanel icon={Table2} title="No tables" />;
  }

  return (
    <div className="h-full overflow-auto">
      <Table>
        <TableHeader className="sticky top-0 z-10 bg-card">
          <TableRow className="hover:bg-transparent">
            <TableHead className="w-12 text-right">#</TableHead>
            <TableHead>Table</TableHead>
            <TableHead className="w-40">Type</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {tables.map((table, index) => (
            <TableRow key={tableKey(table)}>
              <TableCell className="text-right text-xs font-semibold text-muted-foreground">{index + 1}</TableCell>
              <TableCell>
                <button
                  className="flex max-w-full items-center gap-2 truncate text-left font-semibold transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  type="button"
                  onClick={() => void onPreviewTable(table)}
                >
                  <Table2 className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{table.table_name}</span>
                </button>
              </TableCell>
              <TableCell className="text-muted-foreground">{table.table_type || "BASE TABLE"}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function PreviewPanel({ preview }: { preview: PreviewState }): React.ReactElement {
  if (preview.isLoading) {
    return <PreviewSkeleton />;
  }

  if (preview.result) {
    return <PreviewGrid preview={preview.result} />;
  }

  return (
    <EmptyWorkspacePanel icon={Table2} title="Select a table" />
  );
}

function MetadataPanel({
  selectedTable,
  preview,
}: {
  selectedTable: RemoteTable | null;
  preview: PreviewState;
}): React.ReactElement {
  if (!selectedTable) {
    return <EmptyWorkspacePanel icon={Info} title="Select a table" />;
  }

  const items = [
    ["Schema", selectedTable.table_schema],
    ["Table", selectedTable.table_name],
    ["Type", selectedTable.table_type || "TABLE"],
    ["Preview limit", `${PREVIEW_LIMIT} rows`],
    ["Loaded rows", `${preview.result?.rows.length ?? 0}`],
    ["Loaded columns", `${preview.result?.columns.length ?? 0}`],
  ];
  const columnMetadata = preview.result?.columnMetadata ?? [];

  return (
    <div className="h-full overflow-auto">
      <dl className="grid border-b border-border sm:grid-cols-2">
        {items.map(([label, value]) => (
          <div className="grid gap-1 border-b border-border px-3 py-2 last:border-b-0 sm:grid-cols-[120px_1fr] sm:odd:border-r sm:[&:nth-last-child(-n+2)]:border-b-0" key={label}>
            <dt className="text-sm font-semibold text-muted-foreground">{label}</dt>
            <dd className="min-w-0 break-words text-sm font-medium">{value}</dd>
          </div>
        ))}
      </dl>

      {columnMetadata.length > 0 ? (
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-card">
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-16 text-right">#</TableHead>
              <TableHead>Column</TableHead>
              <TableHead>Type</TableHead>
              <TableHead className="w-28">Nullable</TableHead>
              <TableHead className="w-28 text-right">Values</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {columnMetadata.map((column, index) => (
              <TableRow key={column.name}>
                <TableCell className="text-right text-xs font-semibold text-muted-foreground">{index + 1}</TableCell>
                <TableCell className="font-semibold">{column.name}</TableCell>
                <TableCell className="text-muted-foreground">{column.type}</TableCell>
                <TableCell className="text-muted-foreground">
                  {column.nullable === null ? "unknown" : column.nullable ? "yes" : "no"}
                </TableCell>
                <TableCell className="text-right text-muted-foreground">{preview.result?.rows.length ?? 0}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}
    </div>
  );
}

function QueryPanel({ selectedTable }: { selectedTable: RemoteTable | null }): React.ReactElement {
  if (!selectedTable) {
    return <EmptyWorkspacePanel icon={FileCode2} title="Select a table" />;
  }

  const qualifiedName = `${quoteIdentifier(selectedTable.table_schema)}.${quoteIdentifier(selectedTable.table_name)}`;
  const query = `SELECT *\nFROM ${qualifiedName}\nLIMIT ${PREVIEW_LIMIT};`;

  return (
    <div className="h-full overflow-auto">
      <pre className="overflow-auto p-3 text-sm leading-6">
        <code>{query}</code>
      </pre>
    </div>
  );
}

function EmptyWorkspacePanel({
  icon: Icon,
  title,
}: {
  icon: typeof Table2;
  title: string;
}): React.ReactElement {
  return (
    <div className="grid min-h-[420px] place-items-center p-6 lg:min-h-full">
      <div className="grid justify-items-center gap-3 text-center">
        <div className="grid size-10 place-items-center rounded-md bg-accent text-accent-foreground">
          <Icon className="size-5" />
        </div>
        <h3 className="text-sm font-semibold text-muted-foreground">{title}</h3>
      </div>
    </div>
  );
}

function PreviewGrid({ preview }: { preview: PreviewResult }): React.ReactElement {
  const [sorting, setSorting] = useState<SortingState>([]);

  useEffect(() => {
    setSorting([]);
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
    onSortingChange: setSorting,
    state: {
      sorting,
    },
  });

  if (preview.rows.length === 0) {
    return (
      <div className="grid min-h-[420px] place-items-center p-6 lg:min-h-full">
        <div className="text-sm text-muted-foreground">No rows</div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-auto">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-card">
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow className="hover:bg-transparent" key={headerGroup.id}>
                <TableHead className="sticky left-0 z-20 w-11 bg-card text-right">#</TableHead>
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
    <div className="grid gap-2 p-3">
      <div className="flex gap-2">
        <Skeleton className="h-7 w-28" />
        <Skeleton className="h-7 w-24" />
      </div>
      <div className="grid gap-2">
        {Array.from({ length: 10 }).map((_, index) => (
          <Skeleton className="h-8 w-full" key={index} />
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

function getInitialTable(tables: RemoteTable[]): RemoteTable | null {
  return tables.find((table) => !SYSTEM_SCHEMAS.has(table.table_schema)) ?? tables[0] ?? null;
}

function getDisplayTableType(table: RemoteTable): string {
  if (!table.table_type || table.table_type === "BASE TABLE") {
    return "";
  }

  return table.table_type;
}

function formatEndpoint(value: string): string {
  return value
    .trim()
    .replace(/^quack:quack:/, "")
    .replace(/^quack:/, "");
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

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
