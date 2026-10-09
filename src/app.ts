import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import type { Context } from "hono";
import { isValidSignature } from "./signature.ts";
import { SalesService } from "./sales.ts";

export type AppOptions = {
  db: DatabaseSync;
  clock?: () => Date;
  // Com segredo configurado, todo webhook precisa vir assinado (X-Shopify-Hmac-Sha256).
  webhookSecret?: string;
};

export function createApp(options: AppOptions) {
  const service = new SalesService(options.db, options.clock);
  const app = new Hono();

  // Lê o corpo cru (a assinatura é sobre o texto exato) e só depois interpreta o JSON.
  async function webhookBody(c: Context): Promise<{ body: Record<string, unknown> } | { response: Response }> {
    const raw = await c.req.text();
    if (options.webhookSecret && !isValidSignature(raw, c.req.header("x-shopify-hmac-sha256"), options.webhookSecret)) {
      return { response: c.json({ error: "assinatura inválida" }, 401) };
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { body: parsed as Record<string, unknown> };
    } catch {
      // cai no erro abaixo
    }
    return { response: c.json({ error: "corpo inválido" }, 400) };
  }

  app.get("/health", (c) => c.json({ ok: true }));

  app.post("/creators", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const id = typeof body.id === "string" ? body.id.trim() : "";
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!id || !name) return c.json({ error: "id e name são obrigatórios" }, 400);
    try {
      return c.json(
        service.createCreator({
          id,
          name,
          coupon_code: typeof body.coupon_code === "string" ? body.coupon_code : null,
          utm_slug: typeof body.utm_slug === "string" ? body.utm_slug : null,
        }),
        201,
      );
    } catch {
      return c.json({ error: "id, cupom ou utm_slug já em uso" }, 409);
    }
  });

  app.post("/webhooks/orders", async (c) => {
    const read = await webhookBody(c);
    if ("response" in read) return read.response;
    const outcome = service.ingestOrder(read.body);
    switch (outcome.kind) {
      case "created":
        return c.json({ status: "created", order: outcome.order }, 201);
      case "duplicate":
        return c.json({ status: "duplicate", changed: outcome.changed, order: outcome.order }, 200);
      case "ignored":
        return c.json({ status: "ignored", reason: outcome.reason }, 202);
      case "invalid":
        return c.json({ error: outcome.message }, 400);
    }
  });

  app.post("/webhooks/refunds", async (c) => {
    const read = await webhookBody(c);
    if ("response" in read) return read.response;
    const outcome = service.ingestRefund(read.body);
    switch (outcome.kind) {
      case "applied":
        return c.json({ status: "applied", refund: outcome.refund }, 201);
      case "pending":
        return c.json({ status: "pending", refund: outcome.refund }, 202);
      case "duplicate":
        return c.json({ status: "duplicate", changed: outcome.changed, refund: outcome.refund }, 200);
      case "rejected":
        return c.json({ status: "rejected", refund: outcome.refund }, 422);
      case "invalid":
        return c.json({ error: outcome.message }, 400);
    }
  });

  app.get("/orders/:id", (c) => {
    const found = service.getOrder(c.req.param("id"));
    return found ? c.json(found) : c.json({ error: "pedido não encontrado" }, 404);
  });

  app.get("/creators/:id/sales", (c) => {
    const sales = service.creatorSales(c.req.param("id"));
    return sales ? c.json(sales) : c.json({ error: "criador não encontrado" }, 404);
  });

  return app;
}
