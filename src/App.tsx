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
  LockKeyhole,
  Loader2,
  Monitor,
  Moon,
  Plus,
  Rows3,
  Search,
  Server,
  Settings2,
  ShieldCheck,
  Sun,
  Table2,
  Trash2,
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
  warmDuckDB,
} from "@/lib/quack-client";
import { readStoredString, writeStoredString } from "@/lib/storage";
import {
  forgetTokenVaultRecord,
  hasTokenVaultRecord,
  isTokenVaultSupported,
  saveEncryptedToken,
  unlockEncryptedToken,
} from "@/lib/token-vault";
import { cn } from "@/lib/utils";

type ConnectionState = "idle" | "connecting" | "ready" | "error";
type DuckDBState = "idle" | "warming" | "ready" | "error";
type TokenVaultState = "absent" | "memory" | "locked" | "unlocked";
type ConnectionMode = "paste" | "unlock";
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

type ConnectionProfile = {
  id: string;
  name: string;
  endpoint: string;
};

const DEFAULT_URI = import.meta.env.VITE_QUACK_URI || "";
const DEV_TOKEN = import.meta.env.DEV ? import.meta.env.VITE_QUACK_TOKEN || "" : "";
const ENDPOINT_KEY = "quackalog.endpoint";
const CONNECTIONS_KEY = "quackalog.connections";
const ACTIVE_CONNECTION_KEY = "quackalog.active-connection";
const THEME_KEY = "quackalog.theme";
const TOKEN_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const WORKSPACE_TABS: Array<{ id: WorkspaceTab; label: string; Icon: typeof Table2 }> = [
  { id: "preview", label: "Preview", Icon: Rows3 },
  { id: "metadata", label: "Metadata", Icon: Info },
  { id: "query", label: "Query", Icon: FileCode2 },
];

export function App(): React.ReactElement {
  const clientRef = useRef<QuackClient | null>(null);
  const previewRunRef = useRef(0);
  const lockTimerRef = useRef<number | null>(null);
  const [connections, setConnections] = useState<ConnectionProfile[]>(() => readStoredConnections());
  const [activeConnectionId, setActiveConnectionId] = useState(() => readStoredActiveConnectionId());
  const [isCreatingConnection, setIsCreatingConnection] = useState(false);
  const [connectionName, setConnectionName] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [theme, setTheme] = useState<ThemeMode>(() => parseTheme(readStoredString(THEME_KEY, "system")));
  const [token, setToken] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [vaultSecret, setVaultSecret] = useState("");
  const [rememberToken, setRememberToken] = useState(false);
  const [savedTokenExists, setSavedTokenExists] = useState(() => false);
  const [vaultState, setVaultState] = useState<TokenVaultState>(() =>
    "absent",
  );
  const [connectionMode, setConnectionMode] = useState<ConnectionMode>(() =>
    "paste",
  );
  const [connectionState, setConnectionState] = useState<ConnectionState>("idle");
  const [duckDBState, setDuckDBState] = useState<DuckDBState>("idle");
  const [message, setMessage] = useState<Message>({
    kind: "info",
    text: "",
  });
  const [tables, setTables] = useState<RemoteTable[]>([]);
  const [selectedSchema, setSelectedSchema] = useState("");
  const [selectedTableKey, setSelectedTableKey] = useState("");
  const [catalogSearch, setCatalogSearch] = useState("");
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("preview");
  const [isConnectionDialogOpen, setIsConnectionDialogOpen] = useState(() => connections.length === 0);
  const [preview, setPreview] = useState<PreviewState>({
    isLoading: false,
    table: null,
    result: null,
  });
  const vaultSupported = isTokenVaultSupported();

  useEffect(() => {
    writeStoredConnections(connections);
  }, [connections]);

  useEffect(() => {
    writeStoredString(ACTIVE_CONNECTION_KEY, isCreatingConnection ? "" : activeConnectionId);
  }, [activeConnectionId, isCreatingConnection]);

  useEffect(() => {
    if (isCreatingConnection) {
      return;
    }

    const activeConnection = connections.find((connection) => connection.id === activeConnectionId) ?? null;

    if (!activeConnection) {
      if (connections.length > 0) {
        setActiveConnectionId(connections[0].id);
        return;
      }

      setActiveConnectionId("");
      setConnectionName("");
      setEndpoint("");
      setSavedTokenExists(false);
      setVaultSecret("");
      setVaultState("absent");
      setConnectionMode("paste");
      return;
    }

    setConnectionName(activeConnection.name);
    setEndpoint(activeConnection.endpoint);
    const hasSavedToken = hasTokenVaultRecord(activeConnection.id);
    setSavedTokenExists(hasSavedToken);
    setVaultState((current) => (vaultSecret ? "unlocked" : current === "memory" ? current : hasSavedToken ? "locked" : "absent"));
    setConnectionMode(hasSavedToken ? "unlock" : "paste");
  }, [activeConnectionId, connections, isCreatingConnection, vaultSecret]);

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
    const warmTimer = window.setTimeout(() => {
      setDuckDBState("warming");
      void warmDuckDB()
        .then(() => {
          setDuckDBState("ready");
        })
        .catch((error: unknown) => {
          setDuckDBState("error");
          setMessage({ kind: "error", text: `DuckDB-Wasm failed to initialize. ${formatError(error)}` });
        });
    }, 0);

    return () => {
      window.clearTimeout(warmTimer);
      clearLockTimer();
      void clientRef.current?.close();
    };
  }, []);

  const visibleTables = useMemo(() => {
    const query = catalogSearch.trim().toLowerCase();

    return tables.filter((table) => {
      if (!query) {
        return true;
      }

      return `${table.table_schema}.${table.table_name}`.toLowerCase().includes(query);
    });
  }, [catalogSearch, tables]);

  const schemaGroups = useMemo(() => groupTablesBySchema(visibleTables), [visibleTables]);
  const selectedTable = preview.table;
  const activeConnection = connections.find((connection) => connection.id === activeConnectionId) ?? null;
  const selectedSchemaTables = useMemo(
    () => tables.filter((table) => table.table_schema === selectedSchema),
    [selectedSchema, tables],
  );
  const status = getStatusMeta(connectionState, duckDBState);
  const themeMeta = getThemeMeta(theme);
  async function handleSaveConnection(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    const profile = await saveConnectionDraft();

    if (!profile) {
      return;
    }

    setMessage({ kind: "success", text: `Saved ${profile.name}.` });
    setIsConnectionDialogOpen(false);
  }

  async function handleCheckConnection(): Promise<void> {
    const profile = getConnectionDraft();

    if (!profile) {
      return;
    }

    if (connectionMode === "unlock") {
      await handleUnlockAndCheck(profile);
      return;
    }

    await handlePasteTokenCheck(profile);
  }

  function getConnectionDraft(): ConnectionProfile | null {
    const uri = endpoint.trim();
    const name = connectionName.trim() || getConnectionAlias(uri);

    if (!uri) {
      setMessage({ kind: "error", text: "Enter a Quack URI before connecting." });
      return null;
    }

    return {
      id: !isCreatingConnection && activeConnection?.id ? activeConnection.id : createConnectionId(),
      name,
      endpoint: uri,
    };
  }

  async function saveConnectionDraft(): Promise<ConnectionProfile | null> {
    const draft = getConnectionDraft();

    if (!draft) {
      return null;
    }

    const profile = upsertConnectionProfile(draft);

    if (rememberToken && token.trim()) {
      if (!vaultSupported) {
        setMessage({ kind: "error", text: "Encrypted token storage is not available in this browser." });
        return null;
      }

      const secret = vaultSecret || passphrase;

      if (secret.length < 8) {
        setMessage({ kind: "error", text: "Use a passphrase with at least 8 characters." });
        return null;
      }

      await saveEncryptedToken(token.trim(), secret, profile.id);
      setVaultSecret(secret);
      setSavedTokenExists(true);
      setVaultState("unlocked");
      setRememberToken(false);
      setPassphrase("");
      setToken("");
    }

    return profile;
  }

  function upsertConnectionProfile(profile: ConnectionProfile): ConnectionProfile {
    setConnections((current) => {
      const exists = current.some((connection) => connection.id === profile.id);
      const next = exists
        ? current.map((connection) => (connection.id === profile.id ? profile : connection))
        : [...current, profile];

      return next;
    });
    setIsCreatingConnection(false);
    setActiveConnectionId(profile.id);

    return profile;
  }

  function handleAddConnection(): void {
    closeActiveClientForSwitch();
    setIsCreatingConnection(true);
    setActiveConnectionId("");
    setConnectionName("");
    setEndpoint(DEFAULT_URI);
    setToken("");
    setPassphrase("");
    setVaultSecret("");
    setRememberToken(false);
    setSavedTokenExists(false);
    setVaultState("absent");
    setConnectionMode("paste");
    setMessage({ kind: "info", text: "Add a catalog connection." });
    setIsConnectionDialogOpen(true);
  }

  function handleSelectConnection(connection: ConnectionProfile): void {
    if (connection.id === activeConnectionId) {
      return;
    }

    setIsCreatingConnection(false);
    closeActiveClientForSwitch();
    setActiveConnectionId(connection.id);
    setConnectionName(connection.name);
    setEndpoint(connection.endpoint);
    setToken("");
    setPassphrase("");
    setRememberToken(false);
    const hasSavedToken = hasTokenVaultRecord(connection.id);
    setSavedTokenExists(hasSavedToken);
    setVaultState(vaultSecret ? "unlocked" : hasSavedToken ? "locked" : "absent");
    setConnectionMode(hasSavedToken ? "unlock" : "paste");
    setMessage({ kind: "info", text: hasSavedToken ? "Unlock this catalog to browse it." : "Connect to browse this catalog." });
    setIsConnectionDialogOpen(true);
  }

  function handleDeleteConnection(connection: ConnectionProfile): void {
    forgetTokenVaultRecord(connection.id);
    setConnections((current) => current.filter((candidate) => candidate.id !== connection.id));

    if (connection.id === activeConnectionId) {
      closeActiveClientForSwitch();
      setActiveConnectionId("");
      setConnectionName("");
      setEndpoint("");
      setToken("");
      setPassphrase("");
      setRememberToken(false);
      setSavedTokenExists(false);
      setVaultState("absent");
      setConnectionMode("paste");
    }

    setMessage({ kind: "success", text: `Deleted ${connection.name}.` });
  }

  function closeActiveClientForSwitch(): void {
    clearLockTimer();
    previewRunRef.current += 1;
    void clientRef.current?.close();
    clientRef.current = null;
    setConnectionState("idle");
    setTables([]);
    setSelectedSchema("");
    setSelectedTableKey("");
    setActiveTab("preview");
    setPreview({ isLoading: false, table: null, result: null });
  }

  async function handlePasteTokenCheck(profile: ConnectionProfile): Promise<void> {
    const secret = token.trim() || DEV_TOKEN;

    if (!secret) {
      setMessage({ kind: "error", text: "Enter a token before checking the connection." });
      return;
    }

    await checkConnectionWithSecret(profile, secret);
  }

  async function handleUnlockAndCheck(profile: ConnectionProfile): Promise<void> {
    const secretPassphrase = vaultSecret || passphrase;

    if (!secretPassphrase) {
      setMessage({ kind: "error", text: "Enter your vault passphrase before checking the saved token." });
      return;
    }

    try {
      const secret = await unlockEncryptedToken(secretPassphrase, profile.id);

      setVaultSecret(secretPassphrase);
      setVaultState("unlocked");
      setPassphrase("");
      startLockTimer();
      await checkConnectionWithSecret(profile, secret);
    } catch (error) {
      setConnectionState("error");
      setMessage({ kind: "error", text: formatError(error) });
    }
  }

  async function checkConnectionWithSecret(profile: ConnectionProfile, secret: string): Promise<void> {
    let checkClient: QuackClient | null = null;

    setConnectionState("connecting");
    setMessage({ kind: "info", text: "Checking the endpoint and token." });

    try {
      checkClient = await QuackClient.create(profile.endpoint, secret);
      const remoteTables = await checkClient.listTables();

      setConnectionState(clientRef.current ? "ready" : "idle");
      setMessage({
        kind: "success",
        text: `Connection check passed. Found ${remoteTables.length} ${remoteTables.length === 1 ? "table" : "tables"}.`,
      });
    } catch (error) {
      setConnectionState("error");
      setMessage({ kind: "error", text: formatError(error) });
    } finally {
      await checkClient?.close();
    }
  }

  async function lockToken(options: { keepDialogClosed?: boolean } = {}): Promise<void> {
    clearLockTimer();
    setVaultSecret("");
    setPassphrase("");
    const hasSavedToken = activeConnectionId ? hasTokenVaultRecord(activeConnectionId) : false;
    previewRunRef.current += 1;
    await clientRef.current?.close();
    clientRef.current = null;
    setConnectionState("idle");
    setSavedTokenExists(hasSavedToken);
    setVaultState(hasSavedToken ? "locked" : "absent");
    setConnectionMode(hasSavedToken ? "unlock" : "paste");
    setTables([]);
    setSelectedSchema("");
    setSelectedTableKey("");
    setActiveTab("preview");
    setPreview({ isLoading: false, table: null, result: null });
    setMessage({ kind: "info", text: "Token locked. Enter your passphrase to reconnect." });
    setIsConnectionDialogOpen(options.keepDialogClosed ? false : hasSavedToken);
  }

  function clearLockTimer(): void {
    if (lockTimerRef.current !== null) {
      window.clearTimeout(lockTimerRef.current);
      lockTimerRef.current = null;
    }
  }

  function startLockTimer(): void {
    clearLockTimer();
    lockTimerRef.current = window.setTimeout(() => {
      void lockToken();
    }, TOKEN_IDLE_TIMEOUT_MS);
  }

  function touchTokenSession(): void {
    if (vaultState === "unlocked") {
      startLockTimer();
    }
  }

  async function handlePreviewTable(table: RemoteTable): Promise<void> {
    const client = clientRef.current;

    if (!client) {
      setMessage({ kind: "error", text: "Connect before previewing a table." });
      return;
    }

    touchTokenSession();
    await previewTableWithClient(client, table);
  }

  function handleSelectSchema(schema: string): void {
    touchTokenSession();
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

  function handleSelectCatalog(): void {
    touchTokenSession();
    previewRunRef.current += 1;
    setSelectedSchema("");
    setSelectedTableKey("");
    setActiveTab("preview");
    setPreview({ isLoading: false, table: null, result: null });
    setMessage({
      kind: "success",
      text: activeConnection
        ? `Showing ${tables.length} ${tables.length === 1 ? "table" : "tables"} in ${activeConnection.name}.`
        : "Select a catalog.",
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
          connectionMode={connectionMode}
          connectionState={connectionState}
          connectionName={connectionName}
          connections={connections}
          endpoint={endpoint}
          hasSavedToken={savedTokenExists}
          message={message}
          open={isConnectionDialogOpen}
          passphrase={passphrase}
          rememberToken={rememberToken}
          token={token}
          vaultState={vaultState}
          vaultSupported={vaultSupported}
          activeConnectionId={activeConnectionId}
          onConnectionModeChange={setConnectionMode}
          onConnectionNameChange={setConnectionName}
          onEndpointChange={setEndpoint}
          onOpenChange={setIsConnectionDialogOpen}
          onPassphraseChange={setPassphrase}
          onRememberTokenChange={setRememberToken}
          onCheckConnection={() => void handleCheckConnection()}
          onSubmit={handleSaveConnection}
          onTokenChange={setToken}
          onAddConnection={handleAddConnection}
          onDeleteConnection={handleDeleteConnection}
          onSelectConnection={handleSelectConnection}
        />

        <CatalogSidebar
          connectionState={connectionState}
          connections={connections}
          activeConnectionId={activeConnectionId}
          filteredCount={visibleTables.length}
          groups={schemaGroups}
          isConnected={connectionState === "ready"}
          search={catalogSearch}
          selectedSchema={selectedSchema}
          selectedTableKey={selectedTableKey}
          status={status}
          tableCount={tables.length}
          themeMeta={themeMeta}
          vaultState={vaultState}
          onAddConnection={handleAddConnection}
          onConnectionOpen={() => setIsConnectionDialogOpen(true)}
          onSelectConnection={handleSelectConnection}
          onLockToken={() => void lockToken()}
          onPreviewTable={handlePreviewTable}
          onSearchChange={setCatalogSearch}
          onSelectSchema={handleSelectSchema}
          onThemeChange={() => setTheme(getNextTheme(theme))}
        />

        <PreviewWorkspace
          activeTab={activeTab}
          activeConnection={activeConnection}
          preview={preview}
          catalogTables={tables}
          schemaTables={selectedSchemaTables}
          selectedSchema={selectedSchema}
          selectedTable={selectedTable}
          onActiveTabChange={setActiveTab}
          onPreviewTable={handlePreviewTable}
          onSelectCatalog={handleSelectCatalog}
          onSelectSchema={handleSelectSchema}
        />
      </div>
    </main>
  );
}

type ConnectionDialogProps = {
  activeConnectionId: string;
  connectionMode: ConnectionMode;
  connectionState: ConnectionState;
  connectionName: string;
  connections: ConnectionProfile[];
  endpoint: string;
  hasSavedToken: boolean;
  message: Message;
  open: boolean;
  passphrase: string;
  rememberToken: boolean;
  token: string;
  vaultState: TokenVaultState;
  vaultSupported: boolean;
  onAddConnection: () => void;
  onCheckConnection: () => void;
  onConnectionModeChange: (mode: ConnectionMode) => void;
  onConnectionNameChange: (value: string) => void;
  onEndpointChange: (value: string) => void;
  onOpenChange: (open: boolean) => void;
  onPassphraseChange: (value: string) => void;
  onRememberTokenChange: (checked: boolean) => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
  onTokenChange: (value: string) => void;
  onDeleteConnection: (connection: ConnectionProfile) => void;
  onSelectConnection: (connection: ConnectionProfile) => void;
};

function ConnectionDialog({
  activeConnectionId,
  connectionMode,
  connectionState,
  connectionName,
  connections,
  endpoint,
  hasSavedToken,
  message,
  open,
  passphrase,
  rememberToken,
  token,
  vaultState,
  vaultSupported,
  onAddConnection,
  onCheckConnection,
  onConnectionModeChange,
  onConnectionNameChange,
  onEndpointChange,
  onOpenChange,
  onPassphraseChange,
  onRememberTokenChange,
  onSubmit,
  onTokenChange,
  onDeleteConnection,
  onSelectConnection,
}: ConnectionDialogProps): React.ReactElement {
  const isUnlockMode = connectionMode === "unlock" && hasSavedToken;
  const warningText = isUnlockMode || rememberToken
    ? "Encrypted at rest; available to browser code after unlock."
    : "Token is kept only until refresh.";
  const needsVaultPassphrase = (isUnlockMode || rememberToken) && vaultState !== "unlocked";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(900px,calc(100vw-2rem))] max-w-none" title="Connection" onOpenChange={onOpenChange}>
        <div className="border-b border-border px-4 py-3 pr-12">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-black">Catalog connections</h2>
            <Badge variant={isUnlockMode ? "warning" : rememberToken ? "success" : "outline"}>
              {isUnlockMode ? "Locked" : rememberToken ? "Encrypted" : "Memory only"}
            </Badge>
          </div>
        </div>

        <form className="grid min-h-[520px] sm:grid-cols-[240px_minmax(0,1fr)]" onSubmit={(event) => void onSubmit(event)}>
          <div className="flex min-h-0 flex-col border-b border-border bg-muted/35 p-3 sm:border-b-0 sm:border-r">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="text-xs font-semibold uppercase text-muted-foreground">Saved catalogs</span>
              <Button size="sm" type="button" variant="outline" onClick={onAddConnection}>
                <Plus />
                Add
              </Button>
            </div>
            <div className="grid max-h-44 gap-1 overflow-auto md:max-h-none">
              {connections.length > 0 ? (
                connections.map((connection) => (
                  <div
                    className={cn(
                      "group/connection grid min-h-12 grid-cols-[16px_minmax(0,1fr)_28px] items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm font-semibold text-muted-foreground hover:bg-background hover:text-foreground",
                      connection.id === activeConnectionId && "bg-background text-foreground shadow-xs",
                    )}
                    key={connection.id}
                  >
                    <Database className="size-3.5" />
                    <button
                      className="grid min-w-0 gap-0.5 text-left"
                      type="button"
                      onClick={() => onSelectConnection(connection)}
                    >
                      <span className="truncate text-foreground">{connection.name}</span>
                      <span className="truncate text-xs font-medium text-muted-foreground">
                        {formatEndpoint(connection.endpoint)}
                      </span>
                    </button>
                    <Button
                      aria-label={`Delete ${connection.name}`}
                      className="opacity-0 transition-opacity group-hover/connection:opacity-100 focus-visible:opacity-100"
                      size="icon"
                      title={`Delete ${connection.name}`}
                      type="button"
                      variant="quiet"
                      onClick={() => onDeleteConnection(connection)}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                ))
              ) : (
                <div className="rounded-md border border-dashed border-border p-3 text-sm font-medium text-muted-foreground">
                  Add your first catalog.
                </div>
              )}
            </div>
          </div>

          <div className="flex min-h-0 flex-col">
            <div className="grid gap-3 p-4">
              {hasSavedToken ? (
                <div className="grid grid-cols-2 gap-1 rounded-md border border-border bg-muted p-1">
                  <button
                    className={cn(
                      "h-8 rounded-sm text-sm font-semibold text-muted-foreground transition-colors hover:text-foreground",
                      isUnlockMode && "bg-background text-foreground shadow-xs",
                    )}
                    type="button"
                    onClick={() => onConnectionModeChange("unlock")}
                  >
                    Unlock saved
                  </button>
                  <button
                    className={cn(
                      "h-8 rounded-sm text-sm font-semibold text-muted-foreground transition-colors hover:text-foreground",
                      !isUnlockMode && "bg-background text-foreground shadow-xs",
                    )}
                    type="button"
                    onClick={() => onConnectionModeChange("paste")}
                  >
                    Use token
                  </button>
                </div>
              ) : null}

              <div className="grid gap-2 rounded-md border border-border bg-muted/45 p-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="grid gap-0.5">
                    <span className="flex items-center gap-2 text-sm font-semibold">
                      <LockKeyhole className="size-3.5 text-muted-foreground" />
                      Local vault
                    </span>
                    <span className="text-xs text-muted-foreground">
                      One passphrase unlocks saved tokens for all catalogs on this device.
                    </span>
                  </span>
                  <Badge variant={vaultState === "unlocked" ? "success" : hasSavedToken ? "warning" : "outline"}>
                    {vaultState === "unlocked" ? "Unlocked" : hasSavedToken ? "Locked" : "Not set"}
                  </Badge>
                </div>
                {needsVaultPassphrase ? (
                  <label className="grid gap-1.5">
                    <span className="text-xs font-semibold uppercase text-muted-foreground">Vault passphrase</span>
                    <Input
                      autoComplete={isUnlockMode ? "current-password" : "new-password"}
                      placeholder={isUnlockMode ? "Unlock local vault" : "At least 8 characters"}
                      type="password"
                      value={passphrase}
                      onChange={(event) => onPassphraseChange(event.target.value)}
                    />
                  </label>
                ) : null}
              </div>

              <div className="grid gap-3 sm:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
                <label className="grid gap-1.5">
                  <span className="flex items-center gap-2 text-xs font-semibold uppercase text-muted-foreground">
                    <Database className="size-3.5" />
                    Alias
                  </span>
                  <Input
                    autoComplete="off"
                    placeholder="Production"
                    spellCheck={false}
                    value={connectionName}
                    onChange={(event) => onConnectionNameChange(event.target.value)}
                  />
                </label>

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
              </div>

              {isUnlockMode ? null : (
                <>
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

                  <div className="grid gap-2 rounded-md border border-border bg-muted/45 p-3">
                    <label className="flex items-center justify-between gap-3">
                      <span className="grid gap-0.5">
                        <span className="text-sm font-semibold">Save token in local vault</span>
                        <span className="text-xs text-muted-foreground">
                          Uses the shared vault passphrase, not a per-catalog passphrase.
                        </span>
                      </span>
                      <Switch
                        checked={rememberToken}
                        disabled={!vaultSupported}
                        onCheckedChange={onRememberTokenChange}
                      />
                    </label>

                    {!vaultSupported ? (
                      <p className="text-xs font-medium text-destructive">
                        Encrypted token storage is unavailable in this browser.
                      </p>
                    ) : null}
                  </div>
                </>
              )}

              <Alert className="flex items-start gap-2" variant="warning">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <span>{warningText}</span>
              </Alert>

              {message.kind === "error" || connectionState === "connecting" ? (
                <Alert variant={message.kind}>{message.text}</Alert>
              ) : null}
            </div>

            <div className="mt-auto flex flex-wrap items-center justify-end gap-2 border-t border-border p-4">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button disabled={connectionState === "connecting"} type="button" variant="outline" onClick={onCheckConnection}>
              {connectionState === "connecting" ? <Loader2 className="animate-spin" /> : <Database />}
              Check connection
            </Button>
            <Button disabled={connectionState === "connecting"} type="submit">
              Save
            </Button>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type CatalogSidebarProps = {
  activeConnectionId: string;
  connectionState: ConnectionState;
  connections: ConnectionProfile[];
  filteredCount: number;
  groups: Array<[string, RemoteTable[]]>;
  isConnected: boolean;
  search: string;
  selectedSchema: string;
  selectedTableKey: string;
  status: ReturnType<typeof getStatusMeta>;
  tableCount: number;
  themeMeta: ReturnType<typeof getThemeMeta>;
  vaultState: TokenVaultState;
  onAddConnection: () => void;
  onConnectionOpen: () => void;
  onLockToken: () => void;
  onPreviewTable: (table: RemoteTable) => Promise<void>;
  onSearchChange: (value: string) => void;
  onSelectSchema: (schema: string) => void;
  onSelectConnection: (connection: ConnectionProfile) => void;
  onThemeChange: () => void;
};

function CatalogSidebar({
  activeConnectionId,
  connectionState,
  connections,
  filteredCount,
  groups,
  isConnected,
  search,
  selectedSchema,
  selectedTableKey,
  status,
  tableCount,
  themeMeta,
  vaultState,
  onAddConnection,
  onConnectionOpen,
  onLockToken,
  onPreviewTable,
  onSearchChange,
  onSelectSchema,
  onSelectConnection,
  onThemeChange,
}: CatalogSidebarProps): React.ReactElement {
  const vaultMeta = getVaultMeta(vaultState);
  const activeConnection = connections.find((connection) => connection.id === activeConnectionId) ?? null;

  return (
    <aside className="flex min-h-0 flex-col overflow-hidden border-r border-border bg-sidebar text-sidebar-foreground">
      <div className="border-b border-sidebar-border p-3">
        <div className="flex items-center gap-2">
          <div className="grid size-8 shrink-0 place-items-center rounded-md border border-border bg-card text-primary">
            <Database className="size-4.5" />
          </div>
          <h1 className="min-w-0 flex-1 truncate text-base font-black leading-5">quackalog</h1>
          <Badge variant="outline">{filteredCount}/{tableCount}</Badge>
          <Button aria-label="Add catalog" size="icon" title="Add catalog" type="button" variant="quiet" onClick={onAddConnection}>
            <Plus />
          </Button>
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
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-1">
        {connections.length === 0 ? (
          <EmptyCatalog onAddConnection={onAddConnection} />
        ) : groups.length === 0 ? (
          <ConnectionTree
            activeConnectionId={activeConnectionId}
            connections={connections}
            groups={groups}
            isConnected={isConnected}
            selectedSchema={selectedSchema}
            selectedTableKey={selectedTableKey}
            onPreviewTable={onPreviewTable}
            onSelectConnection={onSelectConnection}
            onSelectSchema={onSelectSchema}
          />
        ) : (
          <ConnectionTree
            activeConnectionId={activeConnectionId}
            connections={connections}
            groups={groups}
            isConnected={isConnected}
            selectedSchema={selectedSchema}
            selectedTableKey={selectedTableKey}
            onPreviewTable={onPreviewTable}
            onSelectConnection={onSelectConnection}
            onSelectSchema={onSelectSchema}
          />
        )}
      </div>

      <div className="flex min-h-9 shrink-0 items-center gap-1 border-t border-sidebar-border px-1.5 py-1">
        <span
          className={cn(
            "grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground",
            status.badgeVariant === "success" && "text-primary",
            status.badgeVariant === "warning" && "text-warning-foreground",
            status.badgeVariant === "destructive" && "text-destructive",
          )}
          title={status.label}
        >
          <status.Icon className={cn("size-3.5", connectionState === "connecting" && "animate-spin")} />
        </span>

        <Button
          aria-label="Catalog connections"
          className="min-w-0 flex-1 justify-start px-2"
          disabled={connectionState === "connecting"}
          size="sm"
          title={activeConnection ? `${activeConnection.name} · ${vaultMeta.label}` : "Catalog connections"}
          type="button"
          variant="quiet"
          onClick={onConnectionOpen}
        >
          <Settings2 />
          <span className="min-w-0 flex-1 truncate text-left">
            {activeConnection?.name ?? "Connections"}
          </span>
          <vaultMeta.Icon className="opacity-70" />
        </Button>

        {vaultState === "unlocked" ? (
          <Button
            aria-label="Lock token"
            size="icon"
            title="Lock token"
            type="button"
            variant="quiet"
            onClick={onLockToken}
          >
            <LockKeyhole />
          </Button>
        ) : null}
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

function ConnectionTree({
  activeConnectionId,
  connections,
  groups,
  isConnected,
  selectedSchema,
  selectedTableKey,
  onPreviewTable,
  onSelectConnection,
  onSelectSchema,
}: {
  activeConnectionId: string;
  connections: ConnectionProfile[];
  groups: Array<[string, RemoteTable[]]>;
  isConnected: boolean;
  selectedSchema: string;
  selectedTableKey: string;
  onPreviewTable: (table: RemoteTable) => Promise<void>;
  onSelectConnection: (connection: ConnectionProfile) => void;
  onSelectSchema: (schema: string) => void;
}): React.ReactElement {
  return (
    <div className="grid gap-1">
      {connections.map((connection) => {
        const isActive = connection.id === activeConnectionId;

        return (
          <details className="group/connection" key={connection.id} open={isActive}>
            <summary
              className={cn(
                "grid h-8 cursor-pointer list-none grid-cols-[14px_18px_minmax(0,1fr)_auto] items-center gap-2 rounded-md px-2 text-sm font-black outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring",
                isActive && "bg-sidebar-accent text-sidebar-accent-foreground",
              )}
              onClick={(event) => {
                if ((event.target as HTMLElement).closest("[data-connection-toggle]")) {
                  return;
                }

                event.preventDefault();
                onSelectConnection(connection);
              }}
            >
              <span data-connection-toggle>
                <ChevronRight className="size-3.5 text-muted-foreground transition-transform group-open/connection:rotate-90" />
              </span>
              <Database className="size-4 text-muted-foreground" />
              <span className="truncate" title={formatEndpoint(connection.endpoint)}>
                {connection.name || formatEndpoint(connection.endpoint)}
              </span>
              {isActive ? (
                <span className="rounded-sm bg-muted px-1.5 py-0.5 text-[0.68rem] font-bold leading-none text-muted-foreground">
                  {isConnected ? "active" : "locked"}
                </span>
              ) : null}
            </summary>

            {isActive ? (
              <div className="grid gap-0.5 pb-1 pl-4 pr-1">
                {!isConnected ? (
                  <div className="px-6 py-2 text-xs font-medium text-muted-foreground">Connect to load schemas.</div>
                ) : groups.length === 0 ? (
                  <div className="px-6 py-2 text-xs font-medium text-muted-foreground">No matching tables.</div>
                ) : (
                  groups.map(([schema, schemaTables]) => {
                    const isSchemaSelected = selectedSchema === schema;

                    return (
                      <details className="group/schema" key={schema} open>
                        <summary
                          className={cn(
                            "grid h-7 cursor-pointer list-none grid-cols-[14px_18px_minmax(0,1fr)_auto] items-center gap-2 rounded-md px-2 text-sm font-bold outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring",
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
                          <Server className="size-3.5 text-muted-foreground" />
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
            ) : null}
          </details>
        );
      })}
    </div>
  );
}

function EmptyCatalog({ onAddConnection }: { onAddConnection: () => void }): React.ReactElement {
  return (
    <div className="grid h-full place-items-center p-6">
      <div className="grid justify-items-center gap-3 text-center">
        <div className="grid size-10 place-items-center rounded-md bg-accent text-accent-foreground">
          <Database className="size-5" />
        </div>
        <div className="grid gap-1">
          <p className="text-sm font-semibold text-foreground">Add catalog</p>
          <p className="max-w-40 text-xs text-muted-foreground">Connect a Quack endpoint to browse schemas and tables.</p>
        </div>
        <Button size="sm" type="button" onClick={onAddConnection}>
          <Plus />
          Add catalog
        </Button>
      </div>
    </div>
  );
}

type PreviewWorkspaceProps = {
  activeTab: WorkspaceTab;
  activeConnection: ConnectionProfile | null;
  catalogTables: RemoteTable[];
  preview: PreviewState;
  schemaTables: RemoteTable[];
  selectedSchema: string;
  selectedTable: RemoteTable | null;
  onActiveTabChange: (tab: WorkspaceTab) => void;
  onPreviewTable: (table: RemoteTable) => Promise<void>;
  onSelectCatalog: () => void;
  onSelectSchema: (schema: string) => void;
};

function PreviewWorkspace({
  activeTab,
  activeConnection,
  catalogTables,
  preview,
  schemaTables,
  selectedSchema,
  selectedTable,
  onActiveTabChange,
  onPreviewTable,
  onSelectCatalog,
  onSelectSchema,
}: PreviewWorkspaceProps): React.ReactElement {
  const rowCount = preview.result?.rows.length ?? 0;
  const columnCount = preview.result?.columns.length ?? 0;
  const selectedTableType = selectedTable ? getDisplayTableType(selectedTable) : "";
  const isSchemaView = selectedSchema.length > 0;
  const isCatalogView = Boolean(activeConnection && !selectedSchema && !selectedTable);

  return (
    <section className="flex min-h-0 min-w-0 flex-col overflow-hidden bg-background">
      <div className="border-b border-border bg-card px-3 py-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            {isSchemaView && activeConnection ? (
              <nav aria-label="Schema location" className="flex min-w-0 items-center gap-1.5 text-lg font-black leading-6">
                <button
                  className="min-w-0 truncate rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  type="button"
                  onClick={onSelectCatalog}
                >
                  {activeConnection.name}
                </button>
                <span className="text-muted-foreground">/</span>
                <span className="min-w-0 truncate">{selectedSchema}</span>
              </nav>
            ) : selectedTable ? (
              <nav aria-label="Table location" className="flex min-w-0 items-center gap-1.5 text-lg font-black leading-6">
                {activeConnection ? (
                  <>
                    <button
                      className="min-w-0 truncate rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      type="button"
                      onClick={onSelectCatalog}
                    >
                      {activeConnection.name}
                    </button>
                    <span className="text-muted-foreground">/</span>
                  </>
                ) : null}
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
            ) : isCatalogView ? (
              <h2 className="truncate text-lg font-black leading-6">{activeConnection?.name}</h2>
            ) : (
              <h2 className="truncate text-lg font-black leading-6">Select a table</h2>
            )}
          </div>
          <div className="flex items-center gap-2">
            {isSchemaView ? (
              <Badge variant="outline">{schemaTables.length} tables</Badge>
            ) : isCatalogView ? (
              <Badge variant="outline">{catalogTables.length} tables</Badge>
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
        ) : isCatalogView ? (
          <CatalogTablesPanel tables={catalogTables} onPreviewTable={onPreviewTable} onSelectSchema={onSelectSchema} />
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

function CatalogTablesPanel({
  tables,
  onPreviewTable,
  onSelectSchema,
}: {
  tables: RemoteTable[];
  onPreviewTable: (table: RemoteTable) => Promise<void>;
  onSelectSchema: (schema: string) => void;
}): React.ReactElement {
  const groups = groupTablesBySchema(tables);

  if (tables.length === 0) {
    return <EmptyWorkspacePanel icon={Database} title="No tables" />;
  }

  return (
    <div className="h-full overflow-auto">
      <Table>
        <TableHeader className="sticky top-0 z-10 bg-card">
          <TableRow className="hover:bg-transparent">
            <TableHead className="w-12 text-right">#</TableHead>
            <TableHead>Schema</TableHead>
            <TableHead className="w-32 text-right">Tables</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {groups.map(([schema, schemaTables], index) => (
            <TableRow key={schema}>
              <TableCell className="text-right text-xs font-semibold text-muted-foreground">{index + 1}</TableCell>
              <TableCell>
                <button
                  className="flex max-w-full items-center gap-2 truncate text-left font-semibold transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  type="button"
                  onClick={() => onSelectSchema(schema)}
                >
                  <Server className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{schema}</span>
                </button>
              </TableCell>
              <TableCell className="text-right text-muted-foreground">
                <button
                  className="font-semibold transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  type="button"
                  onClick={() => void onPreviewTable(schemaTables[0])}
                >
                  {schemaTables.length}
                </button>
              </TableCell>
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

function readStoredConnections(): ConnectionProfile[] {
  try {
    const raw = window.localStorage.getItem(CONNECTIONS_KEY);
    const parsed = raw ? JSON.parse(raw) : null;

    if (Array.isArray(parsed)) {
      const connections = parsed.filter(isConnectionProfile);

      if (connections.length > 0) {
        return connections;
      }
    }
  } catch {
    // Ignore malformed persisted preferences.
  }

  const legacyEndpoint = readStoredString(ENDPOINT_KEY, DEFAULT_URI).trim();

  if (!legacyEndpoint) {
    return [];
  }

  return [
    {
      id: createConnectionId(),
      name: getConnectionAlias(legacyEndpoint),
      endpoint: legacyEndpoint,
    },
  ];
}

function writeStoredConnections(connections: ConnectionProfile[]): void {
  try {
    if (connections.length === 0) {
      window.localStorage.removeItem(CONNECTIONS_KEY);
    } else {
      window.localStorage.setItem(CONNECTIONS_KEY, JSON.stringify(connections));
    }
  } catch {
    // Local storage can be unavailable in privacy-restricted contexts.
  }
}

function readStoredActiveConnectionId(): string {
  return readStoredString(ACTIVE_CONNECTION_KEY, "");
}

function isConnectionProfile(value: unknown): value is ConnectionProfile {
  if (!value || typeof value !== "object") {
    return false;
  }

  const profile = value as Partial<ConnectionProfile>;

  return typeof profile.id === "string" && typeof profile.name === "string" && typeof profile.endpoint === "string";
}

function createConnectionId(): string {
  if (window.crypto?.randomUUID) {
    return window.crypto.randomUUID();
  }

  return `connection-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function getConnectionAlias(endpoint: string): string {
  const formatted = formatEndpoint(endpoint);
  const host = formatted.split(":")[0] || "catalog";

  return host.replace(/^ca-/, "").replace(/\..*$/, "") || "catalog";
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

function getStatusMeta(state: ConnectionState, duckDBState: DuckDBState): {
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

  if (duckDBState === "warming") {
    return { Icon: Loader2, badgeVariant: "warning", label: "Starting" };
  }

  if (duckDBState === "ready") {
    return { Icon: CheckCircle2, badgeVariant: "success", label: "DuckDB" };
  }

  if (duckDBState === "error") {
    return { Icon: XCircle, badgeVariant: "destructive", label: "DB error" };
  }

  return { Icon: Database, badgeVariant: "outline", label: "Idle" };
}

function getVaultMeta(state: TokenVaultState): {
  Icon: typeof ShieldCheck;
  badgeVariant: "outline" | "success" | "warning" | "destructive";
  label: string;
} {
  if (state === "locked") {
    return { Icon: LockKeyhole, badgeVariant: "warning", label: "Locked" };
  }

  if (state === "unlocked") {
    return { Icon: ShieldCheck, badgeVariant: "success", label: "Unlocked" };
  }

  if (state === "memory") {
    return { Icon: KeyRound, badgeVariant: "outline", label: "Memory only" };
  }

  return { Icon: ShieldCheck, badgeVariant: "outline", label: "No saved token" };
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
