import type { Env } from "../env.js";
import { successResponse } from "../http.js";

export function handleHealth(env: Env, requestId: string): Response {
  const db = !!env.PLATFORM_DB;
  const documents = !!env.POLICY_DOCS;
  const membership = !!env.MEMBERSHIP_WORKER;
  const policy = !!env.POLICY_WORKER;

  return successResponse(
    {
      status: "ok",
      service: "policies-worker",
      environment: env.ENVIRONMENT ?? "local",
      timestamp: new Date().toISOString(),
      checks: {
        database: { configured: db },
        documents: { configured: documents },
        membership: { configured: membership },
        policy: { configured: policy },
      },
    },
    requestId,
  );
}
