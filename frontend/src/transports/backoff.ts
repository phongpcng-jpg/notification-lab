/**
 * Exponential backoff với jitter — dùng cho short polling khi request lỗi
 * (network error, timeout, 5xx...), tránh "thundering herd" khi nhiều client
 * cùng lỗi rồi cùng retry đồng loạt (jitter làm lệch thời điểm retry).
 *
 * Pure function — không side effect, dễ unit test độc lập với DOM/network.
 */
export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
  /** Tỉ lệ jitter (0..1). 0.3 nghĩa là delay dao động ±30% quanh giá trị exponential. */
  jitterRatio?: number;
}

export function computeBackoffDelay(
  attempt: number,
  opts: BackoffOptions
): number {
  const { baseMs, maxMs, jitterRatio = 0.3 } = opts;
  const safeAttempt = Math.max(0, attempt);
  const exponential = Math.min(maxMs, baseMs * 2 ** safeAttempt);
  const jitterSpan = exponential * jitterRatio;
  const jitter = (Math.random() * 2 - 1) * jitterSpan; // [-jitterSpan, +jitterSpan]
  return Math.max(0, Math.round(exponential + jitter));
}
