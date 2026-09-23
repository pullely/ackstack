import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { PoliciesRepository } from "@saas/db/policies";
import type { Uuid } from "@saas/db/ids";
import { createPoliciesRepository } from "@saas/db/policies";
import type { EventsRepository } from "@saas/db/events";
import { createEventsRepository } from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/d1";
import { authorize } from "../guard.js";
import { successResponse, errorResponse } from "../http.js";
import { orgPublicId, staffPublicId } from "../ids.js";
import { toPublicStaff } from "../public.js";

export interface HandleDeactivateStaffDeps {
  policiesRepo?: PoliciesRepository;
  eventsRepo?: EventsRepository;
}

/**
 * Deactivates, never deletes. The proof that someone acknowledged a policy has
 * to outlive their employment, and a deleted row takes the trail with it.
 */
export async function handleDeactivateStaff(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  staffId: Uuid,
  deps?: HandleDeactivateStaffDeps,
): Promise<Response> {
  const guard = await authorize(env, requestId, actor, orgId, "organization.staff.write");
  if (!guard.ok) return guard.response;

  const now = new Date();
  const executor = createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps?.policiesRepo ?? createPoliciesRepository(executor);
    const result = await repo.setStaffStatus(orgId, staffId, "inactive", now);
    if (!result.ok) return errorResponse("not_found", "Not found", 404, requestId);

    const eventsRepo = deps?.eventsRepo ?? createEventsRepository(executor);
    await eventsRepo.appendEventWithAudit({
      event: {
        id: crypto.randomUUID(),
        type: "staff.deactivated",
        version: 1,
        source: "policies-worker",
        occurredAt: now,
        actorType: actor.subjectType,
        actorId: actor.subjectId,
        orgId,
        subjectKind: "staff",
        subjectId: staffId,
        subjectName: result.value.fullName,
        requestId,
        payload: { orgId: orgPublicId(orgId), staffId: staffPublicId(staffId) },
      },
      audit: {
        id: crypto.randomUUID(),
        category: "policies",
        description: `Deactivated staff member "${result.value.fullName}"`,
      },
    });

    return successResponse({ staff: toPublicStaff(result.value) }, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    await executor.dispose();
  }
}
