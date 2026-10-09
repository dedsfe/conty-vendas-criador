import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { attribute } from "./attribution.ts";
import type { Attribution } from "./attribution.ts";
import { formatCents, parseMoneyToCents } from "./money.ts";

export type Clock = () => Date;

type Row = Record<string, unknown>;

export type OrderOutcome =
  | { kind: "created"; order: OrderView }
  | { kind: "duplicate"; order: OrderView; changed: boolean }
  | { kind: "ignored"; reason: string }
  | { kind: "invalid"; message: string };

export type RefundOutcome =
  | { kind: "applied"; refund: RefundView }
  | { kind: "pending"; refund: RefundView }
  | { kind: "duplicate"; refund: RefundView; changed: boolean }
  | { kind: "rejected"; refund: RefundView }
  | { kind: "invalid"; message: string };

export type RefundView = {
  id: string;
  order_id: string;
  amount: string;
  status: string;
  reason: string | null;
  created_at: string;
  applied_at: string | null;
};

export type OrderView = {
  id: string;
  total: string;
  currency: string;
  status: "paid" | "partially_refunded" | "refunded";
  refunded: string;
  net: string;
  creator_id: string | null;
  attribution_source: string | null;
  conflict_creator_id: string | null;
};

function textId(value: unknown): string | null {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  return null;
}

function hash(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function utmContent(landingSite: unknown): string | null {
  if (typeof landingSite !== "string") return null;
  try {
    const value = new URL(landingSite, "https://loja.invalid").searchParams.get("utm_content");
    return value && value.trim() !== "" ? value.trim().toLowerCase() : null;
  } catch {
    return null;
  }
}

export class SalesService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: Clock = () => new Date(),
  ) {}

  createCreator(input: { id: string; name: string; coupon_code?: string | null; utm_slug?: string | null }) {
    this.db
      .prepare("INSERT INTO creators (id, name, coupon_code, utm_slug) VALUES (?, ?, ?, ?)")
      .run(
        input.id,
        input.name,
        input.coupon_code ? input.coupon_code.trim().toUpperCase() : null,
        input.utm_slug ? input.utm_slug.trim().toLowerCase() : null,
      );
    return this.db.prepare("SELECT * FROM creators WHERE id = ?").get(input.id);
  }

  private creatorByCoupon(code: string): string | null {
    const row = this.db.prepare("SELECT id FROM creators WHERE coupon_code = ?").get(code.trim().toUpperCase()) as
      | { id: string }
      | undefined;
    return row?.id ?? null;
  }

  private creatorByUtm(slug: string | null): string | null {
    if (!slug) return null;
    const row = this.db.prepare("SELECT id FROM creators WHERE utm_slug = ?").get(slug) as { id: string } | undefined;
    return row?.id ?? null;
  }

  // ---------- pedido ----------

  ingestOrder(payload: Record<string, unknown>): OrderOutcome {
    const id = textId(payload.id);
    if (!id) return { kind: "invalid", message: "id do pedido é obrigatório" };
    const totalCents = parseMoneyToCents(payload.total_price);
    if (totalCents === null) {
      return { kind: "invalid", message: 'total_price deve ser texto decimal com até 2 casas, ex.: "199.90"' };
    }
    const currency = typeof payload.currency === "string" ? payload.currency.trim().toUpperCase() : "";
    if (!/^[A-Z]{3}$/.test(currency)) return { kind: "invalid", message: "currency deve ter 3 letras, ex.: BRL" };
    if (typeof payload.financial_status !== "string") {
      return { kind: "invalid", message: "financial_status é obrigatório" };
    }
    const codes = Array.isArray(payload.discount_codes)
      ? payload.discount_codes
          .map((entry) => (entry && typeof entry === "object" ? (entry as { code?: unknown }).code : undefined))
          .filter((code): code is string => typeof code === "string" && code.trim() !== "")
      : [];

    const payloadHash = hash(payload);
    const existing = this.db.prepare("SELECT * FROM orders WHERE id = ?").get(id) as Row | undefined;
    if (existing) {
      // Webhook repetido: não soma de novo e não altera nada. Avisa se o conteúdo mudou.
      return { kind: "duplicate", order: this.orderView(existing), changed: existing.payload_hash !== payloadHash };
    }
    // Só pedido pago vira venda. Pendente/cancelado não é atribuído e não é guardado.
    if (payload.financial_status !== "paid") return { kind: "ignored", reason: `financial_status ${payload.financial_status}` };
    if (totalCents === 0) return { kind: "ignored", reason: "pedido de valor zero" };

    const slug = utmContent(payload.landing_site);
    const attribution: Attribution = attribute({
      couponCreatorIds: codes.map((code) => this.creatorByCoupon(code)),
      utmCreatorId: this.creatorByUtm(slug),
    });
    const now = this.clock().toISOString();

    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          `INSERT INTO orders (id, total_cents, currency, coupon_codes, utm_content, creator_id, attribution_source,
             conflict_creator_id, payload_hash, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          totalCents,
          currency,
          JSON.stringify(codes),
          slug,
          attribution.creator_id,
          attribution.source,
          attribution.conflict_creator_id,
          payloadHash,
          now,
        );
      if (attribution.creator_id) {
        this.db
          .prepare(
            "INSERT INTO attribution_ledger (order_id, creator_id, kind, refund_id, amount_cents, created_at) VALUES (?, ?, 'sale', NULL, ?, ?)",
          )
          .run(id, attribution.creator_id, totalCents, now);
      }
      // Estornos que chegaram antes do pedido: aplica agora, na ordem em que aconteceram.
      const pending = this.db
        .prepare("SELECT id FROM refunds WHERE order_id = ? AND status = 'pending' ORDER BY created_at, id")
        .all(id) as Array<{ id: string }>;
      for (const refund of pending) this.settleRefund(refund.id, id, now);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { kind: "created", order: this.orderView(this.db.prepare("SELECT * FROM orders WHERE id = ?").get(id) as Row) };
  }

  // ---------- estorno ----------

  ingestRefund(payload: Record<string, unknown>): RefundOutcome {
    const id = textId(payload.id);
    if (!id) return { kind: "invalid", message: "id do estorno é obrigatório" };
    const orderId = textId(payload.order_id);
    if (!orderId) return { kind: "invalid", message: "order_id é obrigatório" };
    const amountCents = parseMoneyToCents(payload.amount);
    if (amountCents === null || amountCents === 0) {
      return { kind: "invalid", message: 'amount deve ser texto decimal maior que zero, ex.: "50.00"' };
    }
    const received = this.clock();
    const createdAt =
      typeof payload.created_at === "string" && !Number.isNaN(new Date(payload.created_at).getTime())
        ? new Date(payload.created_at).toISOString()
        : received.toISOString();
    const currency = typeof payload.currency === "string" ? payload.currency.trim().toUpperCase() : null;

    const existing = this.db.prepare("SELECT * FROM refunds WHERE id = ?").get(id) as Row | undefined;
    if (existing) {
      // Estorno repetido: não aplica de novo. Devolve o que já estava registrado.
      return { kind: "duplicate", refund: this.refundView(existing), changed: Number(existing.amount_cents) !== amountCents };
    }

    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          "INSERT INTO refunds (id, order_id, amount_cents, currency, status, created_at, received_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)",
        )
        .run(id, orderId, amountCents, currency, createdAt, received.toISOString());
      const order = this.db.prepare("SELECT id FROM orders WHERE id = ?").get(orderId);
      if (order) this.settleRefund(id, orderId, received.toISOString());
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    const stored = this.db.prepare("SELECT * FROM refunds WHERE id = ?").get(id) as Row;
    const view = this.refundView(stored);
    if (stored.status === "applied") return { kind: "applied", refund: view };
    if (stored.status === "rejected") return { kind: "rejected", refund: view };
    return { kind: "pending", refund: view };
  }

  // Aplica ou rejeita um estorno de um pedido que já existe. Dentro de transação do chamador.
  private settleRefund(refundId: string, orderId: string, now: string): void {
    const refund = this.db.prepare("SELECT * FROM refunds WHERE id = ?").get(refundId) as Row;
    const order = this.db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId) as Row;
    const amount = Number(refund.amount_cents);
    const remaining = Number(order.total_cents) - Number(order.refunded_cents);

    let reason: string | null = null;
    if (refund.currency && refund.currency !== order.currency) reason = "moeda diferente da do pedido";
    else if (amount > remaining) reason = `estorno de ${formatCents(amount)} passa do saldo estornável de ${formatCents(remaining)}`;

    if (reason) {
      this.db.prepare("UPDATE refunds SET status = 'rejected', reason = ? WHERE id = ?").run(reason, refundId);
      return;
    }
    this.db.prepare("UPDATE refunds SET status = 'applied', applied_at = ? WHERE id = ?").run(now, refundId);
    this.db.prepare("UPDATE orders SET refunded_cents = refunded_cents + ? WHERE id = ?").run(amount, orderId);
    if (order.creator_id) {
      this.db
        .prepare(
          "INSERT INTO attribution_ledger (order_id, creator_id, kind, refund_id, amount_cents, created_at) VALUES (?, ?, 'refund', ?, ?, ?)",
        )
        .run(orderId, String(order.creator_id), refundId, -amount, now);
    }
  }

  // ---------- leitura ----------

  private orderView(row: Row): OrderView {
    const total = Number(row.total_cents);
    const refunded = Number(row.refunded_cents);
    return {
      id: String(row.id),
      total: formatCents(total),
      currency: String(row.currency),
      status: refunded === 0 ? "paid" : refunded >= total ? "refunded" : "partially_refunded",
      refunded: formatCents(refunded),
      net: formatCents(total - refunded),
      creator_id: (row.creator_id as string | null) ?? null,
      attribution_source: (row.attribution_source as string | null) ?? null,
      conflict_creator_id: (row.conflict_creator_id as string | null) ?? null,
    };
  }

  private refundView(row: Row): RefundView {
    return {
      id: String(row.id),
      order_id: String(row.order_id),
      amount: formatCents(Number(row.amount_cents)),
      status: String(row.status),
      reason: (row.reason as string | null) ?? null,
      created_at: String(row.created_at),
      applied_at: (row.applied_at as string | null) ?? null,
    };
  }

  getOrder(id: string) {
    const row = this.db.prepare("SELECT * FROM orders WHERE id = ?").get(id) as Row | undefined;
    const refunds = this.db.prepare("SELECT * FROM refunds WHERE order_id = ? ORDER BY created_at, id").all(id) as Row[];
    if (!row && refunds.length === 0) return null;
    const ledger = this.db
      .prepare("SELECT kind, refund_id, creator_id, amount_cents, created_at FROM attribution_ledger WHERE order_id = ? ORDER BY id")
      .all(id) as Row[];
    return {
      order: row ? this.orderView(row) : null,
      refunds: refunds.map((refund) => this.refundView(refund)),
      ledger: ledger.map((entry) => ({ ...entry, amount: formatCents(Math.abs(Number(entry.amount_cents))), sign: Number(entry.amount_cents) < 0 ? "-" : "+" })),
    };
  }

  creatorSales(creatorId: string) {
    const creator = this.db.prepare("SELECT id, name FROM creators WHERE id = ?").get(creatorId);
    if (!creator) return null;
    const sums = this.db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN kind = 'sale' THEN amount_cents END), 0) AS gross,
                COALESCE(SUM(CASE WHEN kind = 'refund' THEN -amount_cents END), 0) AS refunded,
                COALESCE(SUM(amount_cents), 0) AS net,
                COUNT(DISTINCT CASE WHEN kind = 'sale' THEN order_id END) AS orders
           FROM attribution_ledger WHERE creator_id = ?`,
      )
      .get(creatorId) as { gross: number; refunded: number; net: number; orders: number };
    return {
      creator,
      orders: Number(sums.orders),
      gross: formatCents(Number(sums.gross)),
      refunded: formatCents(Number(sums.refunded)),
      net: formatCents(Number(sums.net)),
    };
  }
}
