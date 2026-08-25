import assert from "node:assert/strict";
import test from "node:test";

import { buildRuntimeConfig } from "./runtime-config.mjs";

test("builds an empty runtime config when no endpoint is configured", () => {
  assert.deepEqual(buildRuntimeConfig({ endpoint: "", name: "remote catalog" }), {
    activeCatalog: "",
    catalogs: [],
  });
});

test("builds a named runtime catalog when an endpoint is configured", () => {
  assert.deepEqual(
    buildRuntimeConfig({
      endpoint: "  quack:catalog.example.com:443  ",
      name: "  production  ",
    }),
    {
      activeCatalog: "production",
      catalogs: [
        {
          endpoint: "quack:catalog.example.com:443",
          name: "production",
        },
      ],
    },
  );
});

test("uses the default catalog name when the configured name is blank", () => {
  assert.deepEqual(
    buildRuntimeConfig({ endpoint: "quack:catalog.example.com:443", name: " " }),
    {
      activeCatalog: "remote catalog",
      catalogs: [
        {
          endpoint: "quack:catalog.example.com:443",
          name: "remote catalog",
        },
      ],
    },
  );
});
