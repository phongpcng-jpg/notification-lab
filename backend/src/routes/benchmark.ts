import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { fetchDeliveryAttemptsByNotificationIds } from "../domain/notificationQueries.js";

export async function benchmarkRoutes(app: FastifyInstance): Promise<void> {
  app.get<{
    Querystring: {
      notificationIds?: string;
    };
  }>("/benchmark/delivery-attempts", async (req, reply) => {
    if (!config.benchmarkApiKey) {
      return reply.code(404).send({ error: "Not Found" });
    }

    const providedKey = req.headers["x-benchmark-key"];
    if (providedKey !== config.benchmarkApiKey) {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    const ids = (req.query.notificationIds ?? "")
      .split(",")
      .map(Number)
      .filter((id) => Number.isInteger(id) && id > 0);

    return {
      attempts: fetchDeliveryAttemptsByNotificationIds(ids),
    };
  });
}
