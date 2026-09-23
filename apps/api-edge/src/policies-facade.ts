import type { Env } from "./env.js";
import { errorResponse, withEdgeTimings } from "./http.js";
import { replayOrExecute } from "./idempotency.js";
import { resolveActor } from "./resolve-actor.js";
import { createTimings } from "@saas/contracts/timing";

const ORG_POLICIES_RE = /^\/v1\/organizations\/[^/]+\/policies$/;
const ORG_POLICY_ID_RE = /^\/v1\/organizations\/[^/]+\/policies\/[^/]+$/;
const ORG_POLICY_VERSIONS_RE = /^\/v1\/organizations\/[^/]+\/policies\/[^/]+\/versions$/;
const ORG_POLICY_VERSION_ID_RE = /^\/v1\/organizations\/[^/]+\/policies\/[^/]+\/versions\/[^/]+$/;
const ORG_POLICY_VERSION_DOCUMENT_RE =
  /^\/v1\/organizations\/[^/]+\/policies\/[^/]+\/versions\/[^/]+\/document$/;
const ORG_POLICY_VERSION_PUBLISH_RE =
  /^\/v1\/organizations\/[^/]+\/policies\/[^/]+\/versions\/[^/]+\/publish$/;
const ORG_STAFF_RE = /^\/v1\/organizations\/[^/]+\/staff$/;
const ORG_STAFF_ID_RE = /^\/v1\/organizations\/[^/]+\/staff\/[^/]+$/;
const ORG_ASSIGNMENTS_RE = /^\/v1\/organizations\/[^/]+\/assignments$/;
const ORG_ASSIGNMENT_ID_RE = /^\/v1\/organizations\/[^/]+\/assignments\/[^/]+$/;
const ORG_ASSIGNMENT_REMIND_RE = /^\/v1\/organizations\/[^/]+\/assignments\/[^/]+\/remind$/;
const ORG_ACKNOWLEDGMENTS_RE = /^\/v1\/organizations\/[^/]+\/acknowledgments$/;
const ORG_RULES_RE = /^\/v1\/organizations\/[^/]+\/rules$/;
const ORG_RULE_RE = /^\/v1\/organizations\/[^/]+\/rules\/[^/]+\/[^/]+$/;
const ORG_POLICY_EXPORT_RE = /^\/v1\/organizations\/[^/]+\/policies\/[^/]+\/export$/;
const ORG_STAFF_EXPORT_RE = /^\/v1\/organizations\/[^/]+\/staff\/[^/]+\/export$/;

const FORWARDED_HEADERS = [
  "content-type",
  "x-request-id",
  "traceparent",
  "idempotency-key",
  // The uploader's own filename, carried on PUT .../document so the export can
  // name the file an auditor was shown.
  "x-document-filename",
];

/** Method allow-list per pattern, in the order the matchers are tried. */
const ROUTES: ReadonlyArray<{ re: RegExp; methods: readonly string[] }> = [
  { re: ORG_POLICY_VERSION_DOCUMENT_RE, methods: ["PUT", "GET"] },
  { re: ORG_POLICY_VERSION_PUBLISH_RE, methods: ["POST"] },
  { re: ORG_POLICY_VERSION_ID_RE, methods: ["GET"] },
  { re: ORG_POLICY_VERSIONS_RE, methods: ["POST", "GET"] },
  { re: ORG_POLICY_ID_RE, methods: ["GET", "PATCH"] },
  { re: ORG_POLICIES_RE, methods: ["POST", "GET"] },
  { re: ORG_STAFF_ID_RE, methods: ["GET", "DELETE"] },
  { re: ORG_STAFF_RE, methods: ["POST", "GET"] },
  { re: ORG_ASSIGNMENT_REMIND_RE, methods: ["POST"] },
  { re: ORG_ASSIGNMENT_ID_RE, methods: ["GET"] },
  { re: ORG_ASSIGNMENTS_RE, methods: ["POST", "GET"] },
  { re: ORG_ACKNOWLEDGMENTS_RE, methods: ["GET"] },
  { re: ORG_RULES_RE, methods: ["GET"] },
  { re: ORG_RULE_RE, methods: ["PUT"] },
  { re: ORG_POLICY_EXPORT_RE, methods: ["GET"] },
  { re: ORG_STAFF_EXPORT_RE, methods: ["GET"] },
];

export function isPoliciesRoute(pathname: string): boolean {
  return ROUTES.some((route) => route.re.test(pathname));
}

export async function handlePoliciesRoute(
  request: Request,
  env: Env,
  requestId: string,
  pathname: string,
): Promise<Response> {
  const matched = ROUTES.find((route) => route.re.test(pathname));
  if (matched && !matched.methods.includes(request.method)) {
    return errorResponse("unsupported", "Method not allowed", 405, requestId);
  }

  return replayOrExecute(request, requestId, env, "policies", async () => {
    if (!env.IDENTITY_WORKER) {
      return errorResponse("internal_error", "Authentication service unavailable", 503, requestId);
    }
    if (!env.POLICIES_WORKER) {
      return errorResponse("internal_error", "Policies service unavailable", 503, requestId);
    }

    const timings = createTimings();
    const endTotal = timings.start("edge_total");
    const sessionResult = await timings.measure("edge_auth", () =>
      resolveActor(request, env, requestId),
    );
    if ("error" in sessionResult) {
      return sessionResult.error;
    }

    const headers = new Headers();
    headers.set("x-request-id", requestId);
    headers.set("x-actor-subject-id", sessionResult.subjectId);
    headers.set("x-actor-subject-type", sessionResult.subjectType);
    headers.set("x-actor-email", sessionResult.email);
    for (const name of FORWARDED_HEADERS) {
      if (name === "x-request-id") continue;
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }

    const url = new URL(request.url);
    const target = new URL(pathname + url.search, "https://policies.internal");

    const init: RequestInit = { method: request.method, headers };
    // PUT carries a policy document, so the body is forwarded for it too.
    if (request.method === "POST" || request.method === "PATCH" || request.method === "PUT") {
      init.body = request.body;
    }

    try {
      const downstream = await timings.measure("edge_downstream", () =>
        env.POLICIES_WORKER!.fetch(target.toString(), init),
      );
      const res = new Response(downstream.body, {
        status: downstream.status,
        headers: downstream.headers,
      });
      endTotal();
      return withEdgeTimings(res, requestId, "edge.policies", timings);
    } catch {
      return errorResponse("internal_error", "Policies service unavailable", 503, requestId);
    }
  });
}
