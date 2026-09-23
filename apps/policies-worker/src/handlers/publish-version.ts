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
import { orgPublicId, policyPublicId, versionPublicId } from "../ids.js";
import { toPublicPolicy, toPublicVersion } from "../public.js";

export interface HandlePublishVersionDeps {
  policiesRepo?: PoliciesRepository;
  eventsRepo?: EventsRepository;
}

export async function handlePublishVersion(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  policyId: Uuid,
  versionId: Uuid,
  deps?: HandlePublishVersionDeps,
): Promise<Response> {
  const guard = await authorize(env, requestId, actor, orgId, "organization.policy.write");
  if (!guard.ok) return guard.response;

  const now = new Date();
  const executor = createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps?.policiesRepo ?? createPoliciesRepository(executor);

    const version = await repo.getVersionById(orgId, versionId);
    if (!version.ok || version.value.policyId !== policyId) {
      return errorResponse("not_found", "Not found", 404, requestId);
    }

    const result = await repo.publishVersion(orgId, versionId, actor.subjectId, now);
    if (!result.ok) {
      if (result.error.kind === "immutable") {
        return errorResponse("conflict", "This version is already published", 409, requestId, {
          reason: "version_immutable",
        });
      }
      if (result.error.kind === "conflict") {
        return errorResponse(
          "conflict",
          "A version needs a document or a Markdown body before it can be published",
          409,
          requestId,
          { reason: "version_empty" },
        );
      }
      return errorResponse("not_found", "Not found", 404, requestId);
    }

    const policy = await repo.getPolicyById(orgId, policyId);
    if (!policy.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);

    const eventsRepo = deps?.eventsRepo ?? createEventsRepository(executor);
    await eventsRepo.appendEventWithAudit({
      event: {
        id: crypto.randomUUID(),
        type: "policy.version.published",
        version: 1,
        source: "policies-worker",
        occurredAt: now,
        actorType: actor.subjectType,
        actorId: actor.subjectId,
        orgId,
        subjectKind: "policy_version",
        subjectId: versionId,
        subjectName: `${policy.value.title} v${result.value.version}`,
        requestId,
        payload: {
          orgId: orgPublicId(orgId),
          policyId: policyPublicId(policyId),
          versionId: versionPublicId(versionId),
          version: result.value.version,
          hasDocument: !!result.value.objectKey,
        },
      },
      audit: {
        id: crypto.randomUUID(),
        category: "policies",
        description: `Published "${policy.value.title}" version ${result.value.version}`,
      },
    });

    return successResponse(
      { version: toPublicVersion(result.value), policy: toPublicPolicy(policy.value) },
      requestId,
    );
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    await executor.dispose();
  }
}
