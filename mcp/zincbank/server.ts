import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SERVER_DIR, "..", "..");
const BASE_URL = "https://zincbank.cydeo.io";

try {
  // ZINCBANK_USERNAME / ZINCBANK_PASSWORD live in .env; loadEnvFile does not overwrite vars already set.
  process.loadEnvFile(resolve(PROJECT_ROOT, ".env"));
} catch {
  // .env may be missing; the credentials can still come from the environment.
}

const rawUsername = process.env.ZINCBANK_USERNAME;
const rawPassword = process.env.ZINCBANK_PASSWORD;
if (!rawUsername || !rawPassword) {
  throw new Error("ZINCBANK_USERNAME and ZINCBANK_PASSWORD must be set in .env.");
}
const username: string = rawUsername;
const password: string = rawPassword;

// ---------------------------------------------------------------------------
// Session: ZincBank authenticates with a Supabase session cookie obtained by
// POST /api/auth/login { email, password }. Held in memory per process.
// ---------------------------------------------------------------------------
const cookieJar = new Map<string, string>();

function cookieHeader(): string {
  return Array.from(cookieJar.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

function captureCookies(res: Response): void {
  const setCookies = res.headers.getSetCookie?.() ?? [];
  for (const sc of setCookies) {
    const first = sc.split(";")[0];
    const eq = first.indexOf("=");
    if (eq < 0) continue;
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    if (value === "" || /max-age=0\b/i.test(sc)) cookieJar.delete(name);
    else cookieJar.set(name, value);
  }
}

type ApiEnvelope =
  | { ok: true; status: number; data: unknown }
  | { ok: false; status: number; error: { code: string; message: string; details?: unknown } };

async function sendRequest(
  path: string,
  opts: { method?: string; query?: Record<string, unknown>; body?: unknown; headers?: Record<string, string>; raw?: "base64" } = {},
): Promise<ApiEnvelope> {
  const method = opts.method ?? "GET";
  const url = new URL(path, BASE_URL);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
  }
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const c = cookieHeader();
  if (c) headers["cookie"] = c;

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch (e) {
    return {
      ok: false,
      status: 0,
      error: { code: "NETWORK_ERROR", message: `Cannot reach the ZincBank API at ${BASE_URL}: ${(e as Error).message}` },
    };
  }
  captureCookies(res);

  if (opts.raw === "base64") {
    if (!res.ok) return parseEnvelope(res);
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      ok: true,
      status: res.status,
      data: { contentType: res.headers.get("content-type") ?? "application/octet-stream", base64: buf.toString("base64") },
    };
  }

  return parseEnvelope(res);
}

async function parseEnvelope(res: Response): Promise<ApiEnvelope> {
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON body */
  }
  if (json && typeof json === "object" && "ok" in (json as Record<string, unknown>)) {
    const env = json as { ok: boolean; data?: unknown; error?: { code: string; message: string; details?: unknown } };
    if (env.ok) return { ok: true, status: res.status, data: env.data };
    return {
      ok: false,
      status: res.status,
      error: env.error ?? { code: "INTERNAL_ERROR", message: "Malformed error envelope" },
    };
  }
  return {
    ok: false,
    status: res.status,
    error: { code: "INTERNAL_ERROR", message: `Unexpected non-envelope response (HTTP ${res.status})` },
  };
}

// The credentials used for the boot login and for self-healing an expired
// session. zb_login swaps them when a caller signs in with different ones.
let activeUser = username;
let activePassword = password;

async function login(email: string, pw: string): Promise<ApiEnvelope> {
  cookieJar.clear();
  return sendRequest("/api/auth/login", { method: "POST", body: { email, password: pw } });
}

async function apiRequest(
  path: string,
  opts: { method?: string; query?: Record<string, unknown>; body?: unknown; headers?: Record<string, string>; raw?: "base64" } = {},
): Promise<ApiEnvelope> {
  const first = await sendRequest(path, opts);
  // An expired/absent session self-heals by re-logging in once and retrying.
  if (!first.ok && first.error.code === "UNAUTHENTICATED") {
    const re = await login(activeUser, activePassword);
    if (re.ok) return sendRequest(path, opts);
  }
  return first;
}

// ---------------------------------------------------------------------------
// Result shaping: business failures are normal results flagged isError with the
// canonical code in structuredContent, so an agent can branch on codes instead
// of treating them as transport faults.
// ---------------------------------------------------------------------------
function okResult(data: unknown) {
  const structured = (data ?? {}) as Record<string, unknown>;
  return {
    content: [{ type: "text" as const, text: JSON.stringify(structured) }],
    structuredContent: structured,
  };
}

function errorResult(error: { code: string; message: string; details?: unknown }) {
  const structured: Record<string, unknown> = { errorCode: error.code, message: error.message };
  if (error.details !== undefined) structured.details = error.details;
  return {
    content: [{ type: "text" as const, text: `Error ${error.code}: ${error.message}` }],
    structuredContent: structured,
    isError: true as const,
  };
}

function fromApi(r: ApiEnvelope) {
  return r.ok ? okResult(r.data) : errorResult(r.error);
}

/** Drop keys the caller omitted so a PATCH never blanks a field it did not mention. */
function defined(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

// ---------------------------------------------------------------------------
// Tool schemas — enums mirror the app's own options; the API validates anyway.
// ---------------------------------------------------------------------------
const ACCOUNT_TYPE = z.enum(["checking", "savings"]);
const EMPLOYMENT_STATUS = z.enum(["employed", "self_employed", "retired", "student", "unemployed"]);
const cents = z.number().int().min(0);
const uuid = z.string().uuid();

const INSTRUCTIONS = [
  "ZincBank is the banking system under test at https://zincbank.cydeo.io.",
  "This server authenticates with ZINCBANK_USERNAME and ZINCBANK_PASSWORD from .env, logging in at boot.",
  "Money is integer cents: every amount field is a *Cents integer, never a dollar string.",
  "A normal workflow: read the dashboard or an account, list transactions, move money between",
  "your own accounts with zb_transfer, and manage the credit card (zb_apply_credit_card,",
  "zb_pay_credit_card, zb_get_credit_statement). Failures return { errorCode, message } with",
  "isError so you can branch on codes like VALIDATION_ERROR or INSUFFICIENT_FUNDS.",
].join(" ");

const server = new McpServer({ name: "zincbank", version: "0.1.0" }, { instructions: INSTRUCTIONS });

const tool = (name: string, description: string, shape: Record<string, z.ZodType>, handler: (args: never) => unknown) => {
  server.registerTool(name, { description, inputSchema: shape }, handler as never);
};

// ---------------------------------------------------------------- identity + auth
tool(
  "zb_login",
  "Sign in to ZincBank with an email and password. Normally unnecessary — the server logs in at boot with ZINCBANK_USERNAME and ZINCBANK_PASSWORD from .env — but use it to switch to a different ZincBank account. NOT a ZincTM / Zinc Store credential.",
  { email: z.string().email(), password: z.string().min(1) },
  async ({ email, password }: { email: string; password: string }) => {
    activeUser = email;
    activePassword = password;
    return fromApi(await login(email, password));
  },
);

tool("zb_get_profile", "Return the signed-in customer's profile (name, phone, address, email).", {}, async () =>
  fromApi(await apiRequest("/api/profile")),
);

tool(
  "zb_update_profile",
  "Update profile fields. Only the fields you pass are changed.",
  {
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    phone: z.string().optional(),
    addressLine: z.string().optional(),
  },
  async (args: Record<string, unknown>) =>
    fromApi(await apiRequest("/api/profile", { method: "PATCH", body: defined(args) })),
);

tool(
  "zb_change_password",
  "Change the account password. Pass the current password and the new one.",
  { currentPassword: z.string().min(1), newPassword: z.string().min(1) },
  async (args: Record<string, unknown>) =>
    fromApi(await apiRequest("/api/auth/change-password", { method: "POST", body: args })),
);

// ---------------------------------------------------------------- accounts + money
tool(
  "zb_get_dashboard",
  "The at-a-glance picture: total deposits (totalDepositCents), every account, the credit card, and recent transactions.",
  {},
  async () => fromApi(await apiRequest("/api/dashboard")),
);

tool("zb_list_accounts", "List every bank account with type, status, account number and balance (balanceCents).", {}, async () =>
  fromApi(await apiRequest("/api/accounts")),
);

tool("zb_get_account", "Get one account by id with its balance.", { accountId: uuid }, async ({ accountId }: { accountId: string }) =>
  fromApi(await apiRequest(`/api/accounts/${accountId}`)),
);

tool(
  "zb_open_account",
  "Open a new account. The app's own UI only offers savings accounts.",
  { type: ACCOUNT_TYPE },
  async ({ type }: { type: string }) => fromApi(await apiRequest("/api/accounts", { method: "POST", body: { type } })),
);

tool(
  "zb_list_transactions",
  "List transactions for an account, newest first. Paginate with limit (default 50) and offset.",
  { accountId: uuid, limit: z.number().int().min(1).max(500).optional(), offset: z.number().int().min(0).optional() },
  async ({ accountId, limit, offset }: { accountId: string; limit?: number; offset?: number }) =>
    fromApi(await apiRequest("/api/transactions", { query: { accountId, limit, offset } })),
);

tool(
  "zb_transfer",
  "Move money between your own accounts. amountCents is the amount in integer cents. An idempotency key is generated for you so a retry cannot double-post.",
  {
    fromAccountId: uuid,
    toAccountId: uuid,
    amountCents: cents.min(1),
    memo: z.string().optional(),
  },
  async ({ fromAccountId, toAccountId, amountCents, memo }: { fromAccountId: string; toAccountId: string; amountCents: number; memo?: string }) =>
    fromApi(
      await apiRequest("/api/transfers", {
        method: "POST",
        headers: { "Idempotency-Key": randomUUID() },
        body: defined({ fromAccountId, toAccountId, amountCents, memo }),
      }),
    ),
);

// ---------------------------------------------------------------- credit card
tool("zb_get_credit_card", "The credit card: balance owed (balanceCents), credit limit, available credit and APR.", {}, async () =>
  fromApi(await apiRequest("/api/credit/card")),
);

tool(
  "zb_apply_credit_card",
  "Apply for the Zinc credit card. annualIncomeCents, monthlyHousingCents and monthlyDebtCents are integer cents; employmentStatus is one of employed, self_employed, retired, student, unemployed. The decision comes back as approved or declined with a tier and approvedLimitCents.",
  {
    annualIncomeCents: cents,
    employmentStatus: EMPLOYMENT_STATUS,
    monthlyHousingCents: cents,
    monthlyDebtCents: cents,
  },
  async (args: Record<string, unknown>) =>
    fromApi(await apiRequest("/api/credit/apply", { method: "POST", body: args })),
);

tool(
  "zb_pay_credit_card",
  "Pay down the credit card balance from one of your accounts. amountCents is the payment in integer cents.",
  { fromAccountId: uuid, amountCents: cents.min(1) },
  async ({ fromAccountId, amountCents }: { fromAccountId: string; amountCents: number }) =>
    fromApi(await apiRequest("/api/credit/pay", { method: "POST", body: { fromAccountId, amountCents } })),
);

tool(
  "zb_get_credit_statement",
  "Download the monthly credit card statement for a given year and month (1-12) as a PDF. The result is base64-encoded with its content type; decode it to get the file.",
  { cardId: uuid, year: z.number().int().min(2000).max(2100), month: z.number().int().min(1).max(12) },
  async ({ cardId, year, month }: { cardId: string; year: number; month: number }) =>
    fromApi(await apiRequest(`/api/credit/statements/${cardId}`, { query: { year, month }, raw: "base64" })),
);

// ---------------------------------------------------------------------------
// Boot: authenticate BEFORE the transport connects so the first tool call an
// agent makes already carries a session. A bad credential is NON-FATAL — log
// the failure code (never the password) and fall back to zb_login.
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const res = await login(activeUser, activePassword);
  if (!res.ok) {
    process.stderr.write(
      `zincbank: boot login failed (${res.error.code}: ${res.error.message}). Falling back to interactive zb_login.\n`,
    );
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`zincbank failed to start: ${(err as Error).message}\n`);
  process.exit(1);
});
