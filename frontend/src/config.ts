const API_ORIGIN = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/$/, "");

/**
 * Base URL for the backend API.
 *
 * Development leaves VITE_API_BASE_URL empty and uses Vite's /api proxy.
 * Production sets it to the public backend origin, for example:
 * https://notification-lab-backend.onrender.com
 */
export const API_BASE_URL = API_ORIGIN ? `${API_ORIGIN}/api` : "/api";

/**
 * WebSocket endpoint derived from the backend origin.
 * In local development the browser connects to the same host as the page;
 * in production it connects to the Render backend origin.
 */
const WS_ORIGIN = API_ORIGIN
  ? API_ORIGIN.replace(/^http:/, "ws:").replace(/^https:/, "wss:")
  : `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}`;

export const WS_BASE_URL = `${WS_ORIGIN}/api/ws`;
