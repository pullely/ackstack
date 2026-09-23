import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { PoliciesRepository } from "@saas/db/policies";
import type { Uuid } from "@saas/db/ids";
import { createPoliciesRepository } from "@saas/db/policies";
import { createSqlExecutor } from "@saas/db/d1";
import { authorize } from "../guard.js";
import { successResponse, errorResponse } from "../http.js";
import { toPublicStaff } from "../public.js";

export interface HandleGetStaffDeps {
  policiesRepo?: PoliciesRepository;
}

export async function handleGetStaff(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  staffId: Uuid,
  deps?: HandleGetStaffDeps,
): Promise<Response> {
  const guard = await authorize(env, requestId, actor, orgId, "organization.staff.read");
  if (!guard.ok) return guard.response;

  const executor = createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps?.policiesRepo ?? createPoliciesRepository(executor);
    const result = await repo.getStaffById(orgId, staffId);
    if (!result.ok) return errorResponse("not_found", "Not found", 404, requestId);
    return successResponse({ staff: toPublicStaff(result.value) }, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    await executor.dispose();
  }
}
