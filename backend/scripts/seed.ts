/**
 * Seed script — sinh lượng lớn user + follow relationship vào SQLite.
 *
 * Mục đích: phục vụ benchmark (Scenario C — Massive Multi-user Fan-out, và các
 * scenario cần nhiều user/follow graph thực tế). KHÔNG chạy script này trong
 * Claude/chat — chạy trực tiếp trên máy bạn (npm run seed).
 *
 * Deterministic: cùng SEED + cùng tham số → cùng dữ liệu, để benchmark tái lập được
 * (Rule: benchmark repeatability, Section 43).
 *
 * Usage:
 *   npm run seed -- --users=10000 --avgFollows=50 --seed=12345
 *
 * Env var tương đương cũng được hỗ trợ: SEED_USERS, SEED_AVG_FOLLOWS, SEED_RNG_SEED
 */

import { getDb, migrate, closeDb } from "../src/db/index.js";

// ── Deterministic PRNG (mulberry32) — không dùng Math.random() để tái lập được ──
function mulberry32(seed: number) {
  let a = seed;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface SeedOptions {
  userCount: number;
  avgFollowsPerUser: number;
  rngSeed: number;
  postCountPerUser: number;
}

function parseArgs(): SeedOptions {
  const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
      const [k, v] = a.replace(/^--/, "").split("=");
      return [k, v];
    })
  );

  return {
    userCount: Number(args.users ?? process.env.SEED_USERS ?? 1000),
    avgFollowsPerUser: Number(
      args.avgFollows ?? process.env.SEED_AVG_FOLLOWS ?? 20
    ),
    rngSeed: Number(args.seed ?? process.env.SEED_RNG_SEED ?? 12345),
    postCountPerUser: Number(args.postsPerUser ?? process.env.SEED_POSTS_PER_USER ?? 2),
  };
}

const SAMPLE_SCRIPTS = [
  "Hôm nay trời đẹp, đi cà phê thôi.",
  "Vừa fix xong 1 bug hại não suốt 3 tiếng.",
  "Ai có công thức phở ngon share mình với.",
  "Đang test hệ thống notification, mọi người đừng hoảng nếu spam thông báo.",
  "Cuối tuần này có ai rảnh đi leo núi không?",
  "Mới đọc xong 1 bài về SSE vs WebSocket, hay phết.",
  "Deploy xong rồi, ăn mừng thôi.",
  "Hỏi ngu tí: SQLite chịu được bao nhiêu concurrent write nhỉ?",
];

function run() {
  const opts = parseArgs();
  console.log("[seed] Options:", opts);

  migrate();
  const db = getDb();
  const rng = mulberry32(opts.rngSeed);

  const insertUser = db.prepare(
    "INSERT INTO users (display_name, created_at) VALUES (?, unixepoch())"
  );
  const insertFollow = db.prepare(
    "INSERT OR IGNORE INTO follows (follower_id, followee_id) VALUES (?, ?)"
  );
  const insertPost = db.prepare(
    "INSERT INTO posts (author_id, script, posted_at) VALUES (?, ?, ?)"
  );

  console.log(`[seed] Inserting ${opts.userCount} users...`);
  const userIds: number[] = [];
  const insertUsersTx = db.transaction((count: number) => {
    for (let i = 0; i < count; i++) {
      const info = insertUser.run(`user_${i + 1}`);
      userIds.push(Number(info.lastInsertRowid));
    }
  });
  insertUsersTx(opts.userCount);

  console.log(
    `[seed] Generating follow graph (~${opts.avgFollowsPerUser} follows/user)...`
  );
  let followCount = 0;
  const insertFollowsTx = db.transaction(() => {
    for (const followerId of userIds) {
      // Số lượng follow của user này dao động quanh avgFollowsPerUser (0..2x)
      const n = Math.round(rng() * opts.avgFollowsPerUser * 2);
      const targets = new Set<number>();
      let attempts = 0;
      // Giới hạn attempts để tránh vòng lặp vô hạn khi n gần bằng userCount
      const maxTargets = Math.min(n, opts.userCount - 1);
      while (targets.size < maxTargets && attempts < maxTargets * 5) {
        attempts++;
        const idx = Math.floor(rng() * userIds.length);
        const candidate = userIds[idx];
        if (candidate !== followerId) targets.add(candidate);
      }
      for (const followeeId of targets) {
        insertFollow.run(followerId, followeeId);
        followCount++;
      }
    }
  });
  insertFollowsTx();

  console.log(`[seed] Inserted ${followCount} follow relationships.`);

  console.log(
    `[seed] Generating ${opts.postCountPerUser} post(s)/user (no notifications fired — seed data only)...`
  );
  let postCount = 0;
  const now = Math.floor(Date.now() / 1000);
  const insertPostsTx = db.transaction(() => {
    for (const authorId of userIds) {
      for (let p = 0; p < opts.postCountPerUser; p++) {
        const script =
          SAMPLE_SCRIPTS[Math.floor(rng() * SAMPLE_SCRIPTS.length)];
        // Rải thời gian đăng lùi về quá khứ để có dữ liệu "lịch sử" hợp lý
        const postedAt = now - Math.floor(rng() * 60 * 60 * 24 * 30); // trong 30 ngày qua
        insertPost.run(authorId, script, postedAt);
        postCount++;
      }
    }
  });
  insertPostsTx();

  console.log(`[seed] Inserted ${postCount} posts.`);
  console.log(
    "[seed] NOTE: seed posts KHÔNG tạo events/notifications — đây là dữ liệu " +
      "nền cho benchmark đọc (feed, follower list), không phải để test luồng " +
      "notification realtime. Dùng API POST /posts qua benchmark generator để " +
      "test luồng notification thật."
  );

  closeDb();
  console.log("[seed] Done.");
}

run();
