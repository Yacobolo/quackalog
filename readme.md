# Quackalog

Static DuckDB-Wasm catalog explorer for Quack endpoints.

## Local dev bootstrap

The app stays static, but local development can use a small Node runner to seed a DuckLake fixture, generate a runtime catalog config, and start Vite:

```sh
npm run dev:local
```

`dev:local` reads `.env`, writes `public/quackalog.config.json`, starts a local DuckDB session, attaches the seeded DuckLake, serves it with `CALL quack_serve(...)`, and starts the app at `http://127.0.0.1:5173/`. That config is intentionally ignored by git because it can contain private local endpoints.

Useful `.env` keys:

```sh
VITE_QUACK_URI=quack:your-remote-dev-host.example.com:443
VITE_QUACK_TOKEN=your-dev-token
QUACKALOG_REMOTE_NAME=remote dev
QUACKALOG_SEED_QUACK_URI=quack:127.0.0.1:7443
QUACKALOG_SEED_NAME=local seed
QUACKALOG_SEED_TOKEN=quackalog-dev-token
QUACKALOG_ACTIVE_CATALOG=local seed
QUACKALOG_QUACK_COMMAND=
```

If `QUACKALOG_QUACK_COMMAND` is set, the runner starts that custom command instead of the built-in local seed server. The built-in server uses DuckDB's Quack extension directly: Quack servers are started from a DuckDB session, not from a separate `quack` binary.

The static app also supports a checked-in example at `public/quackalog.config.example.json` and URL bootstrap links:

```txt
http://127.0.0.1:5173/?catalog_uri=quack:127.0.0.1:7443&catalog_name=local%20seed
```
