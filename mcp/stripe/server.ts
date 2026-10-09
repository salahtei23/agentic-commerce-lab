import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import Stripe from "stripe";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SERVER_DIR, "..", "..");
const LOG_FILE = resolve(PROJECT_ROOT, "artifacts", "stripe", "calls.log");

try {
  // STRIPE_SECRET_KEY lives in .env; loadEnvFile does not overwrite vars already set.
  process.loadEnvFile(resolve(PROJECT_ROOT, ".env"));
} catch {
  // .env may be missing; STRIPE_SECRET_KEY can still come from the environment.
}

const secretKey = process.env.STRIPE_SECRET_KEY;
if (!secretKey) {
  throw new Error("STRIPE_SECRET_KEY is not set. Create .env from .env.example (npm run dev writes it).");
}
if (secretKey.includes("_live_")) {
  throw new Error("Refusing to start: STRIPE_SECRET_KEY is a live key. Use a sandbox test key only (sk_test_/rk_test_).");
}

const stripe = new Stripe(secretKey);

mkdirSync(dirname(LOG_FILE), { recursive: true });

function logCall(entry: { tool: string; args: unknown; status: "ok" | "error"; detail?: unknown }): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  try {
    appendFileSync(LOG_FILE, line + "\n");
  } catch (err) {
    // Logging must never break a tool call.
    process.stderr.write(`[stripe-mcp] log write failed: ${(err as Error).message}\n`);
  }
}

function textResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true as const };
}

const server = new McpServer({ name: "zinc-stripe", version: "0.1.0" });

server.registerTool(
  "get_payment_intent",
  {
    description: "Retrieve a Stripe PaymentIntent by id. Read-only.",
    inputSchema: { payment_intent_id: z.string().min(1) },
    annotations: { readOnlyHint: true },
  },
  async ({ payment_intent_id }) => {
    try {
      const pi = await stripe.paymentIntents.retrieve(payment_intent_id);
      logCall({
        tool: "get_payment_intent",
        args: { payment_intent_id },
        status: "ok",
        detail: { pi_status: pi.status, amount: pi.amount, currency: pi.currency },
      });
      return textResult({
        id: pi.id,
        object: pi.object,
        status: pi.status,
        amount: pi.amount,
        amount_received: pi.amount_received,
        currency: pi.currency,
        created: pi.created,
        metadata: pi.metadata,
        latest_charge:
          typeof pi.latest_charge === "string" ? pi.latest_charge : (pi.latest_charge?.id ?? null),
      });
    } catch (err) {
      logCall({ tool: "get_payment_intent", args: { payment_intent_id }, status: "error", detail: (err as Error).message });
      return errorResult((err as Error).message);
    }
  },
);

server.registerTool(
  "list_events",
  {
    description: "List Stripe events whose object references the given PaymentIntent id. Read-only.",
    inputSchema: { payment_intent_id: z.string().min(1) },
    annotations: { readOnlyHint: true },
  },
  async ({ payment_intent_id }) => {
    try {
      const events: Array<{ id: string; type: string; created: number; object: string }> = [];
      for await (const ev of stripe.events.list({ limit: 100 })) {
        const obj = ev.data?.object as { id?: string } | undefined;
        if (obj?.id === payment_intent_id) {
          events.push({ id: ev.id, type: ev.type, created: ev.created, object: obj.id });
        }
      }
      logCall({
        tool: "list_events",
        args: { payment_intent_id },
        status: "ok",
        detail: { event_count: events.length },
      });
      return textResult({ payment_intent_id, count: events.length, events });
    } catch (err) {
      logCall({ tool: "list_events", args: { payment_intent_id }, status: "error", detail: (err as Error).message });
      return errorResult((err as Error).message);
    }
  },
);

server.registerTool(
  "refund_payment_intent",
  {
    description: "Refund a Stripe PaymentIntent. Write operation: the confirm argument must be true.",
    inputSchema: { payment_intent_id: z.string().min(1), confirm: z.literal(true) },
    // Intentionally no readOnlyHint: this tool mutates Stripe state.
  },
  async ({ payment_intent_id }) => {
    try {
      const refund = await stripe.refunds.create({ payment_intent: payment_intent_id });
      logCall({
        tool: "refund_payment_intent",
        args: { payment_intent_id, confirm: true },
        status: "ok",
        detail: { refund_id: refund.id, refund_status: refund.status, amount: refund.amount },
      });
      return textResult({
        id: refund.id,
        status: refund.status,
        payment_intent: payment_intent_id,
        amount: refund.amount,
        currency: refund.currency,
      });
    } catch (err) {
      logCall({ tool: "refund_payment_intent", args: { payment_intent_id, confirm: true }, status: "error", detail: (err as Error).message });
      return errorResult((err as Error).message);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
