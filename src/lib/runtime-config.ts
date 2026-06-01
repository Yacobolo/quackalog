export type RuntimeCatalogConfig = {
  catalogs: RuntimeCatalog[];
  activeCatalog?: string;
};

export type RuntimeCatalog = {
  name: string;
  endpoint: string;
};

type RawRuntimeCatalogConfig = {
  catalogs?: unknown;
  activeCatalog?: unknown;
};

const RUNTIME_CONFIG_PATH = "quackalog.config.json";

export async function loadRuntimeCatalogConfig(): Promise<RuntimeCatalogConfig> {
  try {
    const response = await fetch(`${import.meta.env.BASE_URL}${RUNTIME_CONFIG_PATH}`, {
      cache: "no-store",
    });

    if (!response.ok) {
      return { catalogs: [] };
    }

    return normalizeConfig(await response.json());
  } catch {
    return { catalogs: [] };
  }
}

function normalizeConfig(value: unknown): RuntimeCatalogConfig {
  if (!value || typeof value !== "object") {
    return { catalogs: [] };
  }

  const raw = value as RawRuntimeCatalogConfig;
  const catalogs = Array.isArray(raw.catalogs)
    ? raw.catalogs.filter(isRuntimeCatalog)
    : [];
  const activeCatalog = typeof raw.activeCatalog === "string" ? raw.activeCatalog : undefined;

  return { catalogs, activeCatalog };
}

function isRuntimeCatalog(value: unknown): value is RuntimeCatalog {
  if (!value || typeof value !== "object") {
    return false;
  }

  const catalog = value as Partial<RuntimeCatalog>;

  return Boolean(catalog.name?.trim()) && Boolean(catalog.endpoint?.trim());
}
