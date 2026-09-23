import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSqlExecutor, type D1Binding } from "@saas/db/d1";
import { addMonths, createRulesRepository, governingRule, isDue, type RecollectionRule } from "@saas/db/policies";
import { asUuid } from "@saas/db/ids";
import { D1ApiAdapter } from "@saas/db/runner";

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
  const dirs = readdirSync(MIGRATIONS_ROOT)
    .filter((d) => existsSync(join(MIGRATIONS_ROOT, d, "up.sql")))
    .sort();
  for (const dir of dirs) {
    const sql = readFileSync(join(MIGRATIONS_ROOT, dir, "up.sql"), "utf8");
    for (const statement of D1ApiAdapter.splitStatements(sql)) db.exec(statement);
  }
  return db;
}

const ORG = asUuid("11111111-1111-4111-8111-111111111111");
const T0 = new Date("2026-09-23T06:15:00.000Z");

function rule(state: string, category: string, intervalMonths: number, enabled = true): RecollectionRule {
  return { id: `${state}/${category}`, orgId: ORG, state, category, intervalMonths, enabled, createdAt: T0, updatedAt: T0 };
}

describe("the re-collection calendar", () => {
  it("seeds the shipped defaults once, idempotently, against real SQLite", async () => {
    const db = migratedDatabase();
    const repo = createRulesRepository(createSqlExecutor(d1Over(db)));
    const first = await repo.seedDefaults(ORG, T0);
    expect(first.ok && first.value).toBe(5);
    const second = await repo.seedDefaults(ORG, T0);
    expect(second.ok && second.value).toBe(0);
    const rules = await repo.listRules(ORG);
    expect(rules.ok && rules.value.filter((r) => r.enabled).map((r) => `${r.state}/${r.category}/${r.intervalMonths}`).sort()).toEqual([
      "CA/harassment/24",
      "IL/harassment/12",
      "NY/harassment/12",
      "NY/workplace_violence/12",
    ]);
    const saved = await repo.upsertRule(ORG, { state: "CA", category: "harassment", intervalMonths: 12, enabled: true }, T0);
    expect(saved.ok && saved.value.intervalMonths).toBe(12);
    const again = await repo.listRules(ORG);
    expect(again.ok && again.value).toHaveLength(5);
    db.close();
  });

  it("picks the most specific rule, and a disabled specific rule means no re-collection", () => {
    const rules = [rule("NY", "harassment", 12), rule("NY", "*", 36), rule("*", "harassment", 48), rule("*", "*", 12, false), rule("TX", "*", 12, false)];
    expect(governingRule(rules, "ny", "harassment")?.intervalMonths).toBe(12);
    expect(governingRule(rules, "NY", "safety")?.intervalMonths).toBe(36);
    expect(governingRule(rules, "WA", "harassment")?.intervalMonths).toBe(48);
    expect(governingRule(rules, "WA", "safety")).toBeNull();
    expect(governingRule(rules, "TX", "harassment")).toBeNull();
    expect(governingRule(rules, null, "safety")).toBeNull();
  });

  it("counts calendar months: 13 due, 11 not, CA's 24 not at 13", () => {
    const ny = rule("NY", "harassment", 12);
    const ca = rule("CA", "harassment", 24);
    expect(isDue(addMonths(T0, -13), ny, T0)).toBe(true);
    expect(isDue(addMonths(T0, -12), ny, T0)).toBe(true);
    expect(isDue(addMonths(T0, -11), ny, T0)).toBe(false);
    expect(isDue(addMonths(T0, -13), ca, T0)).toBe(false);
    expect(addMonths(new Date("2026-01-31T00:00:00.000Z"), 1).toISOString()).toBe("2026-02-28T00:00:00.000Z");
  });
});
