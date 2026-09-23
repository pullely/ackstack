import type { SqlExecutor } from "../d1/executor.js";
import type { Uuid } from "../ids/index.js";
import type { Policy, PoliciesResult, StaffMember } from "./types.js";

/**
 * The re-collection calendar (AS3).
 *
 * A rule says how long an acknowledgment of a policy of some category stays
 * current for staff working in some state. The governing rule for one member
 * of staff and one policy is the most specific enabled match:
 *   (state, category) → (state, '*') → ('*', category) → ('*', '*').
 */

export interface RecollectionRule {
  id: string;
  orgId: string;
  state: string;
  category: string;
  intervalMonths: number;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The shipped defaults: New York annual for harassment (Labor Law §201-g) and
 * for workplace violence (the 2025 Retail Worker Safety Act), Illinois annual
 * (Workplace Transparency Act), California every two years (SB 1343 / AB
 * 1825). The org-wide default exists but is off.
 */
export const DEFAULT_RULES: ReadonlyArray<{
  state: string;
  category: string;
  intervalMonths: number;
  enabled: boolean;
}> = [
  { state: "NY", category: "harassment", intervalMonths: 12, enabled: true },
  { state: "NY", category: "workplace_violence", intervalMonths: 12, enabled: true },
  { state: "IL", category: "harassment", intervalMonths: 12, enabled: true },
  { state: "CA", category: "harassment", intervalMonths: 24, enabled: true },
  { state: "*", category: "*", intervalMonths: 12, enabled: false },
];

export interface RecollectionCandidate {
  staff: StaffMember;
  lastAcknowledgedAt: Date;
}

export interface RulesRepository {
  seedDefaults(orgId: Uuid, now: Date): Promise<PoliciesResult<number>>;
  listRules(orgId: Uuid): Promise<PoliciesResult<RecollectionRule[]>>;
  upsertRule(
    orgId: Uuid,
    input: { state: string; category: string; intervalMonths: number; enabled: boolean },
    now: Date,
  ): Promise<PoliciesResult<RecollectionRule>>;
  listOrgsWithActivePolicies(): Promise<PoliciesResult<string[]>>;
  listActivePolicies(orgId: Uuid): Promise<PoliciesResult<Policy[]>>;
  /** Active staff who have acknowledged this policy before and have nothing pending for it. */
  listRecollectionCandidates(
    orgId: Uuid,
    policyId: Uuid,
  ): Promise<PoliciesResult<RecollectionCandidate[]>>;
}

function mapRule(row: Record<string, unknown>): RecollectionRule {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    state: row.state as string,
    category: row.category as string,
    intervalMonths: Number(row.interval_months),
    enabled: Number(row.enabled) === 1,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

function mapPolicy(row: Record<string, unknown>): Policy {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    title: row.title as string,
    slug: row.slug as string,
    slugLower: row.slug_lower as string,
    category: row.category as string,
    status: row.status as string,
    currentVersionId: (row.current_version_id as string | null) ?? null,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
    retiredAt: row.retired_at ? new Date(row.retired_at as string) : null,
  };
}

function internal(message: string): PoliciesResult<never> {
  return { ok: false, error: { kind: "internal", message } };
}

/** The governing rule for a work state and a policy category, or null when none applies. */
export function governingRule(
  rules: RecollectionRule[],
  workState: string | null,
  category: string,
): RecollectionRule | null {
  const state = (workState ?? "").toUpperCase();
  const order: Array<[string, string]> = [
    [state, category],
    [state, "*"],
    ["*", category],
    ["*", "*"],
  ];
  for (const [s, c] of order) {
    if (!s) continue;
    const rule = rules.find((r) => r.state === s && r.category === c);
    // A disabled specific rule is an explicit "no re-collection here": it
    // stops the search rather than falling through to a broader default.
    if (rule) return rule.enabled ? rule : null;
  }
  return null;
}

/** `date` plus `months` calendar months, clamped to the last day of a shorter month. */
export function addMonths(date: Date, months: number): Date {
  const d = new Date(date.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}

/** True when an acknowledgment made at `last` is no longer current under `rule` at `now`. */
export function isDue(last: Date, rule: RecollectionRule, now: Date): boolean {
  return addMonths(last, rule.intervalMonths).getTime() <= now.getTime();
}

export function createRulesRepository(executor: SqlExecutor): RulesRepository {
  return {
    async seedDefaults(orgId, now) {
      try {
        const values: unknown[] = [orgId, now.toISOString()];
        const tuples = DEFAULT_RULES.map((rule) => {
          values.push(crypto.randomUUID(), rule.state, rule.category, rule.intervalMonths, rule.enabled ? 1 : 0);
          const b = values.length - 5;
          return `($${b + 1}, $1, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $2, $2)`;
        });
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO policies_rules
             (id, org_id, state, category, interval_months, enabled, created_at, updated_at)
           VALUES ${tuples.join(", ")}
           ON CONFLICT (org_id, state, category) DO NOTHING
           RETURNING id`,
          values,
        );
        return { ok: true, value: result.rowCount };
      } catch {
        return internal("Failed to seed the re-collection rules");
      }
    },

    async listRules(orgId) {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM policies_rules WHERE org_id = $1 ORDER BY state, category`,
          [orgId],
        );
        return { ok: true, value: result.rows.map(mapRule) };
      } catch {
        return internal("Failed to list the re-collection rules");
      }
    },

    async upsertRule(orgId, input, now) {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO policies_rules
             (id, org_id, state, category, interval_months, enabled, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
           ON CONFLICT (org_id, state, category) DO UPDATE SET
             interval_months = excluded.interval_months,
             enabled         = excluded.enabled,
             updated_at      = excluded.updated_at
           RETURNING *`,
          [
            crypto.randomUUID(),
            orgId,
            input.state,
            input.category,
            input.intervalMonths,
            input.enabled ? 1 : 0,
            now.toISOString(),
          ],
        );
        if (result.rowCount === 0) return internal("Failed to save the rule");
        return { ok: true, value: mapRule(result.rows[0]!) };
      } catch {
        return internal("Failed to save the rule");
      }
    },

    async listOrgsWithActivePolicies() {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT DISTINCT org_id FROM policies_policies
            WHERE status = 'active' AND current_version_id IS NOT NULL`,
        );
        return { ok: true, value: result.rows.map((r) => r.org_id as string) };
      } catch {
        return internal("Failed to list organizations");
      }
    },

    async listActivePolicies(orgId) {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM policies_policies
            WHERE org_id = $1 AND status = 'active' AND current_version_id IS NOT NULL
            ORDER BY created_at, id`,
          [orgId],
        );
        return { ok: true, value: result.rows.map(mapPolicy) };
      } catch {
        return internal("Failed to list active policies");
      }
    },

    async listRecollectionCandidates(orgId, policyId) {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT s.*, MAX(a.acknowledged_at) AS last_acknowledged_at
             FROM policies_staff s
             JOIN policies_acknowledgments a
               ON a.org_id = s.org_id AND a.staff_id = s.id
              AND a.policy_id = $2 AND a.status = 'acknowledged'
            WHERE s.org_id = $1 AND s.status = 'active'
              AND NOT EXISTS (
                SELECT 1 FROM policies_acknowledgments p
                 WHERE p.org_id = s.org_id AND p.staff_id = s.id
                   AND p.policy_id = $2 AND p.status = 'pending')
            GROUP BY s.id
            ORDER BY s.created_at, s.id`,
          [orgId, policyId],
        );
        return {
          ok: true,
          value: result.rows.map((row) => ({
            staff: {
              id: row.id as string,
              orgId: row.org_id as string,
              fullName: row.full_name as string,
              email: row.email as string,
              emailLower: row.email_lower as string,
              workState: (row.work_state as string | null) ?? null,
              location: (row.location as string | null) ?? null,
              role: (row.role as string | null) ?? null,
              status: row.status as string,
              createdAt: new Date(row.created_at as string),
              updatedAt: new Date(row.updated_at as string),
            },
            lastAcknowledgedAt: new Date(row.last_acknowledged_at as string),
          })),
        };
      } catch {
        return internal("Failed to list re-collection candidates");
      }
    },
  };
}
