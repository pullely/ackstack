import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { PoliciesRepository, RoundsRepository } from "@saas/db/policies";
import type { Uuid } from "@saas/db/ids";
import { createPoliciesRepository, createRoundsRepository } from "@saas/db/policies";
import type { EventsRepository } from "@saas/db/events";
import { createEventsRepository } from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/d1";
import { authorize } from "../guard.js";
import { successResponse, errorResponse } from "../http.js";
import { assignmentPublicId, orgPublicId, policyPublicId, versionPublicId } from "../ids.js";
import { toPublicPolicy, toPublicVersion } from "../public.js";
import { openRound, type Enqueue } from "../rounds.js";

export interface HandlePublishVersionDeps {
  policiesRepo?: PoliciesRepository;
  eventsRepo?: EventsRepository;
  roundsRepo?: RoundsRepository;
  enqueue?: Enqueue;
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

    // AS3: a new version supersedes every request still pending for an older
    // one, and everyone who was ever asked about this policy is asked about
    // this version — the proof must name what they actually read.
    const rounds = deps?.roundsRepo ?? createRoundsRepository(executor);
    const superseded = await rounds.supersedePending(orgId, policyId, versionId, now);
    const supersededCount = superseded.ok ? superseded.value.length : 0;
    if (supersededCount > 0) {
      await eventsRepo.appendEventWithAudit({
        event: {
          id: crypto.randomUUID(),
          type: "acknowledgment.superseded",
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
            superseded: supersededCount,
          },
        },
        audit: {
          id: crypto.randomUUID(),
          category: "policies",
          description: `Version ${result.value.version} of "${policy.value.title}" superseded ${supersededCount} outstanding request(s)`,
        },
      });
    }

    let newVersionRound: { assignmentId: string; recipients: number } | null = null;
    const previously = await rounds.listStaffEverAssigned(orgId, policyId);
    if (previously.ok && previously.value.length > 0) {
      const opened = await openRound(
        {
          env,
          requestId,
          now,
          rounds,
          events: eventsRepo,
          actor,
          ...(deps?.enqueue ? { enqueue: deps.enqueue } : {}),
        },
        {
          orgId,
          policy: policy.value,
          version: result.value,
          reason: "new_version",
          audience: { states: [], locations: [], roles: [] },
          dueAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
          recipients: previously.value,
        },
      );
      if (opened.kind === "opened") {
        newVersionRound = {
          assignmentId: assignmentPublicId(opened.assignment.id),
          recipients: opened.acknowledgments.length,
        };
      }
    }

    return successResponse(
      {
        version: toPublicVersion(result.value),
        policy: toPublicPolicy(policy.value),
        superseded: supersededCount,
        newVersionRound,
      },
      requestId,
    );
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    await executor.dispose();
  }
}
