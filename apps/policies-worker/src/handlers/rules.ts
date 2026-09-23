import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { RecollectionRule, RulesRepository } from "@saas/db/policies";
import type { Uuid } from "@saas/db/ids";
import { createRulesRepository } from "@saas/db/policies";
import type { EventsRepository } from "@saas/db/events";
import { createEventsRepository } from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/d1";
import { POLICY_CATEGORIES } from "@saas/contracts/policies";
import { authorize } from "../guard.js";
import { successResponse, errorResponse, validationError } from "../http.js";
import { orgPublicId } from "../ids.js";

export interface HandleRulesDeps {
  rulesRepo?: RulesRepository;
  eventsRepo?: EventsRepository;
  now?: Date;
}

export function toPublicRule(rule: RecollectionRule) {
  return {
    state: rule.state,
    category: rule.category,
    intervalMonths: rule.intervalMonths,
    enabled: rule.enabled,
    updatedAt: rule.updatedAt.toISOString(),
  };
}

/** GET /v1/organizations/{org}/rules — seeded with the shipped defaults on first read. */
export async function handleListRules(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  deps?: HandleRulesDeps,
): Promise<Response> {
  const guard = await authorize(env, requestId, actor, orgId, "organization.policy.read");
  if (!guard.ok) return guard.response;
  const executor = createSqlExecutor(env.PLATFORM_DB!);
  try {
    const rules = deps?.rulesRepo ?? createRulesRepository(executor);
    await rules.seedDefaults(orgId, deps?.now ?? new Date());
    const list = await rules.listRules(orgId);
    if (!list.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);
    return successResponse({ rules: list.value.map(toPublicRule) }, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    await executor.dispose();
  }
}

/** PUT /v1/organizations/{org}/rules/{state}/{category} — { intervalMonths, enabled } */
export async function handlePutRule(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  stateParam: string,
  categoryParam: string,
  deps?: HandleRulesDeps,
): Promise<Response> {
  const guard = await authorize(env, requestId, actor, orgId, "organization.policy.write");
  if (!guard.ok) return guard.response;

  const state = decodeURIComponent(stateParam).toUpperCase();
  const category = decodeURIComponent(categoryParam).toLowerCase();
  const errors: Record<string, string[]> = {};
  if (state !== "*" && !/^[A-Z]{2}$/.test(state)) errors.state = ["Must be a two-letter state or *"];
  if (category !== "*" && !(POLICY_CATEGORIES as readonly string[]).includes(category)) {
    errors.category = [`Must be one of ${POLICY_CATEGORIES.join(", ")} or *`];
  }
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return errorResponse("bad_request", "Invalid JSON body", 400, requestId);
  }
  const intervalMonths = body?.intervalMonths;
  if (typeof intervalMonths !== "number" || !Number.isInteger(intervalMonths) || intervalMonths < 1 || intervalMonths > 120) {
    errors.intervalMonths = ["Must be an integer between 1 and 120"];
  }
  const enabled = body?.enabled === undefined ? true : body.enabled;
  if (typeof enabled !== "boolean") errors.enabled = ["Must be a boolean"];
  if (Object.keys(errors).length > 0) return validationError(requestId, errors);

  const now = deps?.now ?? new Date();
  const executor = createSqlExecutor(env.PLATFORM_DB!);
  try {
    const rules = deps?.rulesRepo ?? createRulesRepository(executor);
    await rules.seedDefaults(orgId, now);
    const saved = await rules.upsertRule(
      orgId,
      { state, category, intervalMonths: intervalMonths as number, enabled: enabled as boolean },
      now,
    );
    if (!saved.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);

    const events = deps?.eventsRepo ?? createEventsRepository(executor);
    await events.appendEventWithAudit({
      event: {
        id: crypto.randomUUID(),
        type: "rule.updated",
        version: 1,
        source: "policies-worker",
        occurredAt: now,
        actorType: actor.subjectType,
        actorId: actor.subjectId,
        orgId,
        subjectKind: "recollection_rule",
        subjectId: saved.value.id,
        subjectName: `${state}/${category}`,
        requestId,
        payload: {
          orgId: orgPublicId(orgId),
          state,
          category,
          intervalMonths: saved.value.intervalMonths,
          enabled: saved.value.enabled,
        },
      },
      audit: {
        id: crypto.randomUUID(),
        category: "policies",
        description: `Re-collection for ${state} ${category}: every ${saved.value.intervalMonths} month(s), ${saved.value.enabled ? "on" : "off"}`,
      },
    });
    return successResponse({ rule: toPublicRule(saved.value) }, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    await executor.dispose();
  }
}
