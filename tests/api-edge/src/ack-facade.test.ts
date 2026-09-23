import { isAckRoute, handleAckRoute } from "@api-edge/ack-facade";
import { isPoliciesRoute } from "@api-edge/policies-facade";
import type { Env } from "@api-edge/env";

interface FetchCall {
  url: string;
  init: RequestInit;
}

function fakePolicies(): { fetcher: Fetcher; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetcher = {
    fetch(input: string, init?: RequestInit): Promise<Response> {
      calls.push({ url: input, init: init ?? {} });
      return Promise.resolve(Response.json({ data: { ok: true } }));
    },
  } as unknown as Fetcher;
  return { fetcher, calls };
}

const TOKEN = "AbCdEfGhIjKlMnOpQrStUv";

describe("ack facade — the public acknowledgment lane", () => {
  it("matches the link and its document, and nothing org-scoped", () => {
    expect(isAckRoute(`/v1/ack/${TOKEN}`)).toBe(true);
    expect(isAckRoute(`/v1/ack/${TOKEN}/document`)).toBe(true);
    expect(isAckRoute(`/v1/ack/${TOKEN}/other`)).toBe(false);
    expect(isAckRoute("/v1/organizations/org_1/policies")).toBe(false);
    expect(isPoliciesRoute(`/v1/ack/${TOKEN}`)).toBe(false);
    expect(isPoliciesRoute("/v1/organizations/org_1/assignments/asg_1/remind")).toBe(true);
    expect(isPoliciesRoute("/v1/organizations/org_1/acknowledgments")).toBe(true);
  });

  it("forwards without a session, carrying the caller's IP and user agent — never its Authorization", async () => {
    const { fetcher, calls } = fakePolicies();
    const env = { POLICIES_WORKER: fetcher } as unknown as Env;
    const request = new Request(`https://api.test/v1/ack/${TOKEN}`, {
      method: "POST",
      headers: {
        "CF-Connecting-IP": "198.51.100.9",
        "user-agent": "Mobile Safari",
        authorization: "Bearer should-not-travel",
      },
    });
    const res = await handleAckRoute(request, env, "req_t", `/v1/ack/${TOKEN}`);
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`https://policies.internal/v1/ack/${TOKEN}`);
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get("x-client-ip")).toBe("198.51.100.9");
    expect(headers.get("x-client-user-agent")).toBe("Mobile Safari");
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("x-actor-subject-id")).toBeNull();
  });

  it("refuses a write to the document route", async () => {
    const { fetcher, calls } = fakePolicies();
    const env = { POLICIES_WORKER: fetcher } as unknown as Env;
    const res = await handleAckRoute(
      new Request(`https://api.test/v1/ack/${TOKEN}/document`, { method: "POST" }),
      env,
      "req_t",
      `/v1/ack/${TOKEN}/document`,
    );
    expect(res.status).toBe(405);
    expect(calls).toHaveLength(0);
  });
});
