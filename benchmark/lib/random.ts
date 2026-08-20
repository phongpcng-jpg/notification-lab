/**
 * mulberry32 — cùng thuật toán với backend/scripts/seed.ts. Trùng lặp có chủ
 * đích: benchmark/ là package độc lập (không import chéo backend/src để
 * tránh coupling giữa "công cụ đo" và "hệ thống được đo"), nên 1 hàm PRNG
 * ~10 dòng được chấp nhận duplicate thay vì tạo dependency chéo phức tạp.
 */
export function mulberry32(seed: number): () => number {
  let a = seed;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
