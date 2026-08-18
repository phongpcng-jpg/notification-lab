import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import { config } from "../config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;

  // Đảm bảo thư mục chứa file DB tồn tại (data/ thường không commit vào git)
  const dir = dirname(config.dbPath);
  mkdirSync(dir, { recursive: true });

  db = new Database(config.dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

/**
 * Migration đơn giản: chạy schema.sql, mọi statement dùng CREATE TABLE IF NOT EXISTS
 * nên an toàn khi gọi lại nhiều lần. Với project ở quy mô này, không cần
 * hệ thống migration versioned phức tạp (ghi rõ trade-off trong ADR-002).
 */
export function migrate(): void {
  const database = getDb();
  const schemaPath = join(__dirname, "schema.sql");
  const schema = readFileSync(schemaPath, "utf-8");
  database.exec(schema);
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
