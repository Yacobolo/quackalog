# Quackalog

Static DuckDB-Wasm catalog explorer for Quack endpoints.

## Local dev bootstrap

The app stays static, and local development can use a small Node runner to generate a runtime catalog config and start Vite:

```sh
npm run dev:local
```

`dev:local` reads `.env`, writes `public/quackalog.config.json`, and starts the app at `http://127.0.0.1:5173/`. If `QUACKALOG_SEED_QUACK_URI` is set, it also creates the local DuckLake fixture and starts a local Quack server; the seed is intentionally opt-in. The generated config is ignored by git because it can contain private local endpoints.

Useful `.env` keys:

```sh
VITE_QUACK_URI=quack:your-remote-dev-host.example.com:443
VITE_QUACK_TOKEN=your-dev-token
QUACKALOG_REMOTE_NAME=remote dev
# Optional local fixture (opt-in):
# QUACKALOG_SEED_QUACK_URI=quack:127.0.0.1:7443
# QUACKALOG_SEED_NAME=local seed
# QUACKALOG_SEED_TOKEN=quackalog-dev-token
QUACKALOG_ACTIVE_CATALOG=remote dev
QUACKALOG_QUACK_COMMAND=
```

If `QUACKALOG_QUACK_COMMAND` is set, the runner starts that custom command instead of the built-in local seed server. The built-in server uses DuckDB's Quack extension directly: Quack servers are started from a DuckDB session, not from a separate `quack` binary.

The repository includes a checked-in remote-only example at `public/quackalog.config.example.json`; the app also supports URL bootstrap links:

```txt
http://127.0.0.1:5173/?catalog_uri=quack:your-remote-dev-host.example.com:443&catalog_name=remote%20dev
```

## GitHub Pages deployment

Set a repository variable named `QUACK_URL` (or `VITE_QUACK_URI`) to the public Quack endpoint before deploying. The Pages workflow writes a remote-only runtime catalog config during the build. Tokens are never baked into the static bundle; users paste a token or unlock one from the local encrypted vault. The Quack endpoint must allow the deployed origin, such as `https://yacobolo.github.io`, with CORS on `POST /quack`.
