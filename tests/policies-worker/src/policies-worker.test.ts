import { handleCreatePolicy } from "@policies-worker/handlers/create-policy";
import { handleGetPolicy } from "@policies-worker/handlers/get-policy";
import { handlePutDocument, handleGetDocument } from "@policies-worker/handlers/version-document";
import { handlePublishVersion } from "@policies-worker/handlers/publish-version";
import { handleCreateStaff } from "@policies-worker/handlers/create-staff";
import { route } from "@policies-worker/router";
import type { Env } from "@policies-worker/env";
import type {
  PoliciesRepository,
  PoliciesResult,
  Policy,
  PolicyVersion,
  StaffMember,
} from "@saas/db/policies";
import type { EventsRepository } from "@saas/db/events";
import { asUuid } from "@saas/db/ids";

const ORG_UUID = asUuid("11111111-1111-1111-1111-111111111111");
const ORG_PUBLIC = "org_11111111111111111111111111111111";
const POLICY_UUID = asUuid("22222222-2222-2222-2222-222222222222");
const POLICY_PUBLIC = "pol_22222222222222222222222222222222";
const VERSION_UUID = asUuid("33333333-3333-3333-3333-333333333333");
const VERSION_PUBLIC = "pov_33333333333333333333333333333333";
const USER_ID = "usr_aabbccdd";

function mockFetcher(body: unknown, status = 200): Fetcher {
  return {
    fetch(): Promise<Response> {
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
      );
    },
    connect() {
      throw new Error("not implemented");
    },
  } as unknown as Fetcher;
}

/** A stand-in R2 bucket that keeps objects in a Map, so a PUT then a GET is a real round trip. */
function fakeBucket() {
  const objects = new Map<string, { bytes: ArrayBuffer; contentType?: string }>();
  return {
    objects,
    put(key: string, value: ArrayBuffer, opts?: { httpMetadata?: { contentType?: string } }) {
      const entry: { bytes: ArrayBuffer; contentType?: string } = { bytes: value };
      if (opts?.httpMetadata?.contentType) entry.contentType = opts.httpMetadata.contentType;
      objects.set(key, entry);
      return Promise.resolve({ key });
    },
    get(key: string) {
      const found = objects.get(key);
      if (!found) return Promise.resolve(null);
      return Promise.resolve({ body: found.bytes, key });
    },
  };
}

function fakeEnv(overrides?: Partial<Env>): Env {
  return {
    PLATFORM_DB: {} as D1Database,
    POLICY_DOCS: fakeBucket() as unknown as R2Bucket,
    MEMBERSHIP_WORKER: mockFetcher({
      data: { memberships: [{ orgId: ORG_UUID, role: "owner" }] },
    }),
    POLICY_WORKER: mockFetcher({ data: { allow: true } }),
    ENVIRONMENT: "test",
    ...overrides,
  } as Env;
}

const ACTOR = { subjectId: USER_ID, subjectType: "user" };

function ok<T>(value: T): PoliciesResult<T> {
  return { ok: true, value };
}

function policyRow(over?: Partial<Policy>): Policy {
  return {
    id: POLICY_UUID,
    orgId: ORG_UUID,
    title: "Anti-harassment policy",
    slug: "anti-harassment-policy",
    slugLower: "anti-harassment-policy",
    category: "harassment",
    status: "draft",
    currentVersionId: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    retiredAt: null,
    ...over,
  };
}

function versionRow(over?: Partial<PolicyVersion>): PolicyVersion {
  return {
    id: VERSION_UUID,
    orgId: ORG_UUID,
    policyId: POLICY_UUID,
    version: 1,
    objectKey: null,
    contentType: null,
    byteSize: null,
    sha256: null,
    filename: null,
    bodyMd: null,
    summary: null,
    publishedAt: null,
    publishedBy: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    ...over,
  };
}

function staffRow(over?: Partial<StaffMember>): StaffMember {
  return {
    id: "44444444-4444-4444-4444-444444444444",
    orgId: ORG_UUID,
    fullName: "Ada Okafor",
    email: "Ada@Example.com",
    emailLower: "ada@example.com",
    workState: "NY",
    location: "Astoria store",
    role: "shift lead",
    status: "active",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...over,
  };
}

/** Only the methods a given test needs; the rest throw loudly if reached. */
function fakeRepo(partial: Partial<PoliciesRepository>): PoliciesRepository {
  return new Proxy(partial, {
    get(target, prop: string) {
      if (prop in target) return (target as Record<string, unknown>)[prop];
      return () => {
        throw new Error(`unexpected repository call: ${prop}`);
      };
    },
  }) as PoliciesRepository;
}

/**
 * The audit append is injected rather than module-mocked: these suites run as
 * real ESM, where `jest.mock` does not exist, and the handlers already take a
 * `deps` seam for exactly this.
 */
const eventsRepo = {
  appendEventWithAudit: () =>
    Promise.resolve({ ok: true as const, value: { event: {}, audit: {} } }),
} as unknown as EventsRepository;

describe("policies-worker — the register", () => {
  it("creates a policy and derives its slug from the title", async () => {
    let captured: { slug: string; slugLower: string } | null = null;
    const repo = fakeRepo({
      createPolicy: (input) => {
        captured = { slug: input.slug, slugLower: input.slugLower };
        return Promise.resolve(ok(policyRow({ slug: input.slug })));
      },
    });

    const request = new Request("https://policies.internal/x", {
      method: "POST",
      body: JSON.stringify({ title: "Anti-harassment policy", category: "harassment" }),
    });
    const response = await handleCreatePolicy(request, fakeEnv(), "req_1", ACTOR, ORG_UUID, {
      policiesRepo: repo,
      eventsRepo,
    });

    expect(response.status).toBe(201);
    expect(captured).toEqual({
      slug: "anti-harassment-policy",
      slugLower: "anti-harassment-policy",
    });
    const body = (await response.json()) as { data: { policy: { id: string; orgId: string } } };
    expect(body.data.policy.id).toBe(POLICY_PUBLIC);
    expect(body.data.policy.orgId).toBe(ORG_PUBLIC);
  });

  it("rejects an unknown category before it reaches the database", async () => {
    const request = new Request("https://policies.internal/x", {
      method: "POST",
      body: JSON.stringify({ title: "Some policy", category: "not-a-category" }),
    });
    const response = await handleCreatePolicy(request, fakeEnv(), "req_2", ACTOR, ORG_UUID, {
      policiesRepo: fakeRepo({}),
      eventsRepo,
    });
    expect(response.status).toBe(422);
  });

  it("hides a policy from an actor the policy engine denies", async () => {
    const env = fakeEnv({ POLICY_WORKER: mockFetcher({ data: { allow: false } }) });
    const response = await handleGetPolicy(env, "req_3", ACTOR, ORG_UUID, POLICY_UUID, {
      policiesRepo: fakeRepo({}),
    });
    // 404, never 403: a denial must not confirm the resource exists.
    expect(response.status).toBe(404);
  });
});

describe("policies-worker — documents and immutability", () => {
  it("round-trips a document through R2 and records its digest", async () => {
    const bucket = fakeBucket();
    const env = fakeEnv({ POLICY_DOCS: bucket as unknown as R2Bucket });
    const bytes = new TextEncoder().encode("a policy, in bytes");

    let attached: { sha256: string; byteSize: number; objectKey: string } | null = null;
    const repo = fakeRepo({
      getVersionById: () => Promise.resolve(ok(versionRow())),
      attachDocument: (_org, _version, input) => {
        attached = {
          sha256: input.sha256,
          byteSize: input.byteSize,
          objectKey: input.objectKey,
        };
        return Promise.resolve(
          ok(
            versionRow({
              objectKey: input.objectKey,
              contentType: input.contentType,
              byteSize: input.byteSize,
              sha256: input.sha256,
              filename: input.filename,
            }),
          ),
        );
      },
    });

    const put = await handlePutDocument(
      new Request("https://policies.internal/x", {
        method: "PUT",
        body: bytes,
        headers: { "content-type": "application/pdf", "x-document-filename": "handbook.pdf" },
      }),
      env,
      "req_4",
      ACTOR,
      ORG_UUID,
      POLICY_UUID,
      VERSION_UUID,
      { policiesRepo: repo, eventsRepo },
    );

    expect(put.status).toBe(200);
    expect(attached!.byteSize).toBe(bytes.byteLength);
    expect(attached!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(bucket.objects.size).toBe(1);

    const stored = attached!.objectKey;
    const readRepo = fakeRepo({
      getVersionById: () =>
        Promise.resolve(
          ok(
            versionRow({
              objectKey: stored,
              contentType: "application/pdf",
              sha256: attached!.sha256,
              filename: "handbook.pdf",
            }),
          ),
        ),
    });
    const get = await handleGetDocument(env, "req_5", ACTOR, ORG_UUID, POLICY_UUID, VERSION_UUID, {
      policiesRepo: readRepo,
    });
    expect(get.status).toBe(200);
    expect(get.headers.get("etag")).toBe(`"${attached!.sha256}"`);
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(bytes);
  });

  it("refuses a second document on a published version", async () => {
    const repo = fakeRepo({
      getVersionById: () =>
        Promise.resolve(ok(versionRow({ publishedAt: new Date("2026-02-01T00:00:00.000Z") }))),
    });
    const response = await handlePutDocument(
      new Request("https://policies.internal/x", {
        method: "PUT",
        body: new TextEncoder().encode("new bytes"),
        headers: { "content-type": "application/pdf" },
      }),
      fakeEnv(),
      "req_6",
      ACTOR,
      ORG_UUID,
      POLICY_UUID,
      VERSION_UUID,
      { policiesRepo: repo, eventsRepo },
    );
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { details: { reason: string } } };
    expect(body.error.details.reason).toBe("version_immutable");
  });

  it("refuses to publish a version with neither a document nor a body", async () => {
    const repo = fakeRepo({
      getVersionById: () => Promise.resolve(ok(versionRow())),
      publishVersion: () =>
        Promise.resolve({
          ok: false as const,
          error: { kind: "conflict" as const, entity: "version_empty" },
        }),
    });
    const response = await handlePublishVersion(
      fakeEnv(),
      "req_7",
      ACTOR,
      ORG_UUID,
      POLICY_UUID,
      VERSION_UUID,
      { policiesRepo: repo, eventsRepo },
    );
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { details: { reason: string } } };
    expect(body.error.details.reason).toBe("version_empty");
  });
});

describe("policies-worker — the roster", () => {
  it("imports a roster and lowercases the email it upserts on", async () => {
    const seen: string[] = [];
    const repo = fakeRepo({
      upsertStaff: (input) => {
        seen.push(input.emailLower);
        return Promise.resolve(ok(staffRow({ emailLower: input.emailLower })));
      },
    });
    const request = new Request("https://policies.internal/x", {
      method: "POST",
      body: JSON.stringify({
        staff: [
          { fullName: "Ada Okafor", email: "Ada@Example.com", workState: "ny" },
          { fullName: "Bo Reyes", email: "bo@example.com", workState: "CA" },
        ],
      }),
    });
    const response = await handleCreateStaff(request, fakeEnv(), "req_8", ACTOR, ORG_UUID, {
      policiesRepo: repo,
      eventsRepo,
    });
    expect(response.status).toBe(201);
    expect(seen).toEqual(["ada@example.com", "bo@example.com"]);
  });

  it("rejects a roster row with a bad state code", async () => {
    const request = new Request("https://policies.internal/x", {
      method: "POST",
      body: JSON.stringify({
        staff: [{ fullName: "Ada Okafor", email: "ada@example.com", workState: "New York" }],
      }),
    });
    const response = await handleCreateStaff(request, fakeEnv(), "req_9", ACTOR, ORG_UUID, {
      policiesRepo: fakeRepo({}),
      eventsRepo,
    });
    expect(response.status).toBe(422);
  });
});

describe("policies-worker — the router", () => {
  it("refuses a request with no actor headers", async () => {
    const response = await route(
      new Request(`https://policies.internal/v1/organizations/${ORG_PUBLIC}/policies`),
      fakeEnv(),
    );
    expect(response.status).toBe(401);
  });

  it("404s an id that does not decode", async () => {
    const response = await route(
      new Request("https://policies.internal/v1/organizations/org_nope/policies", {
        headers: { "x-actor-subject-id": USER_ID, "x-actor-subject-type": "user" },
      }),
      fakeEnv(),
    );
    expect(response.status).toBe(404);
  });

  it("405s a method a route does not offer", async () => {
    const response = await route(
      new Request(
        `https://policies.internal/v1/organizations/${ORG_PUBLIC}/policies/${POLICY_PUBLIC}/versions/${VERSION_PUBLIC}/publish`,
        {
          method: "DELETE",
          headers: { "x-actor-subject-id": USER_ID, "x-actor-subject-type": "user" },
        },
      ),
      fakeEnv(),
    );
    expect(response.status).toBe(405);
  });
});
