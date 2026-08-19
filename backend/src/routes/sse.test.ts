import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { closeDb, migrate, getDb } from "../db/index.js";
import { createUser, follow, createPost, getPort, waitUntil } from "../test/helpers.js";

interface SseClient {
  req: http.ClientRequest;
  events: Array<{ id: number; [k: string]: unknown }>;
  close: () => void;
}

/**
 * Client SSE tối giản dùng node:http thuần — đủ để test parse frame
 * `id:`/`event:`/`data:` phân tách bởi dòng trống, không cần thư viện ngoài.
 */
function connectSse(
  port: number,
  userId: number,
  lastEventId?: number
): Promise<SseClient> {
  return new Promise((resolve, reject) => {
    const path = `/notifications/stream?userId=${userId}${
      lastEventId ? `&lastEventId=${lastEventId}` : ""
    }`;
    const req = http.request(
      { host: "127.0.0.1", port, path, method: "GET" },
      (res) => {
        const events: Array<{ id: number; [k: string]: unknown }> = [];
        let buffer = "";
        res.on("data", (chunk: Buffer) => {
          buffer += chunk.toString("utf-8");
          let idx: number;
          while ((idx = buffer.indexOf("\n\n")) !== -1) {
            const frame = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            if (frame.startsWith(":")) continue; // heartbeat/connected comment
            const dataLine = frame
              .split("\n")
              .find((l) => l.startsWith("data: "));
            if (dataLine) {
              events.push(JSON.parse(dataLine.slice("data: ".length)));
            }
          }
        });
        resolve({
          req,
          events,
          close: () => req.destroy(),
        });
      }
    );
    req.on("error", (err) => {
      // Sau khi test chủ động gọi close()/destroy(), Node có thể emit thêm
      // 1 error event (ECONNRESET) — không phải lỗi test, bỏ qua an toàn.
      if (!req.destroyed) reject(err);
    });
    req.end();
  });
}

describe("SSE transport (/notifications/stream)", () => {
  let app: FastifyInstance;
  let port: number;

  beforeEach(async () => {
    closeDb();
    migrate();
    app = await buildApp();
    await app.listen({ port: 0, host: "127.0.0.1" });
    port = getPort(app);
  });

  afterEach(async () => {
    await app.close();
    closeDb();
  });

  it("catch-up: nhận notification đã có sẵn ngay khi connect (lastEventId=0)", async () => {
    const alice = await createUser(app, "alice");
    const bob = await createUser(app, "bob");
    await follow(app, bob, alice);
    await createPost(app, alice, "post trước khi bob connect");

    const client = await connectSse(port, bob);
    await waitUntil(() => client.events.length >= 1);

    expect(client.events[0].actorDisplayName).toBe("alice");
    expect(client.events[0].scriptPreview).toBe("post trước khi bob connect");

    client.close();
  });

  it("nhận notification realtime sau khi đã connect (không cần catch-up)", async () => {
    const alice = await createUser(app, "alice");
    const bob = await createUser(app, "bob");
    await follow(app, bob, alice);

    const client = await connectSse(port, bob);
    // Không có gì để catch-up — cho thời gian nhỏ để chắc chắn không có event rác
    await new Promise((r) => setTimeout(r, 50));
    expect(client.events).toHaveLength(0);

    await createPost(app, alice, "post realtime");
    await waitUntil(() => client.events.length >= 1);

    expect(client.events[0].scriptPreview).toBe("post realtime");
    client.close();
  });

  it("reconnect với lastEventId không nhận lại notification đã thấy", async () => {
    const alice = await createUser(app, "alice");
    const bob = await createUser(app, "bob");
    await follow(app, bob, alice);
    await createPost(app, alice, "post 1");

    const client1 = await connectSse(port, bob);
    await waitUntil(() => client1.events.length >= 1);
    const firstEventId = client1.events[0].id;
    client1.close();

    // Reconnect với lastEventId = event vừa nhận -> không nên có gì trong catch-up
    const client2 = await connectSse(port, bob, firstEventId);
    await new Promise((r) => setTimeout(r, 50));
    expect(client2.events).toHaveLength(0);

    await createPost(app, alice, "post 2");
    await waitUntil(() => client2.events.length >= 1);
    expect(client2.events[0].id).toBeGreaterThan(firstEventId);
    expect(client2.events[0].scriptPreview).toBe("post 2");

    client2.close();
  });

  it("dọn dẹp đúng khi client đóng kết nối (ghi vào bảng connections)", async () => {
    const bob = await createUser(app, "bob");
    const client = await connectSse(port, bob);
    await new Promise((r) => setTimeout(r, 30)); // đảm bảo connection đã được ghi

    client.close();
    await new Promise((r) => setTimeout(r, 100)); // đợi event 'close' xử lý xong

    const db = getDb();
    const row = db
      .prepare(
        `SELECT * FROM connections WHERE user_id = ? AND transport = 'sse' ORDER BY id DESC LIMIT 1`
      )
      .get(bob) as { disconnected_at: number | null; disconnect_reason: string | null };

    expect(row).toBeTruthy();
    expect(row.disconnected_at).not.toBeNull();
    expect(row.disconnect_reason).toBe("client_disconnect");
  });

  it("thiếu userId -> 400 (không hijack, trả lỗi bình thường)", async () => {
    const res = await app.inject({ method: "GET", url: "/notifications/stream" });
    expect(res.statusCode).toBe(400);
  });
});
