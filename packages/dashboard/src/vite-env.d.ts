/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Override the base URL the dashboard fetches JSON data from. Default `/data`. */
  readonly VITE_DATA_BASE?: string;
  /** Polling refresh interval in ms. Default 60000. `0` disables. */
  readonly VITE_REFRESH_MS?: string;
  /** Dev-only role override for RBAC testing. */
  readonly VITE_DEV_ROLE?: "SUPER_ADMIN" | "ADMIN" | "CLIENT" | "VIEWER";
  /** Dev-only identity override for RBAC testing. */
  readonly VITE_DEV_EMAIL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
