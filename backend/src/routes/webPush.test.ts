import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { buildApp } from "../app.js";
import { closeDb, migrate, getDb } from "../db/index.js";
import { createUser, follow, createPost } from "../test/helpers.js";

// Mock toàn bộ thư viện `web-push` — test này KHÔNG được gọi Push Service
// thật (không có network trong CI/sandbox, và cũng không nên phụ thuộc vào
// dịch vụ bên thứ 3 để unit test pass/fail).
vi.mock("web-push", () => ({
  default: {
    setVapidDetails: vi.fn(),
    sendNotification: vi.fn(),
  },
}));

import webpush from "web-push";

const mockedSend = webpush.sendNotification as unknown as ReturnType<typeof vi.fn>;
const mockedSetVapid = webpush.setVapidDetails as unknown as ReturnType<typeof vi.fn>;

describe("Web Push transport", () => {
  beforeEach(() => {
    closeDb();
    migrate();
    mockedSend.mockReset();
    mockedSetVapid.mockReset();
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
  });

  afterAll(() => {
    closeDb();
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
  });

  it("GET /push/vapid-public-key trả null khi chưa cấu hình VAPID", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/push/vapid-public-key" });
    expect(JSON.parse(res.payload).publicKey).toBeNull();
    await app.close();
  });

  it("GET /push/vapid-public-key trả đúng key khi đã cấu hình qua env", async () => {
    process.env.VAPID_PUBLIC_KEY = "test-public-key";
    process.env.VAPID_PRIVATE_KEY = "test-private-key";
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/push/vapid-public-key" });
    expect(JSON.parse(res.payload).publicKey).toBe("test-public-key");
    await app.close();
  });

  it("POST /push/subscribe lưu subscription mới", async () => {
    const app = await buildApp();
    const bob = await createUser(app, "bob");
    const res = await app.inject({
      method: "POST",
      url: "/push/subscribe",
      payload: {
        userId: bob,
        subscription: {
          endpoint: "https://push.example.com/abc",
          keys: { p256dh: "p256dh-value", auth: "auth-value" },
        },
      },
    });
    expect(res.statusCode).toBe(201);

    const db = getDb();
    const row = db
      .prepare(`SELECT * FROM push_subscriptions WHERE endpoint = ?`)
      .get("https://push.example.com/abc");
    expect(row).toBeTruthy();

    await app.close();
  });

  it("subscribe với endpoint đã tồn tại -> upsert, không tạo duplicate", async () => {
    const app = await buildApp();
    const bob = await createUser(app, "bob");
    const basePayload = {
      userId: bob,
      subscription: {
        endpoint: "https://push.example.com/dup",
        keys: { p256dh: "a", auth: "b" },
      },
    };
    await app.inject({ method: "POST", url: "/push/subscribe", payload: basePayload });
    await app.inject({
      method: "POST",
      url: "/push/subscribe",
      payload: {
        ...basePayload,
        subscription: { ...basePayload.subscription, keys: { p256dh: "a2", auth: "b2" } },
      },
    });

    const db = getDb();
    const rows = db
      .prepare(`SELECT * FROM push_subscriptions WHERE endpoint = ?`)
      .all("https://push.example.com/dup") as { p256dh: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].p256dh).toBe("a2");

    await app.close();
  });

  it("POST /push/unsubscribe xoá subscription theo endpoint", async () => {
    const app = await buildApp();
    const bob = await createUser(app, "bob");
    await app.inject({
      method: "POST",
      url: "/push/subscribe",
      payload: {
        userId: bob,
        subscription: { endpoint: "https://push.example.com/rm", keys: { p256dh: "a", auth: "b" } },
      },
    });

    const res = await app.inject({
      method: "POST",
      url: "/push/unsubscribe",
      payload: { endpoint: "https://push.example.com/rm" },
    });
    expect(res.statusCode).toBe(204);

    const db = getDb();
    const row = db
      .prepare(`SELECT * FROM push_subscriptions WHERE endpoint = ?`)
      .get("https://push.example.com/rm");
    expect(row).toBeUndefined();

    await app.close();
  });

  it("có post mới + VAPID đã cấu hình -> gọi webpush.sendNotification cho follower đã subscribe", async () => {
    process.env.VAPID_PUBLIC_KEY = "test-public-key";
    process.env.VAPID_PRIVATE_KEY = "test-private-key";
    mockedSend.mockResolvedValue({ statusCode: 201 });

    const app = await buildApp();
    const alice = await createUser(app, "alice");
    const bob = await createUser(app, "bob");
    await follow(app, bob, alice);
    await app.inject({
      method: "POST",
      url: "/push/subscribe",
      payload: {
        userId: bob,
        subscription: { endpoint: "https://push.example.com/bob", keys: { p256dh: "a", auth: "b" } },
      },
    });

    await createPost(app, alice, "post kích hoạt web push");
    // sendWebPushForNotification chạy fire-and-forget trong notificationService
    // listener — đợi 1 khoảng ngắn để nó kịp chạy xong trước khi assert.
    await new Promise((r) => setTimeout(r, 50));

    expect(mockedSend).toHaveBeenCalledTimes(1);
    const [subscriptionArg, payloadArg] = mockedSend.mock.calls[0];
    expect(subscriptionArg.endpoint).toBe("https://push.example.com/bob");
    expect(JSON.parse(payloadArg).body).toBe("post kích hoạt web push");

    await app.close();
  });

  it("bỏ qua gửi (không throw, route /posts vẫn 201) khi VAPID chưa cấu hình", async () => {
    const app = await buildApp();
    const alice = await createUser(app, "alice");
    const bob = await createUser(app, "bob");
    await follow(app, bob, alice);
    await app.inject({
      method: "POST",
      url: "/push/subscribe",
      payload: {
        userId: bob,
        subscription: { endpoint: "https://push.example.com/bob2", keys: { p256dh: "a", auth: "b" } },
      },
    });

    const res = await createPost(app, alice, "post khi chưa cấu hình VAPID");
    expect(res.statusCode).toBe(201);

    await new Promise((r) => setTimeout(r, 50));
    expect(mockedSend).not.toHaveBeenCalled();

    await app.close();
  });

  it("subscription hết hạn (HTTP 410) -> đánh dấu invalid_at, không gửi lại lần sau", async () => {
    process.env.VAPID_PUBLIC_KEY = "test-public-key";
    process.env.VAPID_PRIVATE_KEY = "test-private-key";
    mockedSend.mockRejectedValueOnce(Object.assign(new Error("Gone"), { statusCode: 410 }));

    const app = await buildApp();
    const alice = await createUser(app, "alice");
    const bob = await createUser(app, "bob");
    await follow(app, bob, alice);
    await app.inject({
      method: "POST",
      url: "/push/subscribe",
      payload: {
        userId: bob,
        subscription: { endpoint: "https://push.example.com/expired", keys: { p256dh: "a", auth: "b" } },
      },
    });

    await createPost(app, alice, "post 1");
    await new Promise((r) => setTimeout(r, 50));

    const db = getDb();
    const row = db
      .prepare(`SELECT invalid_at FROM push_subscriptions WHERE endpoint = ?`)
      .get("https://push.example.com/expired") as { invalid_at: number | null };
    expect(row.invalid_at).not.toBeNull();

    mockedSend.mockClear();
    await createPost(app, alice, "post 2");
    await new Promise((r) => setTimeout(r, 50));
    expect(mockedSend).not.toHaveBeenCalled();

    await app.close();
  });

  it("thiếu trường bắt buộc khi subscribe -> 400", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/push/subscribe",
      payload: { userId: 1 },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("subscribe với userId không tồn tại -> 404", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/push/subscribe",
      payload: {
        userId: 999999,
        subscription: { endpoint: "https://push.example.com/ghost", keys: { p256dh: "a", auth: "b" } },
      },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
