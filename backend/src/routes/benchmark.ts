import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { fetchDeliveryAttemptsByNotificationIds } from "../domain/notificationQueries.js";
import { findHotPathTracesByNotificationIds } from "../domain/performanceInstrumentation.js";

function authorized(req: { headers: Record<string, string | string[] | undefined> }, reply: { code: (status: number) => { send: (body: unknown) => unknown } }): boolean {
  if (!config.benchmarkApiKey) { reply.code(404).send({ error: "Not Found" }); return false; }
  if (req.headers["x-benchmark-key"] !== config.benchmarkApiKey) { reply.code(401).send({ error: "Unauthorized" }); return false; }
  return true;
}

export async function benchmarkRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { notificationIds?: number[] } }>("/benchmark/delivery-attempts", async (req, reply) => {
    if (!authorized(req, reply)) return;
    const ids = Array.isArray(req.body?.notificationIds)
      ? req.body.notificationIds.filter((id) => Number.isInteger(id) && id > 0)
      : [];
    return { attempts: fetchDeliveryAttemptsByNotificationIds(ids) };
  });

  // Kept for manual/debug compatibility. Use POST from the benchmark runner so
  // large bursts cannot overflow a proxy/server request-target and cause HTTP 414.
  app.get<{ Querystring: { notificationIds?: string } }>("/benchmark/delivery-attempts", async (req, reply) => {
    if (!authorized(req, reply)) return;
    const ids = (req.query.notificationIds ?? "").split(",").map(Number).filter((id) => Number.isInteger(id) && id > 0);
    return { attempts: fetchDeliveryAttemptsByNotificationIds(ids) };
  });

  app.post<{ Body: { notificationIds?: number[] } }>("/benchmark/hot-path-traces", async (req, reply) => {
    if (!authorized(req, reply)) return;
    const ids = Array.isArray(req.body?.notificationIds)
      ? req.body.notificationIds.filter((id) => Number.isInteger(id) && id > 0)
      : [];
    return { traces: findHotPathTracesByNotificationIds(ids) };
  });
}
