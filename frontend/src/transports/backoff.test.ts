import { describe, it, expect } from "vitest";
import { computeBackoffDelay } from "./backoff.js";

describe("computeBackoffDelay", () => {
  it("tăng theo cấp số nhân khi attempt tăng (không tính jitter)", () => {
    const opts = { baseMs: 1000, maxMs: 30_000, jitterRatio: 0 };
    expect(computeBackoffDelay(0, opts)).toBe(1000);
    expect(computeBackoffDelay(1, opts)).toBe(2000);
    expect(computeBackoffDelay(2, opts)).toBe(4000);
    expect(computeBackoffDelay(3, opts)).toBe(8000);
  });

  it("không vượt quá maxMs dù attempt rất lớn", () => {
    const delay = computeBackoffDelay(20, {
      baseMs: 1000,
      maxMs: 30_000,
      jitterRatio: 0,
    });
    expect(delay).toBe(30_000);
  });

  it("luôn không âm dù jitter kéo xuống thấp", () => {
    for (let i = 0; i < 50; i++) {
      const delay = computeBackoffDelay(0, {
        baseMs: 100,
        maxMs: 1000,
        jitterRatio: 1,
      });
      expect(delay).toBeGreaterThanOrEqual(0);
    }
  });

  it("attempt âm được xử lý như attempt=0 (không lỗi, không NaN)", () => {
    const delay = computeBackoffDelay(-5, {
      baseMs: 1000,
      maxMs: 30_000,
      jitterRatio: 0,
    });
    expect(delay).toBe(1000);
  });
});
