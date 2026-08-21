const API_ORIGIN = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/$/, "");

/**
 * Base URL for the backend API.
 *
 * Development can keep this empty and use Vite's /api proxy.
 * Production should set VITE_API_BASE_URL to the public backend origin,
 * for example: https://notification-lab-backend.onrender.com
 */
export const API_BASE_URL = `${API_ORIGIN}/api`;

/**
 * WebSocket endpoint derived from the same backend origin as the HTTP API.
 */
export const WS_BASE_URL = `${API_ORIGIN.replace(/^http:/, "ws:").replace(/^https:/, "wss:")}/api/ws`;
