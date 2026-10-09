import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS creators (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  coupon_code TEXT UNIQUE,
  utm_slug TEXT UNIQUE
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  total_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  coupon_codes TEXT NOT NULL,
  utm_content TEXT,
  creator_id TEXT,
  attribution_source TEXT,
  conflict_creator_id TEXT,
  refunded_cents INTEGER NOT NULL DEFAULT 0,
  payload_hash TEXT NOT NULL,
  received_at TEXT NOT NULL
);

-- Estorno guardado desde o primeiro dia em que chega, mesmo sem pedido (status 'pending').
CREATE TABLE IF NOT EXISTS refunds (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT,
  status TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  applied_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_refunds_order ON refunds (order_id);

-- Razão só de acréscimos: venda entra com valor positivo, estorno com negativo.
-- Nada aqui é apagado nem editado; o líquido do criador é a soma.
CREATE TABLE IF NOT EXISTS attribution_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL,
  creator_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  refund_id TEXT,
  amount_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_creator ON attribution_ledger (creator_id);
`;

export function openDatabase(path = ":memory:"): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}
