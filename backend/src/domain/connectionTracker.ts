import { getDb } from "../db/index.js";
import type { ConnectionTransport } from "./types.js";

/**
 * Theo dõi vòng đời 1 "connection" theo nghĩa rộng:
 * - Long Polling: 1 request đang được giữ mở = 1 connection.
 * - SSE/WebSocket (Phase sau): 1 kết nối thật.
 *
 * Ghi vào DB (không chỉ in-memory) để benchmark có thể query lại sau khi
 * chạy xong (Rule Section 50 — raw data must be preserved).
 */
export function openConnection(
  userId: number,
  transport: ConnectionTransport
): number {
  const db = getDb();
  const info = db
    .prepare(`INSERT INTO connections (user_id, transport) VALUES (?, ?)`)
    .run(userId, transport);
  return Number(info.lastInsertRowid);
}

export type DisconnectReason =
  | "data_delivered"
  | "timeout"
  | "client_disconnect"
  | "server_shutdown";

export function closeConnection(
  connectionId: number,
  reason: DisconnectReason
): void {
  const db = getDb();
  db.prepare(
    `UPDATE connections SET disconnected_at = unixepoch(), disconnect_reason = ?
     WHERE id = ? AND disconnected_at IS NULL`
  ).run(reason, connectionId);
}
