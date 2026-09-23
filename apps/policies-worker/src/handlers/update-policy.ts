import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { PoliciesRepository, UpdatePolicyInput } from "@saas/db/policies";
import type { Uuid } from "@saas/db/ids";
import type { PolicyCategory, PolicyStatus } from "@saas/contracts/policies";
import { POLICY_CATEGORIES, POLICY_STATUSES } from "@saas/contracts/policies";
import { createPoliciesRepository } from "@saas/db/policies";
import type { EventsRepository } from "@saas/db/events";
import { createEventsRepository } from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/d1";
import { authorize } from "../guard.js";
import { successResponse, errorResponse, validationError } from "../http.js";
import { orgPublicId, policyPublicId } from "../ids.js";
import { toPublicPolicy } from "../public.js";

export interface HandleUpdatePolicyDeps {
  policiesRepo?: PoliciesRepository;
  eventsRepo?: EventsRepository;
}

export async function handleUpdatePolicy(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  policyId: Uuid,
  deps?: HandleUpdatePolicyDeps,
): Promise<Response> {
  const guard = await authorize(env, requestId, actor, orgId, "organization.policy.write");
  if (!guard.ok) return guard.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return validationError(requestId, { body: ["Invalid JSON"] });
  }

  const input = (body ?? {}) as Record<string, unknown>;
  const fields: Record<string, string[]> = {};
  const update: UpdatePolicyInput = {};

  if (input.title !== undefined) {
    const title = typeof input.title === "string" ? input.title.trim() : "";
    if (title.length < 2 || title.length > 200) {
      fields.title = ["must be between 2 and 200 characters"];
    } else {
      update.title = title;
    }
  }
  if (input.category !== undefined) {
    const category = input.category as PolicyCategory;
    if (!POLICY_CATEGORIES.includes(category)) {
      fields.category = [`must be one of ${POLICY_CATEGORIES.join(", ")}`];
    } else {
      update.category = category;
    }
  }
  if (input.status !== undefined) {
    const status = input.status as PolicyStatus;
    if (!POLICY_STATUSES.includes(status)) {
      fields.status = [`must be one of ${POLICY_STATUSES.join(", ")}`];
    } else {
      update.status = status;
    }
  }
  if (Object.keys(fields).length > 0) return validationError(requestId, fields);

  const now = new Date();
  const executor = createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps?.policiesRepo ?? createPoliciesRepository(executor);
    const result = await repo.updatePolicy(orgId, policyId, update, now);
    if (!result.ok) return errorResponse("not_found", "Not found", 404, requestId);

    const eventsRepo = deps?.eventsRepo ?? createEventsRepository(executor);
    await eventsRepo.appendEventWithAudit({
      event: {
        id: crypto.randomUUID(),
        type: update.status === "retired" ? "policy.retired" : "policy.updated",
        version: 1,
        source: "policies-worker",
        occurredAt: now,
        actorType: actor.subjectType,
        actorId: actor.subjectId,
        orgId,
        subjectKind: "policy",
        subjectId: policyId,
        subjectName: result.value.title,
        requestId,
        payload: {
          policyId: policyPublicId(policyId),
          orgId: orgPublicId(orgId),
          status: result.value.status,
        },
      },
      audit: {
        id: crypto.randomUUID(),
        category: "policies",
        description: `Updated policy "${result.value.title}"`,
      },
    });

    return successResponse({ policy: toPublicPolicy(result.value) }, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    await executor.dispose();
  }
}
