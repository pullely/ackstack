import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSqlExecutor, type D1Binding } from "@saas/db/d1";
import { createPoliciesRepository, createRoundsRepository } from "@saas/db/policies";
import { asUuid, type Uuid } from "@saas/db/ids";
import { D1ApiAdapter } from "@saas/db/runner";

// AS2 against a REAL SQLite engine. The D1 executor reports rowCount as the
// rows RETURNED (trap 22), so a mocked executor cannot tell whether a write
// without RETURNING "worked"; this suite can.

const splitStatements = D1ApiAdapter.splitStatements;
const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_ROOT = resolve(__dirname, "../../..", "packages/db/src/migrations");

function d1Over(db: DatabaseSync): D1Binding {
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
  } as unknown as D1Binding;
}

function migratedDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const dirs = readdirSync(MIGRATIONS_ROOT)
    .filter((d) => existsSync(join(MIGRATIONS_ROOT, d, "up.sql")))
    .sort();
  for (const dir of dirs) {
    const sql = readFileSync(join(MIGRATIONS_ROOT, dir, "up.sql"), "utf8");
    for (const statement of splitStatements(sql)) db.exec(statement);
  }
  return db;
}

const ORG = asUuid("11111111-1111-4111-8111-111111111111");
const T0 = new Date("2026-03-01T12:00:00.000Z");

function uuid(n: number): Uuid {
  return asUuid(`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`);
}

describe("assignment rounds against a real SQLite engine", () => {
  let db: DatabaseSync;
  let executor: ReturnType<typeof createSqlExecutor>;

  beforeEach(() => {
    db = migratedDatabase();
    executor = createSqlExecutor(d1Over(db));
  });
  afterEach(() => db.close());

  async function seed() {
    const policies = createPoliciesRepository(executor);
    const policy = await policies.createPolicy({
      id: uuid(1),
      orgId: ORG,
      title: "Anti-harassment",
      slug: "anti-harassment",
      slugLower: "anti-harassment",
      category: "harassment",
      createdAt: T0,
    });
    if (!policy.ok) throw new Error("policy");
    const v1 = await policies.createVersion({
      id: uuid(2),
      orgId: ORG,
      policyId: uuid(1),
      bodyMd: "Be kind.",
      summary: "Be kind",
      createdAt: T0,
    });
    if (!v1.ok) throw new Error("version");
    const published = await policies.publishVersion(ORG, uuid(2), "usr_1", T0);
    if (!published.ok) throw new Error("publish");
    const staff = [
      { n: 10, name: "Ana", email: "ana@x.test", state: "NY", location: "Astoria", role: "cashier" },
      { n: 11, name: "Ben", email: "ben@x.test", state: "NY", location: "Queens", role: "shift lead" },
      { n: 12, name: "Cy", email: "cy@x.test", state: "CA", location: "Oakland", role: "cashier" },
      { n: 13, name: "Di", email: "di@x.test", state: "NY", location: "Astoria", role: "cashier" },
    ];
    for (const s of staff) {
      const r = await policies.upsertStaff({
        id: uuid(s.n),
        orgId: ORG,
        fullName: s.name,
        email: s.email,
        emailLower: s.email,
        workState: s.state,
        location: s.location,
        role: s.role,
        createdAt: T0,
      });
      if (!r.ok) throw new Error("staff");
    }
    // Di has left: deactivated staff are never in an audience.
    await policies.setStaffStatus(ORG, uuid(13), "inactive", T0);
    return { policy: published.value };
  }

  it("resolves an audience of { states: ['NY'] } to exactly the active NY staff", async () => {
    await seed();
    const rounds = createRoundsRepository(executor);
    const ny = await rounds.resolveAudience(ORG, { states: ["ny"], locations: [], roles: [] });
    expect(ny.ok && ny.value.map((s) => s.fullName).sort()).toEqual(["Ana", "Ben"]);
    const all = await rounds.resolveAudience(ORG, { states: [], locations: [], roles: [] });
    expect(all.ok && all.value.length).toBe(3);
    const leads = await rounds.resolveAudience(ORG, { states: [], locations: [], roles: ["Shift Lead"] });
    expect(leads.ok && leads.value.map((s) => s.fullName)).toEqual(["Ben"]);
  });

  it("writes one row per recipient, records once, and refuses the replay", async () => {
    await seed();
    const rounds = createRoundsRepository(executor);
    const created = await rounds.createAssignment({
      id: uuid(100),
      orgId: ORG,
      policyId: uuid(1),
      versionId: uuid(2),
      reason: "initial",
      audience: { states: ["NY"], locations: [], roles: [] },
      dueAt: null,
      scheduleKey: null,
      createdBy: "usr_1",
      createdAt: T0,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const acks = await rounds.createAcknowledgments(
      created.value,
      [
        { id: uuid(200), staffId: uuid(10), tokenHash: "h-ana" },
        { id: uuid(201), staffId: uuid(11), tokenHash: "h-ben" },
      ],
      new Date("2026-05-01T00:00:00.000Z"),
    );
    expect(acks.ok && acks.value.length).toBe(2);

    const marked = await rounds.markSent(ORG, [uuid(200), uuid(201)], T0);
    expect(marked.ok && marked.value).toBe(2);

    const at = new Date("2026-03-02T09:00:00.000Z");
    const first = await rounds.recordAcknowledgment("h-ana", at, "203.0.113.7", "UA");
    expect(first.ok && first.value.kind).toBe("recorded");
    if (first.ok && first.value.kind === "recorded") {
      expect(first.value.acknowledgment.versionId).toBe(uuid(2));
      expect(first.value.acknowledgment.ackIp).toBe("203.0.113.7");
      expect(first.value.acknowledgment.acknowledgedAt?.toISOString()).toBe(at.toISOString());
    }
    const replay = await rounds.recordAcknowledgment("h-ana", at, "203.0.113.7", "UA");
    expect(replay.ok && replay.value.kind).toBe("already_recorded");
    const unknown = await rounds.recordAcknowledgment("h-nobody", at, null, null);
    expect(unknown.ok && unknown.value.kind).toBe("invalid");

    const tally = await rounds.tally(ORG, uuid(100));
    expect(tally.ok && tally.value).toEqual({ pending: 1, acknowledged: 1, superseded: 0 });

    const view = await rounds.findByTokenHash("h-ben");
    expect(view.ok && view.value.policyTitle).toBe("Anti-harassment");
    expect(view.ok && view.value.version).toBe(1);

    const detail = await rounds.listForAssignment(ORG, uuid(100));
    expect(detail.ok && detail.value.map((a) => [a.staffName, a.status])).toEqual([
      ["Ana", "acknowledged"],
      ["Ben", "pending"],
    ]);
  });

  it("refuses an expired link", async () => {
    await seed();
    const rounds = createRoundsRepository(executor);
    const created = await rounds.createAssignment({
      id: uuid(100),
      orgId: ORG,
      policyId: uuid(1),
      versionId: uuid(2),
      reason: "initial",
      audience: { states: [], locations: [], roles: [] },
      dueAt: null,
      scheduleKey: null,
      createdBy: null,
      createdAt: T0,
    });
    if (!created.ok) throw new Error("assignment");
    await rounds.createAcknowledgments(
      created.value,
      [{ id: uuid(200), staffId: uuid(10), tokenHash: "h-old" }],
      new Date("2026-03-05T00:00:00.000Z"),
    );
    const late = await rounds.recordAcknowledgment("h-old", new Date("2026-04-01T00:00:00.000Z"), null, null);
    expect(late.ok && late.value.kind).toBe("invalid");
  });

  it("rotates a pending link and lists what never went out", async () => {
    await seed();
    const rounds = createRoundsRepository(executor);
    const created = await rounds.createAssignment({
      id: uuid(100),
      orgId: ORG,
      policyId: uuid(1),
      versionId: uuid(2),
      reason: "initial",
      audience: { states: [], locations: [], roles: [] },
      dueAt: null,
      scheduleKey: null,
      createdBy: null,
      createdAt: T0,
    });
    if (!created.ok) throw new Error("assignment");
    await rounds.createAcknowledgments(
      created.value,
      [{ id: uuid(200), staffId: uuid(10), tokenHash: "h-1" }],
      new Date("2026-05-01T00:00:00.000Z"),
    );
    const unsent = await rounds.listUnsent(10);
    expect(unsent.ok && unsent.value.map((a) => a.staffEmail)).toEqual(["ana@x.test"]);
    const rotated = await rounds.rotateToken(ORG, uuid(200), "h-2", new Date("2026-06-01T00:00:00.000Z"));
    expect(rotated.ok).toBe(true);
    expect((await rounds.findByTokenHash("h-1")).ok).toBe(false);
    expect((await rounds.findByTokenHash("h-2")).ok).toBe(true);
  });
});
