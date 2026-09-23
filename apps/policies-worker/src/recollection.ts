import type { Env } from "./env.js";
import type { Uuid } from "@saas/db/ids";
import {
  createPoliciesRepository,
  createRoundsRepository,
  createRulesRepository,
  governingRule,
  isDue,
} from "@saas/db/policies";
import { createEventsRepository } from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/d1";
import { openRound, type Enqueue } from "./rounds.js";
import { assignmentPublicId, generateRequestId, orgPublicId, policyPublicId, versionPublicId } from "./ids.js";

/**
 * The nightly re-collection (AS3). For every organization with an active
 * policy: seed the calendar if it has never been read, then for every active
 * policy find the members of staff whose last acknowledgment is older than
 * their state's governing interval and who have nothing pending for it, and
 * open one `reason: 'scheduled'` round for exactly them.
 *
 * Idempotent twice over: the round carries `schedule_key =
 * scheduled:<policy>:<UTC date>`, unique per organization, so a second run on
 * the same day inserts nothing; and anyone the first run reached now has a
 * pending request, which excludes them from every later candidate list.
 */

export interface RecollectionSummary {
  organizations: number;
  roundsOpened: number;
  recipients: number;
  duplicates: number;
}

export function scheduleKey(policyId: string, now: Date): string {
  return `scheduled:${policyPublicId(policyId)}:${now.toISOString().slice(0, 10)}`;
}

export async function runRecollection(
  env: Env,
  now: Date,
  opts?: { enqueue?: Enqueue; executor?: ReturnType<typeof createSqlExecutor> },
): Promise<RecollectionSummary> {
  const summary: RecollectionSummary = { organizations: 0, roundsOpened: 0, recipients: 0, duplicates: 0 };
  if (!env.PLATFORM_DB && !opts?.executor) return summary;
  const executor = opts?.executor ?? createSqlExecutor(env.PLATFORM_DB!);
  try {
    const policies = createPoliciesRepository(executor);
    const rounds = createRoundsRepository(executor);
    const rules = createRulesRepository(executor);
    const events = createEventsRepository(executor);

    const orgs = await rules.listOrgsWithActivePolicies();
    if (!orgs.ok) return summary;

    for (const orgRaw of orgs.value) {
      const orgId = orgRaw as Uuid;
      summary.organizations += 1;
      await rules.seedDefaults(orgId, now);
      const orgRules = await rules.listRules(orgId);
      const active = await rules.listActivePolicies(orgId);
      if (!orgRules.ok || !active.ok) continue;

      for (const policy of active.value) {
        const candidates = await rules.listRecollectionCandidates(orgId, policy.id as Uuid);
        if (!candidates.ok) continue;
        const due = candidates.value.filter((c) => {
          const rule = governingRule(orgRules.value, c.staff.workState, policy.category);
          return rule !== null && isDue(c.lastAcknowledgedAt, rule, now);
        });
        if (due.length === 0) continue;

        const version = await policies.getVersionById(orgId, policy.currentVersionId as Uuid);
        if (!version.ok) continue;

        const requestId = generateRequestId();
        const states = [...new Set(due.map((c) => (c.staff.workState ?? "").toUpperCase()).filter(Boolean))].sort();
        const opened = await openRound(
          {
            env,
            requestId,
            now,
            rounds,
            events,
            actor: { subjectType: "system", subjectId: "policies-worker" },
            ...(opts?.enqueue ? { enqueue: opts.enqueue } : {}),
          },
          {
            orgId,
            policy,
            version: version.value,
            reason: "scheduled",
            audience: { states, locations: [], roles: [] },
            dueAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
            scheduleKey: scheduleKey(policy.id, now),
            recipients: due.map((c) => c.staff),
          },
        );
        if (opened.kind === "duplicate") {
          summary.duplicates += 1;
          continue;
        }
        if (opened.kind !== "opened") continue;
        summary.roundsOpened += 1;
        summary.recipients += opened.acknowledgments.length;

        await events.appendEventWithAudit({
          event: {
            id: crypto.randomUUID(),
            type: "recollection.round.opened",
            version: 1,
            source: "policies-worker",
            occurredAt: now,
            actorType: "system",
            actorId: "policies-worker",
            orgId,
            subjectKind: "assignment",
            subjectId: opened.assignment.id,
            subjectName: `${policy.title} v${version.value.version}`,
            requestId,
            payload: {
              orgId: orgPublicId(orgId),
              assignmentId: assignmentPublicId(opened.assignment.id),
              policyId: policyPublicId(policy.id),
              versionId: versionPublicId(version.value.id),
              states,
              recipients: opened.acknowledgments.length,
            },
          },
          audit: {
            id: crypto.randomUUID(),
            category: "policies",
            description: `Opened the scheduled re-collection of "${policy.title}" for ${opened.acknowledgments.length} member(s) of staff (${states.join(", ")})`,
          },
        });
      }
    }
    return summary;
  } finally {
    if (!opts?.executor) await executor.dispose();
  }
}
