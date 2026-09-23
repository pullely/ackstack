import type { Env } from "./env.js";
import type { ActorContext } from "./router.js";
import type { Uuid } from "@saas/db/ids";
import { fetchAuthorizationContext } from "./membership-client.js";
import { authorizeViaPolicy } from "./policy-client.js";
import { errorResponse } from "./http.js";

/**
 * The membership → policy two-hop, in one place.
 *
 * Every route in this worker needs it and every route answers a denial the
 * same way — 404, never 403, because the house style is to hide a resource
 * rather than confirm it exists to someone who may not see it. Repeating forty
 * lines of it per handler is how one of them eventually forgets the second hop.
 */
export type Guard = { ok: true } | { ok: false; response: Response };

export async function requireBindings(env: Env, requestId: string): Promise<Guard> {
  if (!env.PLATFORM_DB || !env.MEMBERSHIP_WORKER || !env.POLICY_WORKER) {
    return {
      ok: false,
      response: errorResponse("internal_error", "Service unavailable", 503, requestId),
    };
  }
  return { ok: true };
}

export async function authorize(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  action: string,
  resourceId?: string,
): Promise<Guard> {
  const bindings = await requireBindings(env, requestId);
  if (!bindings.ok) return bindings;

  const hidden: Guard = {
    ok: false,
    response: errorResponse("not_found", "Not found", 404, requestId),
  };

  const contextResult = await fetchAuthorizationContext(
    env.MEMBERSHIP_WORKER!,
    actor.subjectId,
    actor.subjectType,
    orgId,
    requestId,
  );
  if (!contextResult.ok) return hidden;

  const resource = resourceId
    ? { kind: "organization", id: resourceId, orgId }
    : { kind: "organization", id: orgId, orgId };

  const policyResult = await authorizeViaPolicy(
    env.POLICY_WORKER!,
    actor.subjectId,
    actor.subjectType,
    action,
    resource,
    contextResult.memberships,
    requestId,
  );
  if (!policyResult.allow) return hidden;

  return { ok: true };
}
