export function buildRuntimeConfig({ endpoint, name }) {
  const normalizedEndpoint = endpoint.trim();

  if (!normalizedEndpoint) {
    return {
      activeCatalog: "",
      catalogs: [],
    };
  }

  const normalizedName = name.trim() || "remote catalog";

  return {
    activeCatalog: normalizedName,
    catalogs: [
      {
        name: normalizedName,
        endpoint: normalizedEndpoint,
      },
    ],
  };
}
