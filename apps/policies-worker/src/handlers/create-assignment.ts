import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { PoliciesRepository, RoundsRepository } from "@saas/db/policies";
import type { Uuid } from "@saas/db/ids";
import { createPoliciesRepository, createRoundsRepository } from "@saas/db/policies";
import type { EventsRepository } from "@saas/db/events";
import { createEventsRepository } from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/d1";
import { authorize } from "../guard.js";
import { successResponse, errorResponse, validationError } from "../http.js";
import { parsePolicyPublicId } from "../ids.js";
import { toPublicAssignment } from "../public.js";
import { isDebugDelivery, normalizeAudience, openRound, type Enqueue } from "../rounds.js";

export interface HandleCreateAssignmentDeps {
  policiesRepo?: PoliciesRepository;
  roundsRepo?: RoundsRepository;
  eventsRepo?: EventsRepository;
  enqueue?: Enqueue;
  now?: Date;
}

export async function handleCreateAssignment(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  deps?: HandleCreateAssignmentDeps,
): Promise<Response> {
  const guard = await authorize(env, requestId, actor, orgId, "organization.policy.write");
  if (!guard.ok) return guard.response;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return errorResponse("bad_request", "Invalid JSON body", 400, requestId);
  }
  if (!body || typeof body !== "object") {
    return errorResponse("bad_request", "Invalid JSON body", 400, requestId);
  }

  const errors: Record<string, string[]> = {};
  const policyId = typeof body.policyId === "string" ? parsePolicyPublicId(body.policyId) : null;
  if (!policyId) errors.policyId = ["Required: a pol_ id"];
  const audience = normalizeAudience(body.audience);
  if (!audience) errors.audience = ["Must be { states?: string[] (two-letter), locations?: string[], roles?: string[] }"];
  let dueAt: Date | null = null;
  if (body.dueAt !== undefined && body.dueAt !== null) {
    const parsed = typeof body.dueAt === "string" ? new Date(body.dueAt) : new Date(NaN);
    if (Number.isNaN(parsed.getTime())) errors.dueAt = ["Must be an ISO date"];
    else dueAt = parsed;
  }
  if (Object.keys(errors).length > 0) return validationError(requestId, errors);

  const now = deps?.now ?? new Date();
  const executor = createSqlExecutor(env.PLATFORM_DB!);
  try {
    const policies = deps?.policiesRepo ?? createPoliciesRepository(executor);
    const rounds = deps?.roundsRepo ?? createRoundsRepository(executor);
    const events = deps?.eventsRepo ?? createEventsRepository(executor);

    const policy = await policies.getPolicyById(orgId, policyId!);
    if (!policy.ok) return errorResponse("not_found", "Not found", 404, requestId);
    if (policy.value.status === "retired") {
      return errorResponse("conflict", "A retired policy cannot be assigned", 409, requestId, {
        reason: "policy_retired",
      });
    }
    if (!policy.value.currentVersionId) {
      return errorResponse("conflict", "Publish a version before assigning the policy", 409, requestId, {
        reason: "policy_unpublished",
      });
    }
    const version = await policies.getVersionById(orgId, policy.value.currentVersionId as Uuid);
    if (!version.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);

    const opened = await openRound(
      {
        env,
        requestId,
        now,
        rounds,
        events,
        actor,
        ...(deps?.enqueue ? { enqueue: deps.enqueue } : {}),
      },
      {
        orgId,
        policy: policy.value,
        version: version.value,
        reason: "initial",
        audience: audience!,
        dueAt,
      },
    );
    if (opened.kind === "empty") {
      return validationError(requestId, { audience: ["Matches no active member of staff"] });
    }
    if (opened.kind !== "opened") {
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }

    return successResponse(
      {
        assignment: toPublicAssignment(opened.assignment),
        tally: { pending: opened.acknowledgments.length, acknowledged: 0, superseded: 0 },
        sent: opened.sent,
        ...(isDebugDelivery(env) ? { debugLinks: opened.links } : {}),
      },
      requestId,
      201,
    );
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    await executor.dispose();
  }
}
