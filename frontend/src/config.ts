const API_ORIGIN = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/$/, "");

/**
 * Backend HTTP base URL.
 *
 * The Fastify routes are mounted at the root (for example /users and
 * /notifications/poll). In development Vite exposes them through /api and
 * strips that prefix before forwarding to localhost:3000. In production the
 * browser calls the Render backend directly, so no /api prefix is used.
 */
export const API_BASE_URL = API_ORIGIN || "/api";

/**
 * WebSocket endpoint derived from the backend origin.
 * Development uses Vite's /api proxy, which rewrites /api/ws -> /ws.
 * Production connects directly to the backend's /ws endpoint.
 */
const WS_BASE_PATH = "/ws";
const WS_ORIGIN = API_ORIGIN
  ? API_ORIGIN.replace(/^http:/, "ws:").replace(/^https:/, "wss:")
  : `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}`;

export const WS_BASE_URL = API_ORIGIN
  ? `${WS_ORIGIN}${WS_BASE_PATH}`
  : `${WS_ORIGIN}/api${WS_BASE_PATH}`;
