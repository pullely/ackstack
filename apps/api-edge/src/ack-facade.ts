import type { Env } from "./env.js";
import { errorResponse } from "./http.js";
import { enforceRateLimit, mergeRateLimitHeaders } from "./rate-limit.js";

/**
 * The acknowledgment link lane (AS2) — the only unauthenticated routes the
 * ackstack epic adds. A member of staff is a recipient, never a user: the
 * token in the path is the whole credential, verified by policies-worker
 * against its stored hash. No session is resolved here and no Authorization
 * header is read or forwarded.
 *
 *   GET  /v1/ack/{token}            the policy, the version, the staff name
 *   GET  /v1/ack/{token}/document   the exact bytes of that version
 *   POST /v1/ack/{token}            record the acknowledgment (once)
 */

const ACK_RE = /^\/v1\/ack\/[A-Za-z0-9_-]{1,64}$/;
const ACK_DOCUMENT_RE = /^\/v1\/ack\/[A-Za-z0-9_-]{1,64}\/document$/;

export function isAckRoute(pathname: string): boolean {
  return ACK_RE.test(pathname) || ACK_DOCUMENT_RE.test(pathname);
}

export async function handleAckRoute(
  request: Request,
  env: Env,
  requestId: string,
  pathname: string,
): Promise<Response> {
  const isDocument = ACK_DOCUMENT_RE.test(pathname);
  const allowed = isDocument ? ["GET"] : ["GET", "POST"];
  if (!allowed.includes(request.method)) {
    return errorResponse("unsupported", "Method not allowed", 405, requestId);
  }
  if (!env.POLICIES_WORKER) {
    return errorResponse("internal_error", "Policies service unavailable", 503, requestId);
  }

  // Keyed by CF-Connecting-IP for a bearer-less caller, so one address cannot
  // walk the token space; the token itself is 128 random bits on top of that.
  const rateDecision = await enforceRateLimit(request, requestId, env, "ack");
  if (rateDecision.kind === "denied") return rateDecision.response;

  const headers = new Headers();
  headers.set("x-request-id", requestId);
  headers.set("x-internal-caller", "api-edge");
  const ip = request.headers.get("CF-Connecting-IP");
  if (ip) headers.set("x-client-ip", ip);
  const userAgent = request.headers.get("user-agent");
  if (userAgent) headers.set("x-client-user-agent", userAgent.slice(0, 400));

  const target = new URL(pathname, "https://policies.internal");
  try {
    const downstream = await env.POLICIES_WORKER.fetch(target.toString(), {
      method: request.method,
      headers,
    });
    return mergeRateLimitHeaders(
      new Response(downstream.body, { status: downstream.status, headers: downstream.headers }),
      rateDecision.headers,
    );
  } catch {
    return errorResponse("internal_error", "Policies service unavailable", 503, requestId);
  }
}
