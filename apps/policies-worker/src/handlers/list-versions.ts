import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { PoliciesRepository } from "@saas/db/policies";
import type { Uuid } from "@saas/db/ids";
import { createPoliciesRepository } from "@saas/db/policies";
import { createSqlExecutor } from "@saas/db/d1";
import { authorize } from "../guard.js";
import { successResponse, errorResponse } from "../http.js";
import { toPublicVersion } from "../public.js";

export interface HandleListVersionsDeps {
  policiesRepo?: PoliciesRepository;
}

export async function handleListVersions(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  policyId: Uuid,
  deps?: HandleListVersionsDeps,
): Promise<Response> {
  const guard = await authorize(env, requestId, actor, orgId, "organization.policy.read");
  if (!guard.ok) return guard.response;

  const executor = createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps?.policiesRepo ?? createPoliciesRepository(executor);
    const result = await repo.listVersions(orgId, policyId);
    if (!result.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);
    return successResponse({ versions: result.value.map(toPublicVersion) }, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    await executor.dispose();
  }
}
