/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_QUACK_URI: string;
  readonly VITE_QUACK_TOKEN: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
