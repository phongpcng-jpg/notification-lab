import { listUsers, getFollowers } from "./apiClient.js";

export interface PublisherSelection {
  publisherId: number;
  followerIds: number[];
}

/**
 * Chọn 1 "publisher" (người sẽ đăng bài trong suốt benchmark) — ưu tiên user
 * có nhiều follower nhất trong 1 mẫu (không quét toàn bộ DB nếu rất lớn, để
 * benchmark khởi động nhanh). Dừng sớm nếu đã tìm được publisher đủ
 * `minFollowers` follower cho scenario hiện tại.
 */
export async function pickPublisher(minFollowers: number): Promise<PublisherSelection> {
  const users = await listUsers();
  if (users.length === 0) {
    throw new Error(
      "Không có user nào trong DB. Chạy `cd backend && npm run seed` trước khi benchmark."
    );
  }

  const sampleSize = Math.min(users.length, 200);
  const sample = users.slice(0, sampleSize);

  let best: PublisherSelection | null = null;
  for (const u of sample) {
    const followers = await getFollowers(u.id);
    if (!best || followers.length > best.followerIds.length) {
      best = { publisherId: u.id, followerIds: followers.map((f) => f.id) };
    }
    if (best.followerIds.length >= minFollowers) break;
  }

  if (!best || best.followerIds.length === 0) {
    throw new Error(
      "Không tìm được publisher nào có follower trong mẫu " +
        `${sampleSize} user đầu. Seed lại với --avgFollows lớn hơn, hoặc ` +
        "tăng sample trong pickPublisher.ts nếu DB có nhiều user nhưng follower " +
        "graph phân bố không đều."
    );
  }

  if (best.followerIds.length < minFollowers) {
    console.warn(
      `[pickPublisher] Publisher tốt nhất tìm được chỉ có ${best.followerIds.length} ` +
        `follower, ít hơn subscriberCount yêu cầu (${minFollowers}). Benchmark sẽ chạy ` +
        `với ${best.followerIds.length} subscriber thay vì ${minFollowers} — kết quả cần ` +
        "được diễn giải với quy mô thực tế này, không phải quy mô cấu hình."
    );
  }

  return best;
}
