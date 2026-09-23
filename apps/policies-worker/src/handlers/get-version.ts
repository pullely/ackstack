import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { PoliciesRepository } from "@saas/db/policies";
import type { Uuid } from "@saas/db/ids";
import { createPoliciesRepository } from "@saas/db/policies";
import { createSqlExecutor } from "@saas/db/d1";
import { authorize } from "../guard.js";
import { successResponse, errorResponse } from "../http.js";
import { toPublicVersion } from "../public.js";

export interface HandleGetVersionDeps {
  policiesRepo?: PoliciesRepository;
}

export async function handleGetVersion(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  policyId: Uuid,
  versionId: Uuid,
  deps?: HandleGetVersionDeps,
): Promise<Response> {
  const guard = await authorize(env, requestId, actor, orgId, "organization.policy.read");
  if (!guard.ok) return guard.response;

  const executor = createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps?.policiesRepo ?? createPoliciesRepository(executor);
    const result = await repo.getVersionById(orgId, versionId);
    if (!result.ok || result.value.policyId !== policyId) {
      return errorResponse("not_found", "Not found", 404, requestId);
    }
    return successResponse({ version: toPublicVersion(result.value) }, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    await executor.dispose();
  }
}
