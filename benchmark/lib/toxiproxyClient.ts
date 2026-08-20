/**
 * Client tối giản cho Toxiproxy Admin API (https://github.com/Shopify/toxiproxy).
 * Dùng fetch thuần — KHÔNG thêm dependency `toxiproxy-node-client` để giữ
 * benchmark package nhẹ, vì API chỉ là vài endpoint HTTP/JSON đơn giản.
 *
 * CHỈ được import bởi `runners/runNetworkScenario.ts` (Scenario H). Không
 * module nào khác trong benchmark/ đụng tới file này — đảm bảo các scenario
 * khác không phụ thuộc Toxiproxy phải chạy.
 */

const ADMIN_API_URL = process.env.TOXIPROXY_API_URL ?? "http://localhost:8474";

export interface ToxicSpec {
  name: string;
  type: string; // 'latency' | 'timeout' | 'bandwidth' | 'slow_close' | 'reset_peer' | 'slicer' | ...
  stream?: "upstream" | "downstream";
  /** Xác suất áp dụng toxic cho mỗi connection mới, 0..1. Mặc định Toxiproxy = 1.0 */
  toxicity?: number;
  attributes: Record<string, number>;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${ADMIN_API_URL}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Toxiproxy API ${init?.method ?? "GET"} ${path} thất bại: HTTP ${res.status} ${text}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export async function isToxiproxyReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${ADMIN_API_URL}/version`);
    return res.ok;
  } catch {
    return false;
  }
}

export async function createProxy(params: {
  name: string;
  listen: string; // ví dụ "localhost:8666"
  upstream: string; // ví dụ "localhost:3000"
}): Promise<void> {
  // Xoá proxy cũ cùng tên nếu còn sót từ lần chạy trước bị crash — đảm bảo
  // trạng thái sạch, không kế thừa toxic cũ ngoài ý muốn.
  await deleteProxyIfExists(params.name);
  await request("/proxies", {
    method: "POST",
    body: JSON.stringify({ name: params.name, listen: params.listen, upstream: params.upstream, enabled: true }),
  });
}

export async function deleteProxyIfExists(name: string): Promise<void> {
  try {
    await request(`/proxies/${name}`, { method: "DELETE" });
  } catch {
    // Không tồn tại — bỏ qua, đây là trường hợp bình thường (lần chạy đầu tiên).
  }
}

export async function addToxic(proxyName: string, toxic: ToxicSpec): Promise<void> {
  await request(`/proxies/${proxyName}/toxics`, {
    method: "POST",
    body: JSON.stringify({
      name: toxic.name,
      type: toxic.type,
      stream: toxic.stream ?? "downstream",
      toxicity: toxic.toxicity ?? 1.0,
      attributes: toxic.attributes,
    }),
  });
}

export async function removeToxic(proxyName: string, toxicName: string): Promise<void> {
  try {
    await request(`/proxies/${proxyName}/toxics/${toxicName}`, { method: "DELETE" });
  } catch {
    // Đã bị xoá trước đó hoặc chưa từng thêm — bỏ qua.
  }
}
