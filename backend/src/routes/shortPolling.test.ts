import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { buildApp } from "../app.js";
import { closeDb, migrate } from "../db/index.js";
import { createUser, follow, createPost } from "../test/helpers.js";

describe("Short Polling transport (/notifications/poll)", () => {
  beforeEach(() => {
    // Mỗi test dùng 1 DB in-memory mới để tránh state rò rỉ giữa các test.
    closeDb();
    migrate();
  });

  afterAll(() => {
    closeDb();
  });

  it("trả về notification mới cho follower sau khi actor đăng bài", async () => {
    const app = await buildApp();
    const alice = await createUser(app, "alice");
    const bob = await createUser(app, "bob");
    await follow(app, bob, alice); // bob follows alice
    await createPost(app, alice, "hello world");

    const pollRes = await app.inject({
      method: "GET",
      url: `/notifications/poll?userId=${bob}&after=0`,
    });
    expect(pollRes.statusCode).toBe(200);
    const body = JSON.parse(pollRes.payload);

    expect(body.notifications).toHaveLength(1);
    expect(body.notifications[0].actor_display_name).toBe("alice");
    expect(body.notifications[0].script_preview).toBe("hello world");
    expect(body.nextAfter).toBe(body.notifications[0].id);
    expect(typeof body.suggestedIntervalMs).toBe("number");

    await app.close();
  });

  it("không trả lại notification khi poll lại với after = nextAfter (đã qua cursor)", async () => {
    const app = await buildApp();
    const alice = await createUser(app, "alice");
    const bob = await createUser(app, "bob");
    await follow(app, bob, alice);
    await createPost(app, alice, "post 1");

    const first = JSON.parse(
      (
        await app.inject({
          method: "GET",
          url: `/notifications/poll?userId=${bob}&after=0`,
        })
      ).payload
    );
    expect(first.notifications).toHaveLength(1);

    const second = JSON.parse(
      (
        await app.inject({
          method: "GET",
          url: `/notifications/poll?userId=${bob}&after=${first.nextAfter}`,
        })
      ).payload
    );
    expect(second.notifications).toHaveLength(0);
    // nextAfter giữ nguyên khi không có gì mới, để client không mất vị trí cursor
    expect(second.nextAfter).toBe(first.nextAfter);

    await app.close();
  });

  it("at-least-once: poll lại với after CŨ vẫn trả lại notification (client tự dedupe theo id)", async () => {
    const app = await buildApp();
    const alice = await createUser(app, "alice");
    const bob = await createUser(app, "bob");
    await follow(app, bob, alice);
    await createPost(app, alice, "post 1");

    const first = JSON.parse(
      (
        await app.inject({
          method: "GET",
          url: `/notifications/poll?userId=${bob}&after=0`,
        })
      ).payload
    );
    expect(first.notifications).toHaveLength(1);

    // Client "quên" cursor, poll lại từ 0 — mô phỏng client bị crash trước khi lưu cursor
    const retry = JSON.parse(
      (
        await app.inject({
          method: "GET",
          url: `/notifications/poll?userId=${bob}&after=0`,
        })
      ).payload
    );
    expect(retry.notifications).toHaveLength(1);
    expect(retry.notifications[0].id).toBe(first.notifications[0].id);

    await app.close();
  });

  it("chỉ trả notification cho đúng recipient (không rò rỉ sang user khác)", async () => {
    const app = await buildApp();
    const alice = await createUser(app, "alice");
    const bob = await createUser(app, "bob");
    const carol = await createUser(app, "carol");
    await follow(app, bob, alice); // chỉ bob follow alice, carol thì không
    await createPost(app, alice, "post riêng cho follower");

    const carolPoll = JSON.parse(
      (
        await app.inject({
          method: "GET",
          url: `/notifications/poll?userId=${carol}&after=0`,
        })
      ).payload
    );
    expect(carolPoll.notifications).toHaveLength(0);

    await app.close();
  });

  it("thiếu userId -> 400", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/notifications/poll",
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
