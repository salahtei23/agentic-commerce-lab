import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SERVER_DIR, "..", "..");
const BASE_URL = "https://zinctm.cydeo.io";

try {
  // ZINCTM_TOKEN lives in .env; loadEnvFile does not overwrite vars already set.
  process.loadEnvFile(resolve(PROJECT_ROOT, ".env"));
} catch {
  // .env may be missing; ZINCTM_TOKEN can still come from the environment.
}

const rawToken = process.env.ZINCTM_TOKEN;
if (!rawToken) {
  throw new Error("ZINCTM_TOKEN is not set. It should be a ztm_ Personal Access Token in .env.");
}
const token: string = rawToken;

// ---------------------------------------------------------------------------
// Session: ZincTM authenticates with a Supabase session cookie obtained by
// exchanging the ztm_ PAT (POST /api/auth/exchange). Held in memory per process.
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

async function sendRequest(path: string, opts: { method?: string; query?: Record<string, unknown>; body?: unknown } = {}): Promise<ApiEnvelope> {
  const method = opts.method ?? "GET";
  const url = new URL(path, BASE_URL);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
  }
  const headers: Record<string, string> = { "x-zinctm-surface": "mcp" };
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
      error: { code: "NETWORK_ERROR", message: `Cannot reach the ZincTM API at ${BASE_URL}: ${(e as Error).message}` },
    };
  }
  captureCookies(res);

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

async function exchangeSession(pat: string): Promise<ApiEnvelope> {
  cookieJar.clear();
  return sendRequest("/api/auth/exchange", { method: "POST", body: { token: pat } });
}

async function apiRequest(path: string, opts: { method?: string; query?: Record<string, unknown>; body?: unknown } = {}): Promise<ApiEnvelope> {
  const first = await sendRequest(path, opts);
  // An expired/absent session self-heals by re-exchanging the PAT once and retrying.
  if (!first.ok && first.error.code === "UNAUTHENTICATED") {
    const ex = await exchangeSession(token);
    if (ex.ok) return sendRequest(path, opts);
  }
  return first;
}

// ---------------------------------------------------------------------------
// Result shaping: business failures are normal results flagged isError with the
// canonical code in structuredContent, so an agent can branch on e.g.
// ILLEGAL_TRANSITION instead of treating it as a transport fault.
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
// Tool schemas — the enums mirror the app's own types so an agent is told the
// legal values up front; the API still validates everything.
// ---------------------------------------------------------------------------
const TEST_TYPE = z.enum(["functional", "negative", "boundary", "e2e", "api", "regression", "security"]);
const PRIORITY = z.enum(["P1", "P2", "P3", "P4"]);
const SEVERITY = z.enum(["S1", "S2", "S3", "S4"]);
const CASE_STATUS = z.enum(["draft", "ready", "deprecated"]);
const FRAMEWORK = z.enum(["playwright", "selenium-java", "api", "other"]);
const AUTOMATION_STATUS = z.enum(["not_automated", "in_progress", "automated", "blocked"]);
const ENVIRONMENT = z.enum(["local", "preview", "prod"]);
const TRIGGER_SOURCE = z.enum(["manual", "agent", "ci"]);
const RESULT_STATUS = z.enum(["pass", "fail", "blocked", "skipped"]);
const RUN_STATUS = z.enum(["in_progress", "completed", "aborted"]);
const VERDICT = z.enum(["approved", "needs_work", "rejected"]);
const DEFECT_STATUS = z.enum([
  "new",
  "open",
  "in_progress",
  "fixed",
  "retest",
  "closed",
  "rejected",
  "deferred",
  "reopened",
]);
const RESOLUTION = z.enum(["fixed", "wont_fix", "duplicate", "cannot_reproduce", "not_a_bug"]);
const ISSUE_TYPE = z.enum(["test_case", "defect", "run"]);
const uuid = z.string().uuid();

const INSTRUCTIONS = [
  "ZincTM is the QA workspace where you manage the software-testing lifecycle for ZincBank.",
  "This server authenticates with ZINCTM_TOKEN from .env, exchanged for a session at boot.",
  "A normal workflow: read a requirement, write test cases against its acceptance criteria,",
  "link the spec files you generate, open a run, record results, and file a defect for each",
  "failure. Defect status only moves along the lifecycle; an illegal move returns",
  "ILLEGAL_TRANSITION and tells you which states are legal from where you are.",
].join(" ");

const server = new McpServer({ name: "zinctm", version: "0.1.3" }, { instructions: INSTRUCTIONS });

const tool = (name: string, description: string, shape: Record<string, z.ZodType>, handler: (args: never) => unknown) => {
  server.registerTool(name, { description, inputSchema: shape }, handler as never);
};

// ---------------------------------------------------------------- identity
tool(
  "tm_login",
  "Sign in to ZincTM with your CYDEO hive email and password — the same account as hive.cydeo.com. NOT a ZincBank account: ZincBank is the system under test and its logins do not work here. Only needed when no ZINCTM_TOKEN is configured.",
  { email: z.string().email(), password: z.string().min(1) },
  async ({ email, password }: { email: string; password: string }) => {
    cookieJar.clear();
    return fromApi(await apiRequest("/api/auth/login", { method: "POST", body: { email, password } }));
  },
);

tool(
  "tm_whoami",
  "Return the signed-in member profile (display name, cohort, role).",
  {},
  async () => fromApi(await apiRequest("/api/me")),
);

// ---------------------------------------------------------------- requirements
tool(
  "tm_list_requirements",
  "List your copy of the ZincBank requirements catalogue (46 entries across 8 modules). These are the requirements as the business wrote them, and they are deliberately vague — expect missing numbers, undefined terms and unstated boundaries. Read them before writing test cases, and improve the ones you cannot test. Optionally filter by module code: A (Getting Started), B (Your Accounts), C (Your Money at a Glance), D (Moving Money), E (Sending to People), F (Statements and History), G (Credit Card), H (Your Details and Security).",
  { moduleCode: z.string().optional() },
  async ({ moduleCode }: { moduleCode?: string }) =>
    fromApi(await apiRequest("/api/requirements", { query: { moduleCode } })),
);

tool(
  "tm_get_requirement",
  "Get one requirement with its full acceptance criteria, plus your existing test cases for it.",
  { requirementId: uuid },
  async ({ requirementId }: { requirementId: string }) =>
    fromApi(await apiRequest(`/api/requirements/${requirementId}`)),
);

tool(
  "tm_update_requirement",
  "Rewrite your own copy of a requirement so it becomes specific, measurable and testable. The catalogue ships deliberately vague: fix the wording, then raise a defect against the requirement labelled with the flaw you found (req:unmeasurable, req:ambiguous, req:contradictory, req:silent, req:solution-not-need, req:undated). The rewrite is the fix; the labelled defect is the diagnosis. The original is kept and stays visible for comparison — you cannot destroy it.",
  {
    requirementId: uuid,
    title: z.string().optional(),
    acceptanceCriteria: z.string().optional(),
  },
  async ({ requirementId, ...patch }: { requirementId: string; title?: string; acceptanceCriteria?: string }) =>
    fromApi(
      await apiRequest(`/api/requirements/${requirementId}`, {
        method: "PATCH",
        body: defined(patch),
      }),
    ),
);

// ---------------------------------------------------------------- test cases
tool(
  "tm_list_test_cases",
  "List your test cases, each with any linked automation script. Optionally filter by requirement or status.",
  { requirementId: uuid.optional(), status: CASE_STATUS.optional() },
  async ({ requirementId, status }: { requirementId?: string; status?: string }) =>
    fromApi(await apiRequest("/api/test-cases", { query: { requirementId, status } })),
);

tool(
  "tm_create_test_case",
  "Create a test case. The key (TC-001, TC-002, ...) is assigned for you. Write an expectedResult that states a checkable value — a status code, an error code, an exact amount — not \"it should work\".",
  {
    title: z.string().min(1),
    expectedResult: z.string().min(1),
    requirementId: uuid.optional(),
    preconditions: z.string().optional(),
    steps: z.array(z.string()).optional(),
    testType: TEST_TYPE.optional(),
    priority: PRIORITY.optional(),
    status: CASE_STATUS.optional(),
    labels: z.array(z.string()).optional(),
  },
  async (args: Record<string, unknown>) =>
    fromApi(await apiRequest("/api/test-cases", { method: "POST", body: defined(args) })),
);

tool(
  "tm_update_test_case",
  "Update fields on one of your test cases. Only the fields you pass are changed.",
  {
    testCaseId: uuid,
    title: z.string().optional(),
    expectedResult: z.string().optional(),
    requirementId: uuid.nullable().optional(),
    preconditions: z.string().nullable().optional(),
    steps: z.array(z.string()).optional(),
    testType: TEST_TYPE.optional(),
    priority: PRIORITY.optional(),
    status: CASE_STATUS.optional(),
    labels: z.array(z.string()).optional(),
  },
  async ({ testCaseId, ...patch }: { testCaseId: string } & Record<string, unknown>) =>
    fromApi(await apiRequest(`/api/test-cases/${testCaseId}`, { method: "PATCH", body: defined(patch) })),
);

tool(
  "tm_get_test_case",
  "Get one test case with its linked scripts.",
  { testCaseId: uuid },
  async ({ testCaseId }: { testCaseId: string }) => fromApi(await apiRequest(`/api/test-cases/${testCaseId}`)),
);

tool(
  "tm_delete_test_case",
  "Delete one of your test cases. Its results and script links go with it.",
  { testCaseId: uuid },
  async ({ testCaseId }: { testCaseId: string }) =>
    fromApi(await apiRequest(`/api/test-cases/${testCaseId}`, { method: "DELETE" })),
);

// ---------------------------------------------------------------- review
tool(
  "tm_review_test_case",
  "Review a test case against its requirement's acceptance criteria and record the verdict. Use this as the REVIEWER agent. Judge whether the case actually proves the AC, whether the expected result states a checkable value (a status code, an error code, an exact amount) rather than \"it should work\", and whether the steps are reproducible by someone who has not seen the requirement. A needs_work or rejected verdict MUST carry findings saying what is wrong — the author agent fixes the case with tm_update_test_case, which bumps its revision.",
  {
    testCaseId: uuid,
    verdict: VERDICT,
    findings: z.array(z.string()).optional(),
    summary: z.string().optional(),
    reviewer: z.string().optional(),
  },
  async ({ testCaseId, ...body }: { testCaseId: string } & Record<string, unknown>) =>
    fromApi(
      await apiRequest(`/api/test-cases/${testCaseId}/reviews`, {
        method: "POST",
        body: defined(body),
      }),
    ),
);

tool(
  "tm_list_reviews",
  "List every review recorded against one test case, newest first, with the case itself. Use it to see what a previous reviewer asked for before improving a case.",
  { testCaseId: uuid },
  async ({ testCaseId }: { testCaseId: string }) =>
    fromApi(await apiRequest(`/api/test-cases/${testCaseId}/reviews`)),
);

// ---------------------------------------------------------------- scripts
tool(
  "tm_link_script",
  "Point a test case at the automation script that implements it, and say how far along it is. Idempotent per (test case, framework) — call it again after editing the file. Setting automationStatus to \"automated\" is what makes the case count as automated on the coverage board.",
  {
    testCaseId: uuid,
    framework: FRAMEWORK.optional(),
    filePath: z.string().optional(),
    specName: z.string().optional(),
    repoUrl: z.string().optional(),
    automationStatus: AUTOMATION_STATUS.optional(),
    notes: z.string().optional(),
  },
  async (args: Record<string, unknown>) =>
    fromApi(await apiRequest("/api/scripts", { method: "POST", body: defined(args) })),
);

tool("tm_list_scripts", "List every automation script you have linked.", {}, async () =>
  fromApi(await apiRequest("/api/scripts")),
);

tool(
  "tm_delete_script",
  "Remove a script link.",
  { scriptId: uuid },
  async ({ scriptId }: { scriptId: string }) =>
    fromApi(await apiRequest(`/api/scripts/${scriptId}`, { method: "DELETE" })),
);

// ---------------------------------------------------------------- runs + results
tool(
  "tm_create_run",
  "Open a test run — one execution of your suite against one environment. Results are recorded inside it. Set triggerSource to \"agent\" when you are running the suite yourself.",
  {
    name: z.string().min(1),
    environment: ENVIRONMENT.optional(),
    triggerSource: TRIGGER_SOURCE.optional(),
    notes: z.string().optional(),
  },
  async (args: Record<string, unknown>) =>
    fromApi(await apiRequest("/api/runs", { method: "POST", body: defined(args) })),
);

tool("tm_list_runs", "List your test runs with pass/fail totals.", {}, async () =>
  fromApi(await apiRequest("/api/runs")),
);

tool(
  "tm_get_run",
  "Get one run with every result recorded in it.",
  { runId: uuid },
  async ({ runId }: { runId: string }) => fromApi(await apiRequest(`/api/runs/${runId}`)),
);

tool(
  "tm_record_results",
  "Record results into an open run — pass the whole suite at once. Re-recording a test case in the same run replaces its verdict.",
  {
    runId: uuid,
    results: z
      .array(
        z.object({
          testCaseId: uuid,
          status: RESULT_STATUS,
          durationMs: z.number().int().nonnegative().optional(),
          notes: z.string().optional(),
          evidenceUrl: z.string().optional(),
        }),
      )
      .min(1),
  },
  async ({ runId, results }: { runId: string; results: Array<Record<string, unknown>> }) =>
    fromApi(await apiRequest(`/api/runs/${runId}/results`, { method: "POST", body: { results } })),
);

tool(
  "tm_finish_run",
  "Close a run as completed or aborted, or reopen it with in_progress to add more results.",
  { runId: uuid, status: RUN_STATUS, notes: z.string().optional() },
  async ({ runId, status, notes }: { runId: string; status: string; notes?: string }) =>
    fromApi(await apiRequest(`/api/runs/${runId}`, { method: "PATCH", body: defined({ status, notes }) })),
);

// ---------------------------------------------------------------- defects
tool(
  "tm_file_defect",
  "File a defect. The key (BUG-001, ...) is assigned for you and it opens in state \"new\". Link it to the requirement, test case and run it came from — that trail is what makes it diagnosable later.",
  {
    title: z.string().min(1),
    description: z.string().optional(),
    stepsToReproduce: z.string().optional(),
    expectedResult: z.string().optional(),
    actualResult: z.string().optional(),
    severity: SEVERITY.optional(),
    priority: PRIORITY.optional(),
    environment: ENVIRONMENT.optional(),
    requirementId: uuid.optional(),
    testCaseId: uuid.optional(),
    runId: uuid.optional(),
    labels: z.array(z.string()).optional(),
  },
  async (args: Record<string, unknown>) =>
    fromApi(await apiRequest("/api/defects", { method: "POST", body: defined(args) })),
);

tool(
  "tm_list_defects",
  "List your defects. Pass status \"active\" for everything not closed or rejected, or a specific status.",
  { status: z.union([DEFECT_STATUS, z.literal("active")]).optional() },
  async ({ status }: { status?: string }) => fromApi(await apiRequest("/api/defects", { query: { status } })),
);

tool(
  "tm_get_defect",
  "Get one defect with its full lifecycle journal and the transitions that are legal from its current state.",
  { defectId: uuid },
  async ({ defectId }: { defectId: string }) => fromApi(await apiRequest(`/api/defects/${defectId}`)),
);

tool(
  "tm_update_defect",
  "Edit a defect’s descriptive fields. Status is NOT changed here — use tm_transition_defect.",
  {
    defectId: uuid,
    title: z.string().optional(),
    description: z.string().nullable().optional(),
    stepsToReproduce: z.string().nullable().optional(),
    expectedResult: z.string().nullable().optional(),
    actualResult: z.string().nullable().optional(),
    severity: SEVERITY.optional(),
    priority: PRIORITY.optional(),
    environment: ENVIRONMENT.optional(),
  },
  async ({ defectId, ...patch }: { defectId: string } & Record<string, unknown>) =>
    fromApi(await apiRequest(`/api/defects/${defectId}`, { method: "PATCH", body: defined(patch) })),
);

tool(
  "tm_transition_defect",
  "Move a defect to its next lifecycle state. Legal moves: new→open/rejected/deferred, open→in_progress/rejected/deferred, in_progress→fixed/open/deferred, fixed→retest/reopened, retest→closed/reopened, reopened→in_progress/open/deferred, deferred→open, rejected→reopened, closed→reopened. Anything else returns ILLEGAL_TRANSITION and names the legal states. Every move is journalled. Moving to 'closed' or 'rejected' requires a resolution (fixed, wont_fix, duplicate, cannot_reproduce, not_a_bug).",
  { defectId: uuid, toStatus: DEFECT_STATUS, note: z.string().optional(), resolution: RESOLUTION.optional() },
  async ({ defectId, toStatus, note, resolution }: { defectId: string; toStatus: string; note?: string; resolution?: string }) =>
    fromApi(
      await apiRequest(`/api/defects/${defectId}/transition`, {
        method: "POST",
        body: defined({ toStatus, note, resolution }),
      }),
    ),
);

// ---------------------------------------------------------------- comments
tool(
  "tm_add_comment",
  "Add a comment to a test case, defect, or run. Use it to record context a field cannot hold — why a bug was deprioritised, what a flaky result turned out to be, what you tried that did not work.",
  { issueType: ISSUE_TYPE, issueId: uuid, body: z.string().min(1) },
  async (args: Record<string, unknown>) => fromApi(await apiRequest("/api/comments", { method: "POST", body: args })),
);

tool(
  "tm_list_comments",
  "List the comment thread on one test case, defect, or run, oldest first.",
  { issueType: ISSUE_TYPE, issueId: uuid },
  async ({ issueType, issueId }: { issueType: string; issueId: string }) =>
    fromApi(await apiRequest("/api/comments", { query: { issueType, issueId } })),
);

tool(
  "tm_issue_history",
  "Every recorded field change on one issue, newest first — what changed, from what, to what, and when. Use it to answer questions like \"when was this dropped to S4?\".",
  { issueType: ISSUE_TYPE, issueId: uuid },
  async ({ issueType, issueId }: { issueType: string; issueId: string }) =>
    fromApi(await apiRequest(`/api/issues/${issueType}/${issueId}/history`)),
);

// ---------------------------------------------------------------- coverage
tool("tm_coverage_report", "The coverage picture: every requirement with its test-case count, how many are automated, the latest result, and open defect count. Requirements with no cases are included — those are the gaps.", {}, async () =>
  fromApi(await apiRequest("/api/coverage")),
);

// ---------------------------------------------------------------------------
// Boot: authenticate BEFORE the transport connects so the first tool call an
// agent makes already carries a session. A bad/expired token is NON-FATAL —
// log the failure code (never the token or session) and fall back to tm_login.
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const res = await exchangeSession(token);
  if (!res.ok) {
    process.stderr.write(
      `zinctm: ZINCTM_TOKEN exchange failed (${res.error.code}: ${res.error.message}). Falling back to interactive tm_login.\n`,
    );
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`zinctm failed to start: ${(err as Error).message}\n`);
  process.exit(1);
});
