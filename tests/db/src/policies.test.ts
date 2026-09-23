import { createPoliciesRepository } from "@saas/db/policies";
import type { SqlExecutor, SqlExecutorResult, SqlRow } from "@saas/db/d1";
import { asUuid } from "@saas/db/ids";

const ORG = asUuid("11111111-1111-1111-1111-111111111111");
const POLICY = asUuid("22222222-2222-2222-2222-222222222222");
const VERSION = asUuid("33333333-3333-3333-3333-333333333333");

interface Call {
  text: string;
  params: unknown[];
}

function fakeExecutor(rows: Array<Record<string, unknown>>, calls: Call[]): SqlExecutor {
  return {
    execute<T extends SqlRow>(text: string, params?: unknown[]): Promise<SqlExecutorResult<T>> {
      calls.push({ text, params: params ?? [] });
      return Promise.resolve({ rows: rows as T[], rowCount: rows.length });
    },
    transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      return fn(fakeExecutor(rows, calls));
    },
    dispose(): Promise<void> {
      return Promise.resolve();
    },
  } as unknown as SqlExecutor;
}

const policyRow = {
  id: POLICY,
  org_id: ORG,
  title: "Anti-harassment policy",
  slug: "anti-harassment-policy",
  slug_lower: "anti-harassment-policy",
  category: "harassment",
  status: "draft",
  current_version_id: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  retired_at: null,
};

const versionRow = {
  id: VERSION,
  org_id: ORG,
  policy_id: POLICY,
  version: 2,
  object_key: "orgs/x/policies/y/z",
  content_type: "application/pdf",
  byte_size: 1234,
  sha256: "abc",
  filename: "handbook.pdf",
  body_md: null,
  summary: null,
  published_at: null,
  published_by: null,
  created_at: "2026-01-01T00:00:00.000Z",
};

describe("policies repository", () => {
  it("scopes every read by org_id", async () => {
    const calls: Call[] = [];
    const repo = createPoliciesRepository(fakeExecutor([policyRow], calls));
    await repo.getPolicyById(ORG, POLICY);
    expect(calls[0]!.text).toContain("org_id = $1");
    expect(calls[0]!.params[0]).toBe(ORG);
  });

  it("maps a version row's snake_case columns onto the domain shape", async () => {
    const calls: Call[] = [];
    const repo = createPoliciesRepository(fakeExecutor([versionRow], calls));
    const result = await repo.getVersionById(ORG, VERSION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.objectKey).toBe("orgs/x/policies/y/z");
    expect(result.value.byteSize).toBe(1234);
    expect(result.value.version).toBe(2);
    expect(result.value.publishedAt).toBeNull();
  });

  it("allocates the next version number in the INSERT, not in a prior read", async () => {
    const calls: Call[] = [];
    const repo = createPoliciesRepository(fakeExecutor([versionRow], calls));
    await repo.createVersion({
      id: VERSION,
      orgId: ORG,
      policyId: POLICY,
      bodyMd: null,
      summary: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    // One statement: a read-then-write would race two concurrent drafts into
    // the same number, and D1 has no interactive transaction to prevent it.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toContain("MAX(version)");
  });

  it("refuses to attach a document to a published version, in SQL", async () => {
    const calls: Call[] = [];
    const repo = createPoliciesRepository(fakeExecutor([versionRow], calls));
    await repo.attachDocument(ORG, VERSION, {
      objectKey: "k",
      contentType: "application/pdf",
      byteSize: 1,
      sha256: "s",
      filename: "f.pdf",
    });
    expect(calls[0]!.text).toContain("published_at IS NULL");
  });

  it("upserts a staff member on (org_id, email_lower) rather than duplicating", async () => {
    const calls: Call[] = [];
    const repo = createPoliciesRepository(fakeExecutor([{
      id: "44444444-4444-4444-4444-444444444444",
      org_id: ORG,
      full_name: "Ada Okafor",
      email: "ada@example.com",
      email_lower: "ada@example.com",
      work_state: "NY",
      location: null,
      role: null,
      status: "active",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    }], calls));
    await repo.upsertStaff({
      id: "44444444-4444-4444-4444-444444444444",
      orgId: ORG,
      fullName: "Ada Okafor",
      email: "ada@example.com",
      emailLower: "ada@example.com",
      workState: "NY",
      location: null,
      role: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(calls[0]!.text).toContain("ON CONFLICT (org_id, email_lower) DO UPDATE");
  });
});
