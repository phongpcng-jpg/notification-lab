import { describe, it, expect, beforeEach, afterEach } from "vitest";
import WebSocket from "ws";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { closeDb, migrate, getDb } from "../db/index.js";
import { createUser, follow, createPost, getPort, waitUntil } from "../test/helpers.js";

interface WsMessage {
  type: string;
  [key: string]: unknown;
}

function connectWs(port: number, userId: number, after?: number): {
  socket: WebSocket;
  messages: WsMessage[];
  ready: Promise<void>;
} {
  const url = `ws://127.0.0.1:${port}/ws?userId=${userId}${
    after ? `&after=${after}` : ""
  }`;
  const socket = new WebSocket(url);
  const messages: WsMessage[] = [];

  socket.on("message", (raw) => {
    try {
      messages.push(JSON.parse(raw.toString("utf-8")));
    } catch {
      // ignore malformed — không nên xảy ra trong test
    }
  });

  const ready = new Promise<void>((resolve, reject) => {
    socket.on("open", () => resolve());
    socket.on("error", reject);
  });

  return { socket, messages, ready };
}

function closeWs(socket: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (socket.readyState === WebSocket.CLOSED) return resolve();
    socket.once("close", () => resolve());
    socket.close();
  });
}

describe("WebSocket transport (/ws)", () => {
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

  it("gửi message 'connected' ngay khi kết nối thành công", async () => {
    const bob = await createUser(app, "bob");
    const { socket, messages, ready } = connectWs(port, bob);
    await ready;
    await waitUntil(() => messages.length >= 1);

    expect(messages[0].type).toBe("connected");
    expect(messages[0].userId).toBe(bob);

    await closeWs(socket);
  });

  it("catch-up: nhận notification có sẵn ngay khi connect", async () => {
    const alice = await createUser(app, "alice");
    const bob = await createUser(app, "bob");
    await follow(app, bob, alice);
    await createPost(app, alice, "post có sẵn trước khi bob connect");

    const { socket, messages, ready } = connectWs(port, bob);
    await ready;
    await waitUntil(() => messages.some((m) => m.type === "notification"));

    const notif = messages.find((m) => m.type === "notification")!;
    expect((notif.data as any).actorDisplayName).toBe("alice");
    expect((notif.data as any).scriptPreview).toBe(
      "post có sẵn trước khi bob connect"
    );

    await closeWs(socket);
  });

  it("nhận notification realtime khi post được tạo sau khi đã connect", async () => {
    const alice = await createUser(app, "alice");
    const bob = await createUser(app, "bob");
    await follow(app, bob, alice);

    const { socket, messages, ready } = connectWs(port, bob);
    await ready;
    await waitUntil(() => messages.some((m) => m.type === "connected"));

    await createPost(app, alice, "post realtime qua websocket");
    await waitUntil(() => messages.some((m) => m.type === "notification"));

    const notif = messages.find((m) => m.type === "notification")!;
    expect((notif.data as any).scriptPreview).toBe(
      "post realtime qua websocket"
    );

    await closeWs(socket);
  });

  it("ack từ client cập nhật status thành 'acknowledged' (minh chứng 2 chiều thật)", async () => {
    const alice = await createUser(app, "alice");
    const bob = await createUser(app, "bob");
    await follow(app, bob, alice);
    await createPost(app, alice, "post cần ack");

    const { socket, messages, ready } = connectWs(port, bob);
    await ready;
    await waitUntil(() => messages.some((m) => m.type === "notification"));
    const notif = messages.find((m) => m.type === "notification")!;
    const notificationId = (notif.data as any).id as number;

    socket.send(JSON.stringify({ type: "ack", notificationId }));
    await new Promise((r) => setTimeout(r, 100)); // đợi server xử lý message

    const db = getDb();
    const row = db
      .prepare(`SELECT status FROM notifications WHERE id = ?`)
      .get(notificationId) as { status: string };
    expect(row.status).toBe("acknowledged");

    await closeWs(socket);
  });

  it("reconnect với `after` không nhận lại notification đã thấy", async () => {
    const alice = await createUser(app, "alice");
    const bob = await createUser(app, "bob");
    await follow(app, bob, alice);
    await createPost(app, alice, "post 1");

    const first = connectWs(port, bob);
    await first.ready;
    await waitUntil(() => first.messages.some((m) => m.type === "notification"));
    const firstNotif = first.messages.find((m) => m.type === "notification")!;
    const firstId = (firstNotif.data as any).id as number;
    await closeWs(first.socket);

    const second = connectWs(port, bob, firstId);
    await second.ready;
    await waitUntil(() => second.messages.some((m) => m.type === "connected"));
    await new Promise((r) => setTimeout(r, 50));
    expect(second.messages.some((m) => m.type === "notification")).toBe(false);

    await createPost(app, alice, "post 2");
    await waitUntil(() => second.messages.some((m) => m.type === "notification"));
    const secondNotif = second.messages.find((m) => m.type === "notification")!;
    expect((secondNotif.data as any).id).toBeGreaterThan(firstId);

    await closeWs(second.socket);
  });

  it("dọn dẹp đúng khi client đóng kết nối (ghi vào bảng connections)", async () => {
    const bob = await createUser(app, "bob");
    const { socket, ready } = connectWs(port, bob);
    await ready;
    await new Promise((r) => setTimeout(r, 30));

    await closeWs(socket);
    await new Promise((r) => setTimeout(r, 100));

    const db = getDb();
    const row = db
      .prepare(
        `SELECT * FROM connections WHERE user_id = ? AND transport = 'websocket' ORDER BY id DESC LIMIT 1`
      )
      .get(bob) as { disconnected_at: number | null; disconnect_reason: string | null };

    expect(row).toBeTruthy();
    expect(row.disconnected_at).not.toBeNull();
    expect(row.disconnect_reason).toBe("client_disconnect");
  });

  it("thiếu userId -> server đóng kết nối với code 1008", async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const closeCode = await new Promise<number>((resolve) => {
      socket.on("close", (code) => resolve(code));
    });
    expect(closeCode).toBe(1008);
  });
});
