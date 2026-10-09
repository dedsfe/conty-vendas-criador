import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { openDatabase } from "./db.ts";

const port = Number(process.env.PORT ?? 3005);
const db = openDatabase(process.env.DB_PATH ?? ":memory:");
serve({ fetch: createApp({ db, webhookSecret: process.env.WEBHOOK_SECRET }).fetch, port, hostname: "127.0.0.1" });
console.log(`API de vendas em http://127.0.0.1:${port}${process.env.WEBHOOK_SECRET ? " (webhooks assinados)" : ""}`);
