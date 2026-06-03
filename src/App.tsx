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
  History,
  KeyRound,
  LockKeyhole,
  Loader2,
  Monitor,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
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
  type ColumnStat,
  type ColumnDetail,
  type DucklakeMetadata,
  type SnapshotRow,
  QuackClient,
  type RemoteTable,
  stringifyCell,
  tableKey,
  warmDuckDB,
} from "@/lib/quack-client";
import { loadRuntimeCatalogConfig, type RuntimeCatalog } from "@/lib/runtime-config";
import { readStoredString, writeStoredString } from "@/lib/storage";
import {
  forgetTokenVaultRecord,
  forgetTokenVaultSession,
  hasTokenVaultRecord,
  isTokenVaultSupported,
  isTokenVaultSessionExpired,
  saveEncryptedToken,
  unlockEncryptedToken,
  writeTokenVaultSession,
} from "@/lib/token-vault";
import { cn } from "@/lib/utils";

type ConnectionState = "idle" | "connecting" | "ready" | "error";
type DuckDBState = "idle" | "warming" | "ready" | "error";
type TokenVaultState = "absent" | "memory" | "locked" | "unlocked";
type ConnectionMode = "paste" | "unlock";
type MessageKind = "info" | "success" | "warning" | "error";
type ThemeMode = "light" | "dark" | "system";
type WorkspaceTab = "preview" | "columns" | "metadata" | "history";

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

type BootstrapConnection = {
  name: string;
  endpoint: string;
};

type CatalogRoute = {
  catalog: string;
  schema?: string;
  tab?: WorkspaceTab;
  table?: string;
};

type DucklakeMetadataSummary = {
  columnTags: PreviewRow[];
  columns: PreviewRow[];
  currentFileCount: number;
  dataFiles: PreviewRow[];
  deleteFiles: PreviewRow[];
  historicalFileCount: number;
  partitionColumns: PreviewRow[];
  partitionValues: PreviewRow[];
  schemaVersions: PreviewRow[];
  snapshotChanges: PreviewRow[];
  snapshots: PreviewRow[];
  sortExpressions: PreviewRow[];
  tableId: number | null;
  totalFileBytes: number;
};

const DEFAULT_URI = import.meta.env.VITE_QUACK_URI || "";
const DEV_TOKEN = import.meta.env.DEV ? import.meta.env.VITE_QUACK_TOKEN || "" : "";
const ENDPOINT_KEY = "quackalog.endpoint";
const CONNECTIONS_KEY = "quackalog.connections";
const ACTIVE_CONNECTION_KEY = "quackalog.active-connection";
const THEME_KEY = "quackalog.theme";
const SIDEBAR_COLLAPSED_KEY = "quackalog.sidebar-collapsed";
const SIDEBAR_WIDTH_KEY = "quackalog.sidebar-width";
const VAULT_TTL_KEY = "quackalog.vault-ttl-minutes";
const SIDEBAR_MIN_WIDTH = 200;
const SIDEBAR_MAX_WIDTH = 500;
const SIDEBAR_DEFAULT_WIDTH = 300;
const DEFAULT_VAULT_TTL_MINUTES = 30;
const VAULT_TTL_OPTIONS = [15, 30, 60, 120];
const WORKSPACE_TABS: Array<{ id: WorkspaceTab; label: string; Icon: typeof Table2 }> = [
  { id: "preview", label: "Preview", Icon: Rows3 },
  { id: "columns", label: "Columns", Icon: Table2 },
  { id: "metadata", label: "Metadata", Icon: Database },
  { id: "history", label: "History", Icon: History },
];

export function App(): React.ReactElement {
  const clientRef = useRef<QuackClient | null>(null);
  const previewRunRef = useRef(0);
  const lockTimerRef = useRef<number | null>(null);
  const autoConnectRef = useRef(false);
  const bootstrappedConnectionRef = useRef(false);
  const routeAppliedRef = useRef("");
  const [connections, setConnections] = useState<ConnectionProfile[]>(() => readStoredConnections());
  const [activeConnectionId, setActiveConnectionId] = useState(() => readStoredActiveConnectionId());
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => readStoredString(SIDEBAR_COLLAPSED_KEY, "true") === "true");
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const stored = Number(readStoredString(SIDEBAR_WIDTH_KEY, String(SIDEBAR_DEFAULT_WIDTH)));
    return Number.isFinite(stored) && stored >= SIDEBAR_MIN_WIDTH && stored <= SIDEBAR_MAX_WIDTH ? stored : SIDEBAR_DEFAULT_WIDTH;
  });
  const [isResizing, setIsResizing] = useState(false);
  const sidebarWidthRef = useRef(sidebarWidth);
  sidebarWidthRef.current = sidebarWidth;
  const [isCreatingConnection, setIsCreatingConnection] = useState(false);
  const [connectionName, setConnectionName] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [theme, setTheme] = useState<ThemeMode>(() => parseTheme(readStoredString(THEME_KEY, "system")));
  const [token, setToken] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [vaultSecret, setVaultSecret] = useState("");
  const [rememberToken, setRememberToken] = useState(false);
  const [vaultTtlMinutes, setVaultTtlMinutes] = useState(() => readStoredVaultTtlMinutes());
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
  const [routeRevision, setRouteRevision] = useState(0);
  const [isConnectionDialogOpen, setIsConnectionDialogOpen] = useState(() => connections.length === 0);
  const [isUnlockDialogOpen, setIsUnlockDialogOpen] = useState(false);
  const [preview, setPreview] = useState<PreviewState>({
    isLoading: false,
    table: null,
    result: null,
  });
  const [ducklakeStats, setDucklakeStats] = useState<ColumnStat[]>([]);
  const [ducklakeColumns, setDucklakeColumns] = useState<ColumnDetail[]>([]);
  const [ducklakeMetaLoading, setDucklakeMetaLoading] = useState(false);
  const [ducklakeSnapshots, setDucklakeSnapshots] = useState<SnapshotRow[]>([]);
  const [ducklakeMetadata, setDucklakeMetadata] = useState<DucklakeMetadata | null>(null);
  const vaultSupported = isTokenVaultSupported();

  useEffect(() => {
    writeStoredConnections(connections);
  }, [connections]);

  useEffect(() => {
    writeStoredString(ACTIVE_CONNECTION_KEY, isCreatingConnection ? "" : activeConnectionId);
  }, [activeConnectionId, isCreatingConnection]);

  useEffect(() => {
    writeStoredString(VAULT_TTL_KEY, String(vaultTtlMinutes));
  }, [vaultTtlMinutes]);

  useEffect(() => {
    if (vaultState !== "unlocked" || !activeConnectionId) {
      return;
    }

    writeTokenVaultSession(activeConnectionId, getVaultTtlMs(vaultTtlMinutes));
    startLockTimer();
  }, [vaultTtlMinutes]);

  useEffect(() => {
    const bootstrap = readBootstrapConnection();

    if (!bootstrap) {
      return;
    }

    bootstrappedConnectionRef.current = true;
    const current = readStoredConnections();
    const existing = current.find((connection) => connection.endpoint === bootstrap.endpoint);
    const profile = {
      id: existing?.id ?? `bootstrap-${hashString(bootstrap.endpoint)}`,
      name: bootstrap.name,
      endpoint: bootstrap.endpoint,
    };
    const next = existing
      ? current.map((connection) => (connection.id === existing.id ? profile : connection))
      : [...current, profile];
    const hasSavedToken = hasTokenVaultRecord(profile.id);

    setIsCreatingConnection(false);
    setConnections(next);
    writeStoredConnections(next);
    writeStoredString(ACTIVE_CONNECTION_KEY, profile.id);
    setActiveConnectionId(profile.id);
    setConnectionName(profile.name);
    setEndpoint(profile.endpoint);
    setSavedTokenExists(hasSavedToken);
    setConnectionMode(hasSavedToken ? "unlock" : "paste");
    setVaultState(hasSavedToken ? "locked" : "absent");
    setMessage({
      kind: "info",
      text: DEV_TOKEN
        ? `Loaded ${profile.name}. Connecting with the local dev token.`
        : `Loaded ${profile.name}. Add a token to connect.`,
    });
    setIsConnectionDialogOpen(!DEV_TOKEN);

    removeBootstrapConnectionParams();
  }, []);

  useEffect(() => {
    let cancelled = false;

    void loadRuntimeCatalogConfig().then((config) => {
      if (cancelled || config.catalogs.length === 0 || bootstrappedConnectionRef.current) {
        return;
      }

      const current = readStoredConnections();
      const next = mergeRuntimeCatalogs(current, config.catalogs);
      const activeFromConfig = config.activeCatalog
        ? next.find((connection) => connection.id === config.activeCatalog || connection.name === config.activeCatalog)
        : null;
      const activeStillExists = next.some((connection) => connection.id === activeConnectionId);
      const nextActive = activeFromConfig ?? (activeStillExists ? next.find((connection) => connection.id === activeConnectionId) : null) ?? next[0];

      setConnections(next);
      writeStoredConnections(next);
      setIsCreatingConnection(false);
      setIsConnectionDialogOpen(false);

      if (nextActive) {
        writeStoredString(ACTIVE_CONNECTION_KEY, nextActive.id);
        setActiveConnectionId(nextActive.id);
        setConnectionName(nextActive.name);
        setEndpoint(nextActive.endpoint);
        setSavedTokenExists(hasTokenVaultRecord(nextActive.id));
        setConnectionMode(hasTokenVaultRecord(nextActive.id) ? "unlock" : "paste");
        setVaultState(hasTokenVaultRecord(nextActive.id) ? "locked" : "absent");
      }

      setMessage({
        kind: "info",
        text: `Loaded ${config.catalogs.length} ${config.catalogs.length === 1 ? "catalog" : "catalogs"} from local config.`,
      });
      tryAutoConnect();
    });

    return () => {
      cancelled = true;
    };
  }, []);

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
    const activeConnection = connections.find((connection) => connection.id === activeConnectionId) ?? null;

    if (!activeConnection || isCreatingConnection || vaultSecret || !hasTokenVaultRecord(activeConnection.id)) {
      return;
    }

    setIsUnlockDialogOpen(true);
    setMessage({
      kind: "info",
      text: isTokenVaultSessionExpired(activeConnection.id)
        ? "Vault session expired. Enter your passphrase to reconnect."
        : "Enter your passphrase to unlock the saved token.",
    });
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
          tryAutoConnect();
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


  useEffect(() => {
    if (!isResizing) {
      return;
    }

    const onMouseMove = (event: MouseEvent): void => {
      setSidebarWidth(Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, event.clientX)));
    };

    const onMouseUp = (): void => {
      setIsResizing(false);
      writeStoredString(SIDEBAR_WIDTH_KEY, String(sidebarWidthRef.current));
      document.body.classList.remove("select-none", "cursor-col-resize");
    };

    document.body.classList.add("select-none", "cursor-col-resize");
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);

    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.classList.remove("select-none", "cursor-col-resize");
    };
  }, [isResizing]);

  useEffect(() => {
    const onPopState = (): void => {
      setRouteRevision((current) => current + 1);
    };

    window.addEventListener("popstate", onPopState);

    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    const route = readCatalogRoute();

    if (!route) {
      routeAppliedRef.current = "";

      if (routeRevision > 0) {
        handleSelectCatalog({ updateUrl: false });
      }

      return;
    }

    if (connections.length === 0) {
      return;
    }

    const matchedConnection = findConnectionForRoute(connections, route.catalog);

    if (!matchedConnection) {
      return;
    }

    if (matchedConnection.id !== activeConnectionId) {
      setIsCreatingConnection(false);
      closeActiveClientForSwitch();
      setActiveConnectionId(matchedConnection.id);
      setConnectionName(matchedConnection.name);
      setEndpoint(matchedConnection.endpoint);
      return;
    }

    if (!route.schema) {
      const routeKey = `catalog:${matchedConnection.id}:${route.tab ?? ""}`;

      if (routeAppliedRef.current !== routeKey) {
        routeAppliedRef.current = routeKey;
        if (route.tab) setActiveTab(route.tab);
        handleSelectCatalog({ updateUrl: false });
      }

      return;
    }

    if (!route.table) {
      const routeKey = `schema:${matchedConnection.id}:${route.schema}:${route.tab ?? ""}`;

      if (routeAppliedRef.current !== routeKey && tables.some((table) => table.table_schema === route.schema)) {
        routeAppliedRef.current = routeKey;
        if (route.tab) setActiveTab(route.tab);
        handleSelectSchema(route.schema, { updateUrl: false });
      }

      return;
    }

    if (!clientRef.current || connectionState !== "ready") {
      return;
    }

    const routeKey = `table:${matchedConnection.id}:${route.schema}:${route.table}:${route.tab ?? ""}`;

    if (routeAppliedRef.current === routeKey) {
      return;
    }

    const routeTable = tables.find((table) => table.table_schema === route.schema && table.table_name === route.table);

    if (routeTable) {
      routeAppliedRef.current = routeKey;
      if (route.tab) setActiveTab(route.tab);
      void handlePreviewTable(routeTable, { tab: route.tab, updateUrl: false });
    }
  }, [activeConnectionId, connectionState, connections, routeRevision, tables]);

  function tryAutoConnect(): void {
    if (autoConnectRef.current) {
      return;
    }

    const savedConnectionId = readStoredActiveConnectionId();
    const savedConnections = readStoredConnections();
    const profile = savedConnections.find((c) => c.id === savedConnectionId);

    if (!profile || !DEV_TOKEN || hasTokenVaultRecord(profile.id)) {
      return;
    }

    autoConnectRef.current = true;
    setConnectionState("connecting");
    setMessage({ kind: "info", text: `Connecting to ${profile.name}.` });

    QuackClient.create(profile.endpoint, DEV_TOKEN)
      .then((client) => {
        clientRef.current = client;
        return client.listTables();
      })
      .then((remoteTables) => {
        setConnectionState("ready");
        setTables(remoteTables);
        setMessage({ kind: "success", text: `Connected to ${profile.name}.` });
      })
      .catch((error: unknown) => {
        clientRef.current = null;
        setConnectionState("idle");
        setMessage({ kind: "error", text: formatError(error) });
      });
  }

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
  function handleActiveTabChange(tab: WorkspaceTab): void {
    setActiveTab(tab);

    if (activeConnection) {
      const route = readCatalogRoute() ?? {
        catalog: activeConnection.name || activeConnection.id,
        schema: selectedSchema || selectedTable?.table_schema,
        table: selectedTable?.table_name,
      };

      writeCatalogRoute({ ...route, tab });
    }
  }

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

    const connected = await establishConnection(profile);

    if (connected) {
      setIsConnectionDialogOpen(false);
    }
  }

  async function establishConnection(profile: ConnectionProfile, mode: ConnectionMode = connectionMode): Promise<boolean> {
    clearLockTimer();
    previewRunRef.current += 1;
    void clientRef.current?.close();
    clientRef.current = null;
    setConnectionState("connecting");
    setTables([]);
    setSelectedSchema("");
    setSelectedTableKey("");
    setActiveTab("preview");
    setPreview({ isLoading: false, table: null, result: null });

    let secret: string;

    if (mode === "unlock") {
      const secretPassphrase = vaultSecret || passphrase;

      if (!secretPassphrase) {
        setConnectionState("idle");
        setMessage({ kind: "info", text: `Saved ${profile.name}. Enter your passphrase to connect.` });
        return false;
      }

      try {
        secret = await unlockEncryptedToken(secretPassphrase, profile.id);
        setVaultSecret(secretPassphrase);
        setVaultState("unlocked");
        writeTokenVaultSession(profile.id, getVaultTtlMs(vaultTtlMinutes));
        startLockTimer();
      } catch (error) {
        setConnectionState("error");
        setMessage({ kind: "error", text: formatError(error) });
        return false;
      }
    } else {
      secret = token.trim() || DEV_TOKEN;

      if (!secret) {
        setConnectionState("idle");
        setMessage({ kind: "error", text: "Enter a token before saving." });
        return false;
      }
    }

    try {
      const client = await QuackClient.create(profile.endpoint, secret);
      clientRef.current = client;
      const remoteTables = await client.listTables();
      setConnectionState("ready");
      setTables(remoteTables);
      setMessage({
        kind: "success",
        text: `Connected to ${profile.name}. Found ${remoteTables.length} ${remoteTables.length === 1 ? "table" : "tables"}.`,
      });
      setPassphrase("");
      setToken("");
      return true;
    } catch (error) {
      clientRef.current = null;
      setConnectionState("error");
      setMessage({ kind: "error", text: formatError(error) });
      return false;
    }
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

  async function handleUnlockDialogSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    const profile = activeConnection;

    if (!profile) {
      setMessage({ kind: "error", text: "Select a catalog before unlocking the vault." });
      return;
    }

    setConnectionMode("unlock");
    const connected = await establishConnection(profile, "unlock");

    if (connected) {
      setIsUnlockDialogOpen(false);
      setIsConnectionDialogOpen(false);
    }
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
      writeTokenVaultSession(profile.id, getVaultTtlMs(vaultTtlMinutes));
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
    setIsUnlockDialogOpen(hasSavedToken && !vaultSecret);
    setIsConnectionDialogOpen(!hasSavedToken || Boolean(vaultSecret));
  }

  function handleDeleteConnection(connection: ConnectionProfile): void {
    forgetTokenVaultRecord(connection.id);
    forgetTokenVaultSession(connection.id);
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

  function handleForgetActiveToken(): void {
    if (!activeConnectionId) {
      return;
    }

    forgetTokenVaultRecord(activeConnectionId);
    forgetTokenVaultSession(activeConnectionId);
    clearLockTimer();
    setVaultSecret("");
    setPassphrase("");
    setSavedTokenExists(false);
    setVaultState("absent");
    setConnectionMode("paste");
    setIsUnlockDialogOpen(false);
    setMessage({ kind: "success", text: "Forgot the saved encrypted token for this catalog." });
  }

  function handleToggleSidebar(): void {
    setSidebarCollapsed((current) => {
      const next = !current;
      writeStoredString(SIDEBAR_COLLAPSED_KEY, String(next));
      return next;
    });
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
      writeTokenVaultSession(profile.id, getVaultTtlMs(vaultTtlMinutes));
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
    if (activeConnectionId) {
      forgetTokenVaultSession(activeConnectionId);
    }
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
    setIsConnectionDialogOpen(false);
    setIsUnlockDialogOpen(options.keepDialogClosed ? false : hasSavedToken);
  }

  function clearLockTimer(): void {
    if (lockTimerRef.current !== null) {
      window.clearTimeout(lockTimerRef.current);
      lockTimerRef.current = null;
    }
  }

  function startLockTimer(): void {
    clearLockTimer();
    const ttlMs = getVaultTtlMs(vaultTtlMinutes);

    if (ttlMs === null) {
      return;
    }

    lockTimerRef.current = window.setTimeout(() => {
      void lockToken();
    }, ttlMs);
  }

  function touchTokenSession(): void {
    if (vaultState === "unlocked") {
      if (activeConnectionId) {
        writeTokenVaultSession(activeConnectionId, getVaultTtlMs(vaultTtlMinutes));
      }
      startLockTimer();
    }
  }

  async function handlePreviewTable(table: RemoteTable, options: { tab?: WorkspaceTab; updateUrl?: boolean } = {}): Promise<void> {
    const client = clientRef.current;

    if (!client) {
      setMessage({ kind: "error", text: "Connect before previewing a table." });
      return;
    }

    touchTokenSession();
    if (options.updateUrl !== false && activeConnection) {
      writeCatalogRoute({
        catalog: activeConnection.name || activeConnection.id,
        schema: table.table_schema,
        tab: options.tab ?? "preview",
        table: table.table_name,
      });
    }
    await previewTableWithClient(client, table, options.tab);
  }

  function handleSelectSchema(schema: string, options: { updateUrl?: boolean } = {}): void {
    touchTokenSession();
    const schemaTableCount = tables.filter((table) => table.table_schema === schema).length;

    if (options.updateUrl !== false && activeConnection) {
      writeCatalogRoute({
        catalog: activeConnection.name || activeConnection.id,
        schema,
      });
    }

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

  function handleSelectCatalog(options: { updateUrl?: boolean } = {}): void {
    touchTokenSession();
    if (options.updateUrl !== false && activeConnection) {
      writeCatalogRoute({ catalog: activeConnection.name || activeConnection.id });
    }
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

  async function previewTableWithClient(client: QuackClient, table: RemoteTable, tab: WorkspaceTab = "preview"): Promise<void> {
    const runId = previewRunRef.current + 1;
    previewRunRef.current = runId;
    const isDucklake = table.table_type !== "INTERNAL";
    setSelectedSchema("");
    setSelectedTableKey(tableKey(table));
    setActiveTab(tab);
    setPreview({ isLoading: true, table, result: null });
    setDucklakeStats([]);
    setDucklakeColumns([]);
    setDucklakeSnapshots([]);
    setDucklakeMetadata(null);
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
      return;
    }

    if (!isDucklake) {
      return;
    }

    setDucklakeMetaLoading(true);

    const results = await Promise.allSettled([
      client.getTableStats(table.table_schema, table.table_name),
      client.getColumnDetails(table.table_schema, table.table_name),
      client.getSnapshotHistory(table.table_schema, table.table_name),
      client.getDucklakeMetadata(table.table_schema, table.table_name),
    ]);

    if (previewRunRef.current !== runId) {
      return;
    }

    const [statsResult, columnsResult, snapshotsResult, metadataResult] = results;

    if (statsResult.status === "fulfilled") setDucklakeStats(statsResult.value);
    if (columnsResult.status === "fulfilled") setDucklakeColumns(columnsResult.value);
    if (snapshotsResult.status === "fulfilled") setDucklakeSnapshots(snapshotsResult.value);
    if (metadataResult.status === "fulfilled") setDucklakeMetadata(metadataResult.value);

    setDucklakeMetaLoading(false);
  }

  return (
    <main className="h-dvh overflow-hidden bg-background text-foreground">
      <div
        className="grid h-full min-h-0 overflow-hidden"
        style={{
          gridTemplateColumns: sidebarCollapsed ? "48px minmax(0,1fr)" : `${sidebarWidth}px 6px minmax(0,1fr)`,
        }}
      >
        <UnlockVaultDialog
          activeConnection={activeConnection}
          connectionState={connectionState}
          open={isUnlockDialogOpen}
          passphrase={passphrase}
          sessionExpired={activeConnectionId ? isTokenVaultSessionExpired(activeConnectionId) : false}
          ttlMinutes={vaultTtlMinutes}
          onOpenChange={setIsUnlockDialogOpen}
          onPassphraseChange={setPassphrase}
          onSubmit={handleUnlockDialogSubmit}
        />

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
          vaultTtlMinutes={vaultTtlMinutes}
          vaultState={vaultState}
          vaultSupported={vaultSupported}
          activeConnectionId={activeConnectionId}
          onConnectionModeChange={setConnectionMode}
          onConnectionNameChange={setConnectionName}
          onEndpointChange={setEndpoint}
          onOpenChange={setIsConnectionDialogOpen}
          onPassphraseChange={setPassphrase}
          onRememberTokenChange={setRememberToken}
          onVaultTtlMinutesChange={setVaultTtlMinutes}
          onForgetToken={handleForgetActiveToken}
          onCheckConnection={() => void handleCheckConnection()}
          onSubmit={handleSaveConnection}
          onTokenChange={setToken}
          onAddConnection={handleAddConnection}
          onDeleteConnection={handleDeleteConnection}
          onSelectConnection={handleSelectConnection}
        />

        <CatalogSidebar
          collapsed={sidebarCollapsed}
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
          onSelectCatalog={handleSelectCatalog}
          onLockToken={() => void lockToken()}
          onPreviewTable={handlePreviewTable}
          onSearchChange={setCatalogSearch}
          onSelectSchema={handleSelectSchema}
          onThemeChange={() => setTheme(getNextTheme(theme))}
          onToggleSidebar={handleToggleSidebar}
        />

        {!sidebarCollapsed ? (
          <div
            className="group/handle relative z-10 w-full cursor-col-resize"
            onMouseDown={() => setIsResizing(true)}
          >
            <div className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border transition-colors group-hover/handle:bg-primary/40" />
          </div>
        ) : null}

        <PreviewWorkspace
          activeTab={activeTab}
          activeConnection={activeConnection}
          preview={preview}
          catalogTables={tables}
          schemaTables={selectedSchemaTables}
          selectedSchema={selectedSchema}
          selectedTable={selectedTable}
          ducklakeStats={ducklakeStats}
          ducklakeColumns={ducklakeColumns}
          ducklakeMetadata={ducklakeMetadata}
          ducklakeMetaLoading={ducklakeMetaLoading}
          ducklakeSnapshots={ducklakeSnapshots}
          onActiveTabChange={handleActiveTabChange}
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
  vaultTtlMinutes: number;
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
  onForgetToken: () => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
  onTokenChange: (value: string) => void;
  onVaultTtlMinutesChange: (value: number) => void;
  onDeleteConnection: (connection: ConnectionProfile) => void;
  onSelectConnection: (connection: ConnectionProfile) => void;
};

function UnlockVaultDialog({
  activeConnection,
  connectionState,
  open,
  passphrase,
  sessionExpired,
  ttlMinutes,
  onOpenChange,
  onPassphraseChange,
  onSubmit,
}: {
  activeConnection: ConnectionProfile | null;
  connectionState: ConnectionState;
  open: boolean;
  passphrase: string;
  sessionExpired: boolean;
  ttlMinutes: number;
  onOpenChange: (open: boolean) => void;
  onPassphraseChange: (value: string) => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
}): React.ReactElement {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(420px,calc(100vw-2rem))] max-w-none" title="Unlock vault" onOpenChange={onOpenChange}>
        <form className="grid gap-4 p-4" onSubmit={(event) => void onSubmit(event)}>
          <div className="flex items-start gap-3">
            <div className="grid size-9 shrink-0 place-items-center rounded-md bg-accent text-accent-foreground">
              <LockKeyhole className="size-4.5" />
            </div>
            <div className="min-w-0">
              <h2 className="text-base font-black">Unlock local vault</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {sessionExpired
                  ? "Your unlock session expired. Enter your passphrase to reconnect."
                  : "Enter your passphrase to reconnect with the saved encrypted token."}
              </p>
            </div>
          </div>

          {activeConnection ? (
            <div className="grid gap-1 rounded-md border border-border bg-muted/35 p-3">
              <div className="truncate text-sm font-bold">{activeConnection.name}</div>
              <div className="truncate text-xs font-medium text-muted-foreground">{formatEndpoint(activeConnection.endpoint)}</div>
            </div>
          ) : null}

          <label className="grid gap-1.5">
            <span className="text-xs font-semibold uppercase text-muted-foreground">Passphrase</span>
            <Input
              autoComplete="current-password"
              autoFocus
              placeholder="Unlock saved token"
              type="password"
              value={passphrase}
              onChange={(event) => onPassphraseChange(event.target.value)}
            />
          </label>

          <Alert className="flex items-start gap-2" variant="info">
            <ShieldCheck className="mt-0.5 size-4 shrink-0" />
            <span>Unlocked tokens stay in this browser tab until {ttlMinutes < 60 ? `${ttlMinutes} minutes` : `${ttlMinutes / 60} hours`} of idle time or refresh.</span>
          </Alert>

          <div className="flex justify-end gap-2 border-t border-border pt-3">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button disabled={connectionState === "connecting" || !activeConnection} type="submit">
              {connectionState === "connecting" ? <Loader2 className="animate-spin" /> : <LockKeyhole />}
              Unlock and connect
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

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
  vaultTtlMinutes,
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
  onForgetToken,
  onSubmit,
  onTokenChange,
  onVaultTtlMinutesChange,
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
                {hasSavedToken ? (
                  <div className="flex items-center justify-between gap-3 rounded-md bg-background px-2.5 py-2">
                    <span className="text-xs font-medium text-muted-foreground">Saved encrypted token on this device</span>
                    <Button size="sm" type="button" variant="quiet" onClick={onForgetToken}>
                      <Trash2 />
                      Forget
                    </Button>
                  </div>
                ) : null}
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
                <div className="grid gap-1.5">
                  <span className="text-xs font-semibold uppercase text-muted-foreground">Idle lock</span>
                  <div className="grid grid-cols-4 gap-1 rounded-md border border-border bg-background p-1">
                    {VAULT_TTL_OPTIONS.map((minutes) => (
                      <button
                        className={cn(
                          "h-7 rounded-sm text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground",
                          vaultTtlMinutes === minutes && "bg-muted text-foreground shadow-xs",
                        )}
                        key={minutes}
                        type="button"
                        onClick={() => onVaultTtlMinutesChange(minutes)}
                      >
                        {minutes < 60 ? `${minutes}m` : `${minutes / 60}h`}
                      </button>
                    ))}
                  </div>
                  <span className="text-xs text-muted-foreground">
                    After a refresh, unlock still needs your passphrase because the decrypted token is memory-only.
                  </span>
                </div>
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

              {message.text ? (
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
  collapsed: boolean;
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
  onSelectCatalog: () => void;
  onSelectSchema: (schema: string) => void;
  onSelectConnection: (connection: ConnectionProfile) => void;
  onThemeChange: () => void;
  onToggleSidebar: () => void;
};

function CatalogSidebar({
  activeConnectionId,
  collapsed,
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
  onSelectCatalog,
  onSelectSchema,
  onSelectConnection,
  onThemeChange,
  onToggleSidebar,
}: CatalogSidebarProps): React.ReactElement {
  const vaultMeta = getVaultMeta(vaultState);
  const activeConnection = connections.find((connection) => connection.id === activeConnectionId) ?? null;

  if (collapsed) {
    return (
      <aside className="flex min-h-0 flex-col items-center gap-2 overflow-hidden border-r border-border bg-sidebar text-sidebar-foreground py-2">
        <Button aria-label="Expand sidebar" size="icon" title="Expand sidebar" type="button" variant="quiet" onClick={onToggleSidebar}>
          <PanelLeftOpen className="size-4" />
        </Button>

        <div className="border-b border-sidebar-border w-6" />

        <div className="grid size-8 shrink-0 place-items-center rounded-md border border-border bg-card text-primary">
          <Database className="size-4" />
        </div>

        <Button aria-label="Add catalog" size="icon" title="Add catalog" type="button" variant="quiet" onClick={onAddConnection}>
          <Plus className="size-4" />
        </Button>

        <div className="flex-1" />

        <Button
          aria-label="Catalog connections"
          disabled={connectionState === "connecting"}
          size="icon"
          title={activeConnection ? `${activeConnection.name} · ${vaultMeta.label}` : "Catalog connections"}
          type="button"
          variant="quiet"
          onClick={onConnectionOpen}
        >
          <Settings2 className="size-4" />
        </Button>

        <span
          className={cn(
            "grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground",
            status.badgeVariant === "success" && "text-success-foreground-muted",
            status.badgeVariant === "warning" && "text-warning-foreground-muted",
            status.badgeVariant === "destructive" && "text-danger",
          )}
          title={status.label}
        >
          <status.Icon className={cn("size-3.5", connectionState === "connecting" && "animate-spin")} />
        </span>

        <Button
          aria-label={`Theme: ${themeMeta.label}`}
          size="icon"
          title={`Theme: ${themeMeta.label}`}
          type="button"
          variant="quiet"
          onClick={onThemeChange}
        >
          <themeMeta.Icon className="size-4" />
        </Button>
      </aside>
    );
  }

  return (
    <aside className="flex min-h-0 flex-col overflow-hidden border-r border-border bg-sidebar text-sidebar-foreground">
      <div className="flex items-center gap-2 border-b border-sidebar-border p-3">
        <div className="grid size-8 shrink-0 place-items-center rounded-md border border-border bg-card text-primary">
          <Database className="size-4.5" />
        </div>
        <h1 className="min-w-0 flex-1 truncate text-base font-black leading-5">quackalog</h1>
        <Badge variant="outline">{filteredCount}/{tableCount}</Badge>
        <Button aria-label="Add catalog" size="icon" title="Add catalog" type="button" variant="quiet" onClick={onAddConnection}>
          <Plus />
        </Button>
        <Button aria-label="Collapse sidebar" size="icon" title="Collapse sidebar" type="button" variant="quiet" onClick={onToggleSidebar}>
          <PanelLeftClose className="size-4" />
        </Button>
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
            onSelectCatalog={onSelectCatalog}
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
            onSelectCatalog={onSelectCatalog}
            onSelectConnection={onSelectConnection}
            onSelectSchema={onSelectSchema}
          />
        )}
      </div>

      <div className="flex min-h-9 shrink-0 items-center gap-1 border-t border-sidebar-border px-1.5 py-1">
        <span
          className={cn(
            "grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground",
            status.badgeVariant === "success" && "text-success-foreground-muted",
            status.badgeVariant === "warning" && "text-warning-foreground-muted",
            status.badgeVariant === "destructive" && "text-danger",
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
  onSelectCatalog,
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
  onSelectCatalog: () => void;
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
                event.preventDefault();

                if (isActive) {
                  onSelectCatalog();
                  return;
                }

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
                <span
                  className={cn(
                    "rounded-sm px-1.5 py-0.5 text-[0.68rem] font-bold leading-none",
                    isConnected ? "bg-success-muted text-success-foreground-muted" : "bg-muted text-muted-foreground",
                  )}
                >
                  {isConnected ? "active" : "offline"}
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
                      <details className="group/schema" key={schema}>
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
                                  "grid h-7 grid-cols-[18px_minmax(0,1fr)] items-center gap-2 rounded-md px-2 text-left text-sm transition-colors hover:bg-muted border-l-2 border-l-transparent",
                                  isSelected && "bg-sidebar-accent text-sidebar-accent-foreground border-l-primary",
                                )}
                                key={key}
                                type="button"
                                onClick={() => void onPreviewTable(table)}
                              >
                                {table.table_type !== "INTERNAL" && !table.table_name.startsWith("ducklake_") ? (
                                  <WaveIcon className="size-3.5 shrink-0 text-info-foreground-muted" />
                                ) : (
                                  <Table2 className="size-3.5 shrink-0 opacity-70" />
                                )}
                                <span className="truncate">{table.table_name}</span>
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
  ducklakeStats: ColumnStat[];
  ducklakeColumns: ColumnDetail[];
  ducklakeMetadata: DucklakeMetadata | null;
  ducklakeMetaLoading: boolean;
  ducklakeSnapshots: SnapshotRow[];
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
  ducklakeStats,
  ducklakeColumns,
  ducklakeMetadata,
  ducklakeMetaLoading,
  ducklakeSnapshots,
  onActiveTabChange,
  onPreviewTable,
  onSelectCatalog,
  onSelectSchema,
}: PreviewWorkspaceProps): React.ReactElement {
  const selectedTableType = selectedTable ? getDisplayTableType(selectedTable) : "";
  const isSchemaView = selectedSchema.length > 0;
  const isCatalogView = Boolean(activeConnection && !selectedSchema && !selectedTable);
  const isDucklake = selectedTable ? selectedTable.table_type !== "INTERNAL" : false;
  const visibleTabs = WORKSPACE_TABS.filter((tab) => tab.id === "history" ? isDucklake : true);

  return (
    <section className="flex min-h-0 min-w-0 flex-col overflow-hidden bg-background">
      <div className="px-3 py-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            {isSchemaView && activeConnection ? (
              <nav aria-label="Schema location" className="flex min-w-0 items-center gap-1.5 text-lg font-bold leading-6">
                <button
                  className="min-w-0 truncate rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  type="button"
                  onClick={onSelectCatalog}
                >
                  {activeConnection.name}
                </button>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 truncate">{selectedSchema}</span>
              </nav>
            ) : selectedTable ? (
              <nav aria-label="Table location" className="flex min-w-0 items-center gap-1.5 text-lg font-bold leading-6">
                {activeConnection ? (
                  <>
                    <button
                      className="min-w-0 truncate rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      type="button"
                      onClick={onSelectCatalog}
                    >
                      {activeConnection.name}
                    </button>
                    <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                  </>
                ) : null}
                <button
                  className="min-w-0 truncate rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  type="button"
                  onClick={() => onSelectSchema(selectedTable.table_schema)}
                >
                  {selectedTable.table_schema}
                </button>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                {selectedTable.table_type !== "INTERNAL" && !selectedTable.table_name.startsWith("ducklake_") ? (
                  <WaveIcon className="size-4 shrink-0 text-info-foreground-muted" />
                ) : (
                  <Table2 className="size-4 shrink-0 text-muted-foreground" />
                )}
                <span className="min-w-0 truncate">{selectedTable.table_name}</span>
              </nav>
            ) : isCatalogView ? (
              <h2 className="truncate text-lg font-bold leading-6">{activeConnection?.name}</h2>
            ) : (
              <h2 className="truncate text-lg font-bold leading-6">Select a table</h2>
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
              </>
            )}
          </div>
        </div>
      </div>

      {isSchemaView || isCatalogView ? null : (
        <>
          <div className="flex gap-1 overflow-x-auto border-b border-border px-2.5">
            {visibleTabs.map((tab) => (
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
        </>
      )}

      <div className="min-h-0 flex-1 overflow-hidden">
        {isSchemaView ? (
          <SchemaTablesPanel tables={schemaTables} onPreviewTable={onPreviewTable} />
        ) : isCatalogView ? (
          <CatalogTablesPanel tables={catalogTables} onPreviewTable={onPreviewTable} onSelectSchema={onSelectSchema} />
        ) : (
          <>
            {activeTab === "preview" ? <PreviewPanel preview={preview} /> : null}
            {activeTab === "columns" ? <ColumnsPanel selectedTable={selectedTable} preview={preview} ducklakeColumns={ducklakeColumns} ducklakeStats={ducklakeStats} /> : null}
            {activeTab === "metadata" ? <MetadataPanel metadata={ducklakeMetadata} loading={ducklakeMetaLoading} selectedTable={selectedTable} /> : null}
            {activeTab === "history" ? <HistoryPanel snapshots={ducklakeSnapshots} loading={ducklakeMetaLoading} selectedTable={selectedTable} /> : null}
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
                  {table.table_type !== "INTERNAL" && !table.table_name.startsWith("ducklake_") ? (
                    <WaveIcon className="size-3.5 shrink-0 text-info-foreground-muted" />
                  ) : (
                    <Table2 className="size-3.5 shrink-0 text-muted-foreground" />
                  )}
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

function ColumnsPanel({
  selectedTable,
  preview,
  ducklakeColumns,
  ducklakeStats,
}: {
  selectedTable: RemoteTable | null;
  preview: PreviewState;
  ducklakeColumns: ColumnDetail[];
  ducklakeStats: ColumnStat[];
}): React.ReactElement {
  if (!selectedTable) {
    return <EmptyWorkspacePanel icon={Table2} title="Select a table" />;
  }

  const statsByColumn = new Map(ducklakeStats.map((s) => [s.column_name, s]));
  const hasDucklakeColumns = ducklakeColumns.length > 0;
  const fallbackColumns = preview.result?.columnMetadata ?? [];
  const totalColumns = hasDucklakeColumns ? ducklakeColumns.length : fallbackColumns.length;
  const nullableCount = hasDucklakeColumns
    ? ducklakeColumns.filter((column) => column.is_nullable === "YES" || statsByColumn.get(column.column_name)?.contains_null).length
    : fallbackColumns.filter((column) => column.nullable).length;
  const typeCount = new Set(
    hasDucklakeColumns
      ? ducklakeColumns.map((column) => column.data_type)
      : fallbackColumns.map((column) => column.type),
  ).size;

  if (hasDucklakeColumns) {
    return (
      <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)]">
        <div className="grid gap-2 border-b border-border px-3 py-2 sm:grid-cols-4">
          <MetadataField label="Columns" value={totalColumns} />
          <MetadataField label="Nullable" value={nullableCount} />
          <MetadataField label="Types" value={typeCount} />
          <MetadataField label="With stats" value={ducklakeStats.length} />
        </div>
        <div className="min-h-0 overflow-auto">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-card">
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-12 text-right">#</TableHead>
              <TableHead>Column</TableHead>
              <TableHead className="w-56">Type</TableHead>
              <TableHead className="w-28">Nullable</TableHead>
              <TableHead className="w-36">Min</TableHead>
              <TableHead className="w-36">Max</TableHead>
              <TableHead className="w-28 text-right">Nulls</TableHead>
              <TableHead className="w-40">Default</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {ducklakeColumns.map((column) => {
              const stat = statsByColumn.get(column.column_name);
              const isNullable = stat?.contains_null ?? (column.is_nullable === "YES");

              return (
                <TableRow key={column.column_name}>
                  <TableCell className="text-right text-xs font-semibold text-muted-foreground">{column.ordinal_position}</TableCell>
                  <TableCell className="font-semibold">{column.column_name}</TableCell>
                  <TableCell>
                    <Badge variant="secondary">{formatColumnType(column.data_type, column.character_maximum_length)}</Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {isNullable ? "yes" : "no"}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground" title={stat?.min ?? undefined}>{truncateStat(stat?.min ?? null)}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground" title={stat?.max ?? undefined}>{truncateStat(stat?.max ?? null)}</TableCell>
                  <TableCell className="text-right font-mono text-xs text-muted-foreground">{formatNullPercentage(stat?.null_percentage)}</TableCell>
                  <TableCell className="max-w-56 truncate text-muted-foreground" title={column.column_default ?? undefined}>{column.column_default ?? "\u2014"}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        </div>
      </div>
    );
  }

  return (
    <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)]">
      {fallbackColumns.length > 0 ? (
        <>
        <div className="grid gap-2 border-b border-border px-3 py-2 sm:grid-cols-3">
          <MetadataField label="Columns" value={totalColumns} />
          <MetadataField label="Nullable" value={nullableCount} />
          <MetadataField label="Types" value={typeCount} />
        </div>
        <div className="min-h-0 overflow-auto">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-card">
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-12 text-right">#</TableHead>
              <TableHead>Column</TableHead>
              <TableHead className="w-56">Type</TableHead>
              <TableHead className="w-28">Nullable</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {fallbackColumns.map((column, index) => (
              <TableRow key={column.name}>
                <TableCell className="text-right text-xs font-semibold text-muted-foreground">{index + 1}</TableCell>
                <TableCell className="font-semibold">{column.name}</TableCell>
                <TableCell>
                  <Badge variant="secondary">{column.type}</Badge>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {column.nullable === null ? "unknown" : column.nullable ? "yes" : "no"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        </div>
        </>
      ) : (
        <div className="grid h-full place-items-center">
          <div className="grid w-full max-w-md gap-2 px-6">
            <Skeleton className="h-8 w-32" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-4/5" />
          </div>
        </div>
      )}
    </div>
  );
}

function MetadataPanel({
  metadata,
  loading,
  selectedTable,
}: {
  metadata: DucklakeMetadata | null;
  loading: boolean;
  selectedTable: RemoteTable | null;
}): React.ReactElement {
  const [view, setView] = useState<"overview" | "files" | "snapshots" | "raw">("overview");

  if (loading) {
    return (
      <div className="grid h-full place-items-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!selectedTable) {
    return <EmptyWorkspacePanel icon={Database} title="Select a table" />;
  }

  const sections = metadata?.sections.filter((section) => section.rows.length > 0) ?? [];
  const summary = getDucklakeMetadataSummary(metadata);

  if (sections.length === 0) {
    return <EmptyWorkspacePanel icon={Database} title="No DuckLake metadata available" />;
  }

  const navItems: Array<{ id: typeof view; label: string; count?: number }> = [
    { id: "overview", label: "Overview" },
    { id: "files", label: "Files", count: summary.dataFiles.length + summary.deleteFiles.length },
    { id: "snapshots", label: "Snapshots", count: summary.snapshots.length },
    { id: "raw", label: "Raw", count: sections.length },
  ];

  return (
    <div className="grid h-full min-h-0 grid-cols-[180px_minmax(0,1fr)] overflow-hidden">
      <div className="border-r border-border bg-muted/20 p-2">
        <div className="grid gap-1">
          {navItems.map((item) => (
            <button
              className={cn(
                "flex h-8 items-center justify-between gap-2 rounded-md px-2 text-left text-sm font-semibold text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
                view === item.id && "bg-sidebar-accent text-sidebar-accent-foreground",
              )}
              key={item.id}
              type="button"
              onClick={() => setView(item.id)}
            >
              <span className="truncate">{item.label}</span>
              {item.count !== undefined ? <Badge variant="outline">{item.count}</Badge> : null}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 overflow-auto">
        {view === "overview" ? <MetadataOverview summary={summary} /> : null}
        {view === "files" ? <MetadataFilesView summary={summary} /> : null}
        {view === "snapshots" ? <MetadataSnapshotsView summary={summary} /> : null}
        {view === "raw" ? <MetadataRawView sections={sections} /> : null}
      </div>
    </div>
  );
}

function MetadataOverview({ summary }: { summary: DucklakeMetadataSummary }): React.ReactElement {
  const latestSnapshot = summary.snapshots[0];

  return (
    <div className="grid gap-4 p-3">
      <div className="grid gap-2 md:grid-cols-4">
        <MetadataField label="DuckLake table id" value={summary.tableId} />
        <MetadataField label="Current files" value={summary.currentFileCount} />
        <MetadataField label="Historical files" value={summary.historicalFileCount} />
        <MetadataField label="Total size" value={formatBytes(summary.totalFileBytes)} />
        <MetadataField label="Delete files" value={summary.deleteFiles.length} />
        <MetadataField label="Snapshots" value={summary.snapshots.length} />
        <MetadataField label="Partitions" value={summary.partitionColumns.length} />
        <MetadataField label="Sort keys" value={summary.sortExpressions.length} />
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <MetadataInfoBlock
          title="Latest snapshot"
          rows={[
            ["Snapshot", latestSnapshot?.snapshot_id],
            ["Time", latestSnapshot?.snapshot_time ? formatMetadataCell("snapshot_time", latestSnapshot.snapshot_time) : undefined],
            ["Schema version", latestSnapshot?.schema_version],
          ]}
        />
        <MetadataInfoBlock
          title="Layout"
          rows={[
            ["Partition columns", summary.partitionColumns.map(formatPartitionColumn).join(", ")],
            ["Sort order", summary.sortExpressions.map(formatSortExpression).join(", ")],
            ["Column tags", summary.columnTags.length],
          ]}
        />
      </div>

      <div className="overflow-hidden rounded-md border border-border">
        <div className="flex items-center justify-between border-b border-border bg-muted/40 px-3 py-2">
          <h3 className="text-sm font-bold">Current columns</h3>
          <Badge variant="outline">{summary.columns.length} columns</Badge>
        </div>
        <MetadataRowsTable
          rows={summary.columns}
          preferredColumns={["column_order", "column_name", "column_type", "nulls_allowed", "default_value"]}
          includeRemainingColumns={false}
        />
      </div>
    </div>
  );
}

function MetadataFilesView({ summary }: { summary: DucklakeMetadataSummary }): React.ReactElement {
  return (
    <div className="grid gap-4 p-3">
      <div className="grid gap-2 md:grid-cols-4">
        <MetadataField label="Active data files" value={summary.currentFileCount} />
        <MetadataField label="Historical data files" value={summary.historicalFileCount} />
        <MetadataField label="Delete files" value={summary.deleteFiles.length} />
        <MetadataField label="Total bytes" value={formatBytes(summary.totalFileBytes)} />
      </div>

      <MetadataSectionTable
        title="Data files"
        rows={summary.dataFiles}
        preferredColumns={["data_file_id", "begin_snapshot", "end_snapshot", "record_count", "file_size_bytes", "partition_id", "path"]}
      />
      <MetadataSectionTable
        title="Delete files"
        rows={summary.deleteFiles}
        preferredColumns={["delete_file_id", "begin_snapshot", "end_snapshot", "data_file_id", "delete_count", "file_size_bytes", "path"]}
      />
      <MetadataSectionTable
        title="Partition values"
        rows={summary.partitionValues}
        preferredColumns={["data_file_id", "partition_key_index", "partition_value"]}
      />
    </div>
  );
}

function MetadataSnapshotsView({ summary }: { summary: DucklakeMetadataSummary }): React.ReactElement {
  return (
    <div className="grid gap-4 p-3">
      <MetadataSectionTable
        title="Snapshots"
        rows={summary.snapshots}
        preferredColumns={["snapshot_id", "snapshot_time", "schema_version", "next_file_id"]}
      />
      <MetadataSectionTable
        title="Snapshot changes"
        rows={summary.snapshotChanges}
        preferredColumns={["snapshot_id", "changes_made", "author", "commit_message"]}
      />
      <MetadataSectionTable
        title="Schema versions"
        rows={summary.schemaVersions}
        preferredColumns={["begin_snapshot", "schema_version", "table_id"]}
      />
    </div>
  );
}

function MetadataRawView({ sections }: { sections: DucklakeMetadata["sections"] }): React.ReactElement {
  return (
    <div className="grid gap-3 p-3">
      {sections.map((section) => (
        <details className="overflow-hidden rounded-md border border-border" key={section.id}>
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 bg-muted/40 px-3 py-2">
            <span className="text-sm font-bold">{section.label}</span>
            <Badge variant="outline">{section.rows.length} rows</Badge>
          </summary>
          <MetadataRowsTable rows={section.rows} />
        </details>
      ))}
    </div>
  );
}

function MetadataSectionTable({
  title,
  rows,
  preferredColumns,
}: {
  title: string;
  rows: PreviewRow[];
  preferredColumns: string[];
}): React.ReactElement {
  return (
    <div className="overflow-hidden rounded-md border border-border">
      <div className="flex items-center justify-between border-b border-border bg-muted/40 px-3 py-2">
        <h3 className="text-sm font-bold">{title}</h3>
        <Badge variant="outline">{rows.length} rows</Badge>
      </div>
      {rows.length > 0 ? (
        <MetadataRowsTable rows={rows} preferredColumns={preferredColumns} includeRemainingColumns={false} />
      ) : (
        <div className="p-3 text-sm text-muted-foreground">No rows</div>
      )}
    </div>
  );
}

function MetadataInfoBlock({ title, rows }: { title: string; rows: Array<[string, unknown]> }): React.ReactElement {
  return (
    <div className="rounded-md border border-border bg-muted/20 p-3">
      <h3 className="text-sm font-bold">{title}</h3>
      <dl className="mt-3 grid gap-2">
        {rows.map(([label, value]) => (
          <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-3 text-sm" key={label}>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="truncate font-semibold">{formatMetadataValue(value)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function MetadataField({ label, value }: { label: string; value: unknown }): React.ReactElement {
  return (
    <div className="rounded-md border border-border bg-muted/25 p-3">
      <div className="text-[11px] font-semibold uppercase text-muted-foreground">{label}</div>
      <div className="mt-1 truncate text-sm font-bold">{formatMetadataValue(value)}</div>
    </div>
  );
}

function MetadataRowsTable({
  rows,
  preferredColumns,
  includeRemainingColumns = true,
}: {
  rows: PreviewRow[];
  preferredColumns?: string[];
  includeRemainingColumns?: boolean;
}): React.ReactElement {
  const rowColumns = Object.keys(rows[0] ?? {});
  const columns = preferredColumns
    ? [
      ...preferredColumns.filter((column) => rowColumns.includes(column)),
      ...(includeRemainingColumns ? rowColumns.filter((column) => !preferredColumns.includes(column)) : []),
    ]
    : rowColumns;

  if (columns.length === 0) {
    return <div className="p-3 text-sm text-muted-foreground">No columns</div>;
  }

  return (
    <div className="max-h-80 overflow-auto">
      <Table>
        <TableHeader className="sticky top-0 z-10 bg-card">
          <TableRow className="hover:bg-transparent">
            <TableHead className="w-12 text-right">#</TableHead>
            {columns.map((column) => (
              <TableHead className="whitespace-nowrap" key={column}>{column}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, index) => (
            <TableRow key={metadataRowKey(row, index)}>
              <TableCell className="text-right text-xs font-semibold text-muted-foreground">{index + 1}</TableCell>
              {columns.map((column) => {
                const value = formatMetadataCell(column, row[column]);

                return (
                  <TableCell className="max-w-80 truncate font-mono text-xs text-muted-foreground" key={column} title={value}>
                    {value}
                  </TableCell>
                );
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function HistoryPanel({
  snapshots,
  loading,
  selectedTable,
}: {
  snapshots: SnapshotRow[];
  loading: boolean;
  selectedTable: RemoteTable | null;
}): React.ReactElement {
  if (loading) {
    return (
      <div className="grid h-full place-items-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!selectedTable) {
    return <EmptyWorkspacePanel icon={History} title="Select a table" />;
  }

  if (snapshots.length === 0) {
    return <EmptyWorkspacePanel icon={History} title="No snapshot history available" />;
  }

  return (
    <div className="h-full overflow-auto">
      <Table>
        <TableHeader className="sticky top-0 z-10 bg-card">
          <TableRow className="hover:bg-transparent">
            <TableHead className="w-24 text-right">Snapshot</TableHead>
            <TableHead>Timestamp</TableHead>
            <TableHead>Author</TableHead>
            <TableHead>Message</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {snapshots.map((snapshot) => (
            <TableRow key={snapshot.snapshot_id}>
              <TableCell className="text-right font-mono text-xs text-muted-foreground">{snapshot.snapshot_id}</TableCell>
              <TableCell className="font-semibold">{snapshot.snapshot_time}</TableCell>
              <TableCell className="text-muted-foreground">{snapshot.author ?? "\u2014"}</TableCell>
              <TableCell className="text-muted-foreground">{snapshot.commit_message ?? "\u2014"}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
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

function readBootstrapConnection(): BootstrapConnection | null {
  const params = new URLSearchParams(window.location.search);
  const endpoint = (params.get("catalog_uri") ?? params.get("quackalog_catalog_uri") ?? "").trim();

  if (!endpoint) {
    return null;
  }

  const requestedName = (params.get("catalog_name") ?? params.get("quackalog_catalog_name") ?? "").trim();

  return {
    name: requestedName || getConnectionAlias(endpoint),
    endpoint,
  };
}

function removeBootstrapConnectionParams(): void {
  const url = new URL(window.location.href);
  const params = [
    "catalog_uri",
    "catalog_name",
    "catalog_connect",
    "quackalog_catalog_uri",
    "quackalog_catalog_name",
    "quackalog_catalog_connect",
  ];

  for (const param of params) {
    url.searchParams.delete(param);
  }

  window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
}

function readCatalogRoute(): CatalogRoute | null {
  const segments = getRouteSegments();

  if (segments[0] !== "catalogs" || !segments[1]) {
    return null;
  }

  const route: CatalogRoute = {
    catalog: segments[1],
  };
  const tab = parseWorkspaceTab(new URLSearchParams(window.location.search).get("tab"));

  if (tab) {
    route.tab = tab;
  }

  if (segments[2] === "schema" && segments[3]) {
    route.schema = segments[3];
  }

  if (segments[4] === "table" && segments[5]) {
    route.table = segments[5];
  }

  return route;
}

function writeCatalogRoute(route: CatalogRoute): void {
  const segments = ["catalogs", route.catalog];

  if (route.schema) {
    segments.push("schema", route.schema);
  }

  if (route.schema && route.table) {
    segments.push("table", route.table);
  }

  const base = getRouteBasePath();
  const path = `${base}${segments.map(encodeURIComponent).join("/")}`;
  const params = new URLSearchParams(window.location.search);

  if (route.tab) {
    params.set("tab", route.tab);
  } else {
    params.delete("tab");
  }

  const query = params.toString();
  const nextUrl = `${path}${query ? `?${query}` : ""}${window.location.hash}`;

  if (`${window.location.pathname}${window.location.search}${window.location.hash}` !== nextUrl) {
    window.history.pushState({}, "", nextUrl);
  }
}

function findConnectionForRoute(connections: ConnectionProfile[], catalog: string): ConnectionProfile | null {
  return connections.find((connection) => connection.id === catalog || connection.name === catalog) ?? null;
}

function getRouteSegments(): string[] {
  const base = getRouteBasePath();
  const pathname = window.location.pathname.startsWith(base)
    ? window.location.pathname.slice(base.length)
    : window.location.pathname.replace(/^\//, "");

  return pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
}

function getRouteBasePath(): string {
  const base = import.meta.env.BASE_URL || "/";

  return base.endsWith("/") ? base : `${base}/`;
}

function mergeRuntimeCatalogs(
  storedConnections: ConnectionProfile[],
  runtimeCatalogs: RuntimeCatalog[],
): ConnectionProfile[] {
  const byEndpoint = new Map(storedConnections.map((connection) => [connection.endpoint, connection]));
  const next = [...storedConnections];

  for (const catalog of runtimeCatalogs) {
    const endpoint = catalog.endpoint.trim();
    const existing = byEndpoint.get(endpoint);
    const profile = {
      id: existing?.id ?? `config-${hashString(endpoint)}`,
      name: catalog.name.trim(),
      endpoint,
    };

    if (existing) {
      const index = next.findIndex((connection) => connection.id === existing.id);
      next[index] = profile;
    } else {
      next.push(profile);
    }

    byEndpoint.set(endpoint, profile);
  }

  return next;
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

function readStoredVaultTtlMinutes(): number {
  const stored = Number(readStoredString(VAULT_TTL_KEY, String(DEFAULT_VAULT_TTL_MINUTES)));

  return VAULT_TTL_OPTIONS.includes(stored) ? stored : DEFAULT_VAULT_TTL_MINUTES;
}

function parseWorkspaceTab(value: string | null): WorkspaceTab | null {
  if (value === "preview" || value === "columns" || value === "metadata" || value === "history") {
    return value;
  }

  return null;
}

function getVaultTtlMs(minutes: number): number {
  return minutes * 60 * 1000;
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

function hashString(value: string): string {
  let hash = 0;

  for (let i = 0; i < value.length; i += 1) {
    hash = Math.imul(31, hash) + value.charCodeAt(i);
  }

  return Math.abs(hash).toString(36);
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

function WaveIcon({ className }: { className?: string }): React.ReactElement {
  return (
    <svg
      className={className}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      viewBox="0 0 24 24"
    >
      <path d="M2 6C2.6 6.5 3.2 7 4.5 7C7 7 7 5 9.5 5C10.8 5 11.4 5.5 12 6C12.6 6.5 13.2 7 14.5 7C17 7 17 5 19.5 5C20.8 5 21.4 5.5 22 6" />
      <path d="M2 18C2.6 18.5 3.2 19 4.5 19C7 19 7 17 9.5 17C10.8 17 11.4 17.5 12 18C12.6 18.5 13.2 19 14.5 19C17 19 17 17 19.5 17C20.8 17 21.4 17.5 22 18" />
      <path d="M2 12C2.6 12.5 3.2 13 4.5 13C7 13 7 11 9.5 11C10.8 11 11.4 11.5 12 12C12.6 12.5 13.2 13 14.5 13C17 13 17 11 19.5 11C20.8 11 21.4 11.5 22 12" />
    </svg>
  );
}

function formatBytes(bytes: number): string {
  const n = typeof bytes === "bigint" ? Number(bytes) : bytes;
  if (n === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  const size = n / 1024 ** i;
  return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function getDucklakeMetadataSummary(metadata: DucklakeMetadata | null): DucklakeMetadataSummary {
  const sectionRows = (id: string): PreviewRow[] => metadata?.sections.find((section) => section.id === id)?.rows ?? [];
  const dataFiles = sectionRows("data-files");
  const deleteFiles = sectionRows("delete-files");
  const currentFileCount = dataFiles.filter((row) => row.end_snapshot === null || row.end_snapshot === undefined).length;

  return {
    columnTags: sectionRows("column-tags"),
    columns: sectionRows("columns"),
    currentFileCount,
    dataFiles,
    deleteFiles,
    historicalFileCount: dataFiles.length - currentFileCount,
    partitionColumns: sectionRows("partition-columns"),
    partitionValues: sectionRows("partition-values"),
    schemaVersions: sectionRows("schema-versions"),
    snapshotChanges: sectionRows("snapshot-changes"),
    snapshots: sectionRows("snapshots"),
    sortExpressions: sectionRows("sort-expressions"),
    tableId: metadata?.table_id ?? null,
    totalFileBytes: dataFiles.reduce((sum, row) => sum + numericMetadataValue(row.file_size_bytes), 0),
  };
}

function formatMetadataCell(column: string, value: unknown): string {
  if (column.includes("size_bytes") || column === "footer_size") {
    return formatBytes(numericMetadataValue(value));
  }

  if (column.includes("time") && (typeof value === "string" || typeof value === "number" || typeof value === "bigint")) {
    return formatTimestamp(value);
  }

  if (column === "path" && typeof value === "string") {
    return formatFilePath(value);
  }

  return stringifyCell(value);
}

function formatTimestamp(value: string | number | bigint): string {
  const numericValue = typeof value === "bigint" ? Number(value) : Number(value);
  const dateInput = Number.isFinite(numericValue) && numericValue > 1_000_000_000_000
    ? numericValue
    : String(value);
  const date = new Date(dateInput);

  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function formatFilePath(value: string): string {
  const parts = value.split("/");

  if (parts.length <= 1) {
    return value;
  }

  return `${parts.at(-1)} (${parts.slice(0, -1).join("/")})`;
}

function formatPartitionColumn(row: PreviewRow): string {
  const column = row.column_id ?? "column";
  const transform = row.transform ? ` ${row.transform}` : "";

  return `${column}${transform}`;
}

function formatSortExpression(row: PreviewRow): string {
  const expression = row.expression ?? "expression";
  const direction = row.sort_direction ?? "";
  const nullOrder = row.null_order ?? "";

  return [expression, direction, nullOrder].filter(Boolean).join(" ");
}

function numericMetadataValue(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "bigint") {
    return Number(value);
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

function formatMetadataValue(value: unknown): string {
  if (value === null || value === undefined || value === "") {
    return "\u2014";
  }

  if (typeof value === "number") {
    return Number.isInteger(value) ? value.toLocaleString() : value.toString();
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (typeof value === "boolean") {
    return value ? "yes" : "no";
  }

  return String(value);
}

function metadataRowKey(row: PreviewRow, index: number): string {
  const id = row.id
    ?? row.table_id
    ?? row.column_id
    ?? row.data_file_id
    ?? row.delete_file_id
    ?? row.snapshot_id
    ?? row.partition_id
    ?? row.sort_id;

  return `${id ?? "row"}-${index}`;
}

function truncateStat(value: string | null): string {
  if (value === null) return "\u2014";
  return value.length > 24 ? `${value.slice(0, 24)}\u2026` : value;
}

function formatColumnType(type: string, maxLength: number | null): string {
  if (maxLength === null || maxLength <= 0) {
    return type;
  }

  return `${type}(${maxLength})`;
}

function formatNullPercentage(value: number | null | undefined): string {
  if (value === null || value === undefined) {
    return "\u2014";
  }

  return `${value.toFixed(value < 1 ? 2 : 1)}%`;
}
