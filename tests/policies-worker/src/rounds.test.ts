import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { route } from "@policies-worker/router";
import type { Env } from "@policies-worker/env";
import { D1ApiAdapter } from "@saas/db/runner";

/**
 * AS2 end to end through the worker's router, over a REAL SQLite database
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

describe("assign, send, acknowledge (AS2) over real SQLite", () => {
  let db: DatabaseSync;
  let sent: Sent[];
  let env: Env;

  beforeEach(async () => {
    db = migratedDatabase();
    sent = [];
    env = envFor(db, sent);
    const roster = await call(env, "POST", `/v1/organizations/${ORG}/staff`, {
      staff: [
        { fullName: "Ana Ruiz", email: "ana@shop.test", workState: "NY", location: "Astoria", role: "cashier" },
        { fullName: "Ben Cole", email: "ben@shop.test", workState: "NY", location: "Queens", role: "shift lead" },
        { fullName: "Cy Park", email: "cy@shop.test", workState: "CA", location: "Oakland", role: "cashier" },
      ],
    });
    expect(roster.status).toBe(201);
  });
  afterEach(() => db.close());

  it("sends one request per active NY member of staff and no others", async () => {
    const { pol, pov } = await publishedPolicy(env, "Anti-harassment", "harassment");
    const res = await call(env, "POST", `/v1/organizations/${ORG}/assignments`, {
      policyId: pol,
      audience: { states: ["NY"] },
    });
    expect(res.status).toBe(201);
    expect(res.body.data.tally).toEqual({ pending: 2, acknowledged: 0, superseded: 0 });
    expect(res.body.data.sent).toBe(2);
    expect(res.body.data.assignment.versionId).toBe(pov);
    expect(sent.map((s) => s.recipient.address).sort()).toEqual(["ana@shop.test", "ben@shop.test"]);
    expect(sent.every((s) => s.templateKey === "policy.acknowledgment_request")).toBe(true);
    expect(String(sent[0]!.templateData.link)).toMatch(/^https:\/\/console\.test\/ack\/[A-Za-z0-9_-]{22}$/);

    const rows = db.prepare("SELECT COUNT(*) AS n FROM policies_acknowledgments WHERE sent_at IS NOT NULL").get() as { n: number };
    expect(rows.n).toBe(2);
    // Only the hash is stored.
    const token = tokenOf(String(sent[0]!.templateData.link));
    const leaked = db.prepare("SELECT COUNT(*) AS n FROM policies_acknowledgments WHERE token_hash = ?").get(token) as { n: number };
    expect(leaked.n).toBe(0);
  });

  it("opens the link without a login, records version + time + IP once, then 409s; junk is 404", async () => {
    const { pol, pov } = await publishedPolicy(env, "Anti-harassment", "harassment");
    await call(env, "POST", `/v1/organizations/${ORG}/assignments`, { policyId: pol, audience: { states: ["NY"] } });
    const token = tokenOf(String(sent[0]!.templateData.link));
    const anon = { "x-actor-subject-id": "", "x-actor-subject-type": "" };

    const view = await call(env, "GET", `/v1/ack/${token}`, undefined, anon);
    expect(view.status).toBe(200);
    expect(view.body.data.policy.title).toBe("Anti-harassment");
    expect(view.body.data.version.version).toBe(1);
    expect(view.body.data.status).toBe("pending");

    const confirm = await call(env, "POST", `/v1/ack/${token}`, undefined, {
      ...anon,
      "x-client-ip": "198.51.100.23",
      "x-client-user-agent": "Mobile Safari",
    });
    expect(confirm.status).toBe(200);
    expect(confirm.body.data.receipt.version).toBe(1);

    const row = db
      .prepare("SELECT status, acknowledged_at, ack_ip, version_id FROM policies_acknowledgments WHERE status = 'acknowledged'")
      .get() as { status: string; acknowledged_at: string; ack_ip: string; version_id: string };
    expect(row.ack_ip).toBe("198.51.100.23");
    expect(Number.isNaN(new Date(row.acknowledged_at).getTime())).toBe(false);
    expect(`pov_${row.version_id.replace(/-/g, "")}`).toBe(pov);

    const replay = await call(env, "POST", `/v1/ack/${token}`, undefined, anon);
    expect(replay.status).toBe(409);
    expect(replay.body.error.details.reason).toBe("ack_already_recorded");

    const junk = await call(env, "POST", `/v1/ack/AAAAAAAAAAAAAAAAAAAAAA`, undefined, anon);
    expect(junk.status).toBe(404);
    expect(junk.body.error.details.reason).toBe("ack_link_invalid");

    const types = (db.prepare("SELECT DISTINCT type AS t FROM events_event_log").all() as { t: string }[]).map((r) => r.t);
    expect(types).toEqual(expect.arrayContaining(["assignment.created", "acknowledgment.sent", "acknowledgment.recorded"]));
  });

  it("reminds only the pending, with a fresh link that retires the old one", async () => {
    const { pol } = await publishedPolicy(env, "Handbook", "handbook");
    const created = await call(env, "POST", `/v1/organizations/${ORG}/assignments`, { policyId: pol });
    expect(created.body.data.tally.pending).toBe(3);
    const asg = created.body.data.assignment.id as string;
    const first = tokenOf(String(sent[0]!.templateData.link));
    await call(env, "POST", `/v1/ack/${first}`);

    sent.length = 0;
    const reminded = await call(env, "POST", `/v1/organizations/${ORG}/assignments/${asg}/remind`);
    expect(reminded.status).toBe(200);
    expect(reminded.body.data.reminded).toBe(2);
    expect(sent.every((s) => s.templateKey === "policy.acknowledgment_reminder")).toBe(true);

    const detail = await call(env, "GET", `/v1/organizations/${ORG}/assignments/${asg}`);
    expect(detail.body.data.tally).toEqual({ pending: 2, acknowledged: 1, superseded: 0 });
    expect(detail.body.data.acknowledgments).toHaveLength(3);
  });

  it("refuses to assign an unpublished policy and an audience that matches nobody", async () => {
    const created = await call(env, "POST", `/v1/organizations/${ORG}/policies`, { title: "Draft only" });
    const unpublished = await call(env, "POST", `/v1/organizations/${ORG}/assignments`, {
      policyId: created.body.data.policy.id,
    });
    expect(unpublished.status).toBe(409);
    expect(unpublished.body.error.details.reason).toBe("policy_unpublished");

    const { pol } = await publishedPolicy(env, "Safety", "safety");
    const nobody = await call(env, "POST", `/v1/organizations/${ORG}/assignments`, {
      policyId: pol,
      audience: { states: ["TX"] },
    });
    expect(nobody.status).toBe(422);
  });
});
