import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { route } from "@policies-worker/router";
import type { Env } from "@policies-worker/env";
import { D1ApiAdapter } from "@saas/db/runner";
import { createSqlExecutor } from "@saas/db/d1";
import { runRecollection } from "@policies-worker/recollection";

/**
 * AS3 end to end (the calendar, supersession, the exports) through the worker's router, over a REAL SQLite database
 * migrated from packages/db — create, publish, roster, assign, open the link,
 * acknowledge, replay. Only the membership/policy authorization hops and the
 * mailer are stand-ins.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_ROOT = resolve(__dirname, "../../..", "packages/db/src/migrations");
const ORG_UUID = "11111111-1111-4111-8111-111111111111";
const ORG = "org_11111111111111114111811111111111";
const BASE = "https://policies.internal";

function migratedDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const dirs = readdirSync(MIGRATIONS_ROOT)
    .filter((d) => existsSync(join(MIGRATIONS_ROOT, d, "up.sql")))
    .sort();
  for (const dir of dirs) {
    const sql = readFileSync(join(MIGRATIONS_ROOT, dir, "up.sql"), "utf8");
    for (const statement of D1ApiAdapter.splitStatements(sql)) db.exec(statement);
  }
  return db;
}

function d1Over(db: DatabaseSync): D1Database {
  return {
    prepare(query: string) {
      let bound: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) {
          bound = values;
          return statement;
        },
        all<T>() {
          const rows = db.prepare(query).all(...(bound as never[])) as T[];
          return Promise.resolve({ results: rows, success: true });
        },
      };
      return statement;
    },
  } as unknown as D1Database;
}

function jsonFetcher(body: unknown): Fetcher {
  return {
    fetch: () =>
      Promise.resolve(
        new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }),
      ),
  } as unknown as Fetcher;
}

interface Sent {
  templateKey: string;
  recipient: { address: string };
  templateData: Record<string, unknown>;
}

function mailer(sent: Sent[]): Fetcher {
  return {
    fetch: async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Sent;
      sent.push(body);
      return new Response(JSON.stringify({ data: { notification: { id: `ntf_${sent.length}` } } }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    },
  } as unknown as Fetcher;
}

function envFor(db: DatabaseSync, sent: Sent[]): Env {
  return {
    PLATFORM_DB: d1Over(db),
    MEMBERSHIP_WORKER: jsonFetcher({ data: { memberships: [{ orgId: ORG_UUID, role: "owner" }] } }),
    POLICY_WORKER: jsonFetcher({ data: { allow: true } }),
    NOTIFICATIONS_WORKER: mailer(sent),
    ACK_LINK_BASE_URL: "https://console.test",
    DEBUG_DELIVERY: "true",
    ENVIRONMENT: "test",
  } as Env;
}

const ACTOR_HEADERS = {
  "content-type": "application/json",
  "x-actor-subject-id": "usr_owner",
  "x-actor-subject-type": "user",
};

async function call(env: Env, method: string, path: string, body?: unknown, headers?: Record<string, string>) {
  const init: RequestInit = { method, headers: { ...ACTOR_HEADERS, ...(headers ?? {}) } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await route(new Request(`${BASE}${path}`, init), env);
  const text = await res.text();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- response bodies are asserted field by field
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, any>) : {} };
}

async function publishedPolicy(env: Env, title: string, category: string) {
  const created = await call(env, "POST", `/v1/organizations/${ORG}/policies`, { title, category });
  expect(created.status).toBe(201);
  const pol = created.body.data.policy.id as string;
  const draft = await call(env, "POST", `/v1/organizations/${ORG}/policies/${pol}/versions`, {
    bodyMd: "# Policy\nBe decent to each other.",
    summary: "Be decent.",
  });
  expect(draft.status).toBe(201);
  const pov = draft.body.data.version.id as string;
  const published = await call(env, "POST", `/v1/organizations/${ORG}/policies/${pol}/versions/${pov}/publish`);
  expect(published.status).toBe(200);
  return { pol, pov };
}

function tokenOf(link: string): string {
  return link.split("/ack/")[1]!;
}

function monthsAgo(now: Date, months: number): string {
  const d = new Date(now.getTime());
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString();
}

describe("the re-collection calendar (AS3) over real SQLite", () => {
  const NOW = new Date("2026-09-23T06:15:00.000Z");
  let db: DatabaseSync;
  let sent: Sent[];
  let env: Env;

  beforeEach(async () => {
    db = migratedDatabase();
    sent = [];
    env = envFor(db, sent);
    const roster = await call(env, "POST", `/v1/organizations/${ORG}/staff`, {
      staff: [
        { fullName: "Ana NY13", email: "ana@shop.test", workState: "NY" },
        { fullName: "Ben NY11", email: "ben@shop.test", workState: "NY" },
        { fullName: "Cy CA13", email: "cy@shop.test", workState: "CA" },
        { fullName: "Dee IL13", email: "dee@shop.test", workState: "IL" },
      ],
    });
    expect(roster.status).toBe(201);
  });
  afterEach(() => db.close());

  /** Assign to everyone, acknowledge every link, then backdate each acknowledgment. */
  async function acknowledgedLongAgo(category: string) {
    const { pol } = await publishedPolicy(env, `Policy ${category}`, category);
    const created = await call(env, "POST", `/v1/organizations/${ORG}/assignments`, { policyId: pol });
    expect(created.status).toBe(201);
    for (const s of sent) {
      const res = await call(env, "POST", `/v1/ack/${tokenOf(String(s.templateData.link))}`);
      expect(res.status).toBe(200);
    }
    const age: Record<string, number> = { "ana@shop.test": 13, "ben@shop.test": 11, "cy@shop.test": 13, "dee@shop.test": 13 };
    for (const [email, months] of Object.entries(age)) {
      db.prepare(
        `UPDATE policies_acknowledgments SET acknowledged_at = ?
          WHERE staff_id = (SELECT id FROM policies_staff WHERE email_lower = ?)`,
      ).run(monthsAgo(NOW, months), email);
    }
    sent.length = 0;
    return pol;
  }

  it("asks again NY at 13 months and IL at 13, not NY at 11 or CA at 13 — once per day", async () => {
    await acknowledgedLongAgo("harassment");
    const executor = createSqlExecutor(env.PLATFORM_DB as never);

    const first = await runRecollection(env, NOW, { executor });
    expect(first.roundsOpened).toBe(1);
    expect(first.recipients).toBe(2);
    expect(sent.map((s) => s.recipient.address).sort()).toEqual(["ana@shop.test", "dee@shop.test"]);

    const round = db.prepare("SELECT reason, schedule_key FROM policies_assignments WHERE reason = 'scheduled'").all() as { reason: string; schedule_key: string }[];
    expect(round).toHaveLength(1);
    expect(round[0]!.schedule_key).toMatch(/^scheduled:pol_[0-9a-f]{32}:2026-09-23$/);

    sent.length = 0;
    const second = await runRecollection(env, NOW, { executor });
    expect(second.roundsOpened).toBe(0);
    expect(sent).toHaveLength(0);
    const rounds = db.prepare("SELECT COUNT(*) AS n FROM policies_assignments WHERE reason = 'scheduled'").get() as { n: number };
    expect(rounds.n).toBe(1);

    const types = (db.prepare("SELECT DISTINCT type AS t FROM events_event_log").all() as { t: string }[]).map((r) => r.t);
    expect(types).toContain("recollection.round.opened");
  });

  it("applies New York's workplace-violence rule (Retail Worker Safety Act) and nothing for a category with no rule", async () => {
    await acknowledgedLongAgo("workplace_violence");
    await acknowledgedLongAgo("handbook");
    const executor = createSqlExecutor(env.PLATFORM_DB as never);
    const summary = await runRecollection(env, NOW, { executor });
    expect(summary.roundsOpened).toBe(1);
    expect(sent.map((s) => s.recipient.address)).toEqual(["ana@shop.test"]);
  });

  it("honours an admin's override of an interval", async () => {
    await acknowledgedLongAgo("harassment");
    const put = await call(env, "PUT", `/v1/organizations/${ORG}/rules/CA/harassment`, { intervalMonths: 12, enabled: true });
    expect(put.status).toBe(200);
    const off = await call(env, "PUT", `/v1/organizations/${ORG}/rules/IL/harassment`, { intervalMonths: 12, enabled: false });
    expect(off.status).toBe(200);
    const executor = createSqlExecutor(env.PLATFORM_DB as never);
    await runRecollection(env, NOW, { executor });
    expect(sent.map((s) => s.recipient.address).sort()).toEqual(["ana@shop.test", "cy@shop.test"]);
    const rules = await call(env, "GET", `/v1/organizations/${ORG}/rules`);
    expect(rules.body.data.rules.find((r: { state: string; category: string }) => r.state === "CA" && r.category === "harassment").intervalMonths).toBe(12);
  });

  it("a new version supersedes outstanding requests and opens a fresh round", async () => {
    const { pol } = await publishedPolicy(env, "Handbook", "handbook");
    await call(env, "POST", `/v1/organizations/${ORG}/assignments`, { policyId: pol, audience: { states: ["NY"] } });
    const oldLink = tokenOf(String(sent[0]!.templateData.link));
    await call(env, "POST", `/v1/ack/${tokenOf(String(sent[1]!.templateData.link))}`);
    sent.length = 0;

    const draft = await call(env, "POST", `/v1/organizations/${ORG}/policies/${pol}/versions`, { bodyMd: "v2" });
    const pov2 = draft.body.data.version.id as string;
    const published = await call(env, "POST", `/v1/organizations/${ORG}/policies/${pol}/versions/${pov2}/publish`);
    expect(published.status).toBe(200);
    expect(published.body.data.superseded).toBe(1);
    expect(published.body.data.newVersionRound.recipients).toBe(2);
    expect(sent.map((s) => s.recipient.address).sort()).toEqual(["ana@shop.test", "ben@shop.test"]);

    const stale = await call(env, "POST", `/v1/ack/${oldLink}`);
    expect(stale.status).toBe(404);
    const types = (db.prepare("SELECT DISTINCT type AS t FROM events_event_log").all() as { t: string }[]).map((r) => r.t);
    expect(types).toContain("acknowledgment.superseded");
  });

  it("exports per policy and per member of staff as text/csv naming version, time and IP", async () => {
    const { pol } = await publishedPolicy(env, "Anti-harassment", "harassment");
    await call(env, "POST", `/v1/organizations/${ORG}/assignments`, { policyId: pol, audience: { states: ["NY"] } });
    await call(env, "POST", `/v1/ack/${tokenOf(String(sent[0]!.templateData.link))}`, undefined, { "x-client-ip": "203.0.113.5" });

    const res = await route(new Request(`${BASE}/v1/organizations/${ORG}/policies/${pol}/export`, { headers: ACTOR_HEADERS }), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/csv/);
    const csv = await res.text();
    const lines = csv.trim().split("\r\n");
    expect(lines[0]).toBe("staff_name,staff_email,work_state,location,role,policy,version,version_id,status,sent_at,acknowledged_at,ack_ip,superseded_at");
    expect(lines).toHaveLength(3);
    expect(csv).toContain("203.0.113.5");

    const staff = await call(env, "GET", `/v1/organizations/${ORG}/staff`);
    const ana = staff.body.data.staff.find((s: { email: string }) => s.email === "ana@shop.test").id as string;
    const per = await route(new Request(`${BASE}/v1/organizations/${ORG}/staff/${ana}/export`, { headers: ACTOR_HEADERS }), env);
    expect(per.status).toBe(200);
    expect(per.headers.get("content-type")).toMatch(/^text\/csv/);
    expect((await per.text()).trim().split("\r\n")).toHaveLength(2);
  });
});
