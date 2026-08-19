import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { buildApp } from "../app.js";
import { closeDb, migrate } from "../db/index.js";
import { createUser, follow, createPost } from "../test/helpers.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Long Polling transport (/notifications/long-poll)", () => {
  beforeEach(() => {
    closeDb();
    migrate();
  });

  afterAll(() => {
    closeDb();
  });

  it("trả về ngay lập tức nếu đã có notification sẵn (không chờ)", async () => {
    const app = await buildApp();
    const alice = await createUser(app, "alice");
    const bob = await createUser(app, "bob");
    await follow(app, bob, alice);
    await createPost(app, alice, "post có sẵn");

    const start = Date.now();
    const res = await app.inject({
      method: "GET",
      url: `/notifications/long-poll?userId=${bob}&after=0`,
    });
    const elapsed = Date.now() - start;
    const body = JSON.parse(res.payload);

    expect(body.notifications).toHaveLength(1);
    expect(body.timedOut).toBe(false);
    // Phải trả gần như ngay, không chờ tới timeout (300ms trong test config)
    expect(elapsed).toBeLessThan(150);

    await app.close();
  });

  it("giữ request mở, trả về khi có post mới xuất hiện trong lúc đang chờ", async () => {
    const app = await buildApp();
    const alice = await createUser(app, "alice");
    const bob = await createUser(app, "bob");
    await follow(app, bob, alice);

    const pollPromise = app.inject({
      method: "GET",
      url: `/notifications/long-poll?userId=${bob}&after=0`,
    });

    // Đợi 1 chút để chắc chắn route handler đã kịp đăng ký waiter
    // trước khi post được tạo (mô phỏng đúng thứ tự long-polling thật).
    await sleep(50);
    await createPost(app, alice, "post trong lúc đang long-poll");

    const res = await pollPromise;
    const body = JSON.parse(res.payload);

    expect(body.notifications).toHaveLength(1);
    expect(body.timedOut).toBe(false);

    await app.close();
  });

  it("trả về timedOut=true với notifications rỗng khi hết LONG_POLL_TIMEOUT_MS mà không có gì mới", async () => {
    const app = await buildApp();
    const bob = await createUser(app, "bob");

    const start = Date.now();
    const res = await app.inject({
      method: "GET",
      url: `/notifications/long-poll?userId=${bob}&after=0`,
    });
    const elapsed = Date.now() - start;
    const body = JSON.parse(res.payload);

    expect(body.notifications).toHaveLength(0);
    expect(body.timedOut).toBe(true);
    expect(body.nextAfter).toBe(0);
    // Timeout cấu hình 300ms trong vitest.config.ts — cho phép sai số do
    // vòng check 25ms trong implementation.
    expect(elapsed).toBeGreaterThanOrEqual(280);
    expect(elapsed).toBeLessThan(600);

    await app.close();
  });

  it("nhiều long-poll request đồng thời cho cùng 1 user đều được đánh thức khi có notification mới", async () => {
    const app = await buildApp();
    const alice = await createUser(app, "alice");
    const bob = await createUser(app, "bob");
    await follow(app, bob, alice);

    const poll1 = app.inject({
      method: "GET",
      url: `/notifications/long-poll?userId=${bob}&after=0`,
    });
    const poll2 = app.inject({
      method: "GET",
      url: `/notifications/long-poll?userId=${bob}&after=0`,
    });

    await sleep(50);
    await createPost(app, alice, "post cho cả 2 request đang chờ");

    const [res1, res2] = await Promise.all([poll1, poll2]);
    const body1 = JSON.parse(res1.payload);
    const body2 = JSON.parse(res2.payload);

    // Cả 2 đều nhận được (duplicate delivery — chủ định, client tự dedupe theo id)
    expect(body1.notifications).toHaveLength(1);
    expect(body2.notifications).toHaveLength(1);
    expect(body1.notifications[0].id).toBe(body2.notifications[0].id);

    await app.close();
  });

  it("thiếu userId -> 400", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/notifications/long-poll" });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
