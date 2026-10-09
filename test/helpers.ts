import { createApp } from "../src/app.ts";
import { openDatabase } from "../src/db.ts";

export type App = ReturnType<typeof createApp>;

export async function call(app: App, path: string, body?: unknown, method = "POST", headers: Record<string, string> = {}) {
  const res = await app.request(path, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

// Dois criadores: Ana (cupom ANA10, utm ana) e Bruno (cupom BRUNO10, utm bruno).
export async function setup(options: { webhookSecret?: string } = {}) {
  const app = createApp({ db: openDatabase(":memory:"), clock: () => new Date("2026-05-10T12:00:00.000Z"), ...options });
  if (!options.webhookSecret) {
    await call(app, "/creators", { id: "crt_ana", name: "Ana", coupon_code: "ANA10", utm_slug: "ana" });
    await call(app, "/creators", { id: "crt_bruno", name: "Bruno", coupon_code: "BRUNO10", utm_slug: "bruno" });
  }
  return app;
}

export function order(overrides: Record<string, unknown> = {}) {
  return {
    id: 1001,
    total_price: "200.00",
    currency: "BRL",
    financial_status: "paid",
    discount_codes: [],
    landing_site: "/",
    ...overrides,
  };
}

export function refund(overrides: Record<string, unknown> = {}) {
  return { id: "rf_1", order_id: 1001, amount: "50.00", created_at: "2026-05-11T10:00:00.000Z", ...overrides };
}
