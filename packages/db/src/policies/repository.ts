import type { SqlExecutor } from "../d1/executor.js";
import type { Uuid } from "../ids/index.js";
import type {
  AttachDocumentInput,
  CreatePolicyInput,
  CreateVersionInput,
  CursorPosition,
  PagedResult,
  PageQueryParams,
  PoliciesRepository,
  PoliciesResult,
  Policy,
  PolicyVersion,
  StaffFilter,
  StaffMember,
  UpdatePolicyInput,
  UpsertStaffInput,
} from "./types.js";
import { isUniqueViolation } from "../d1/errors.js";

function mapPolicy(row: Record<string, unknown>): Policy {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    title: row.title as string,
    slug: row.slug as string,
    slugLower: row.slug_lower as string,
    category: row.category as string,
    status: row.status as string,
    currentVersionId: (row.current_version_id as string | null) ?? null,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
    retiredAt: row.retired_at ? new Date(row.retired_at as string) : null,
  };
}

function mapVersion(row: Record<string, unknown>): PolicyVersion {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    policyId: row.policy_id as string,
    version: Number(row.version),
    objectKey: (row.object_key as string | null) ?? null,
    contentType: (row.content_type as string | null) ?? null,
    byteSize: row.byte_size === null || row.byte_size === undefined ? null : Number(row.byte_size),
    sha256: (row.sha256 as string | null) ?? null,
    filename: (row.filename as string | null) ?? null,
    bodyMd: (row.body_md as string | null) ?? null,
    summary: (row.summary as string | null) ?? null,
    publishedAt: row.published_at ? new Date(row.published_at as string) : null,
    publishedBy: (row.published_by as string | null) ?? null,
    createdAt: new Date(row.created_at as string),
  };
}

function mapStaff(row: Record<string, unknown>): StaffMember {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    fullName: row.full_name as string,
    email: row.email as string,
    emailLower: row.email_lower as string,
    workState: (row.work_state as string | null) ?? null,
    location: (row.location as string | null) ?? null,
    role: (row.role as string | null) ?? null,
    status: row.status as string,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

function safeError(message: string): PoliciesResult<never> {
  return { ok: false, error: { kind: "internal", message } };
}

/**
 * Keyset pagination, the way every other context in this baseline does it:
 * ask for one more row than the caller wants, and if it comes back, the row
 * before it is the cursor.
 */
function takePage<T extends { createdAt: Date; id: string }>(
  rows: T[],
  limit: number,
): PagedResult<T> {
  const items = rows.slice(0, limit);
  let nextCursor: CursorPosition | null = null;
  if (rows.length > limit) {
    const last = items[items.length - 1];
    if (last) {
      nextCursor = { createdAt: last.createdAt.toISOString(), id: last.id };
    }
  }
  return { items, nextCursor };
}

export function createPoliciesRepository(executor: SqlExecutor): PoliciesRepository {
  return {
    async createPolicy(input: CreatePolicyInput): Promise<PoliciesResult<Policy>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO policies_policies
             (id, org_id, title, slug, slug_lower, category, status, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'draft', $7, $7)
           ON CONFLICT (id) DO NOTHING
           RETURNING *`,
          [
            input.id,
            input.orgId,
            input.title,
            input.slug,
            input.slugLower,
            input.category,
            input.createdAt.toISOString(),
          ],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "conflict", entity: "policy" } };
        }
        return { ok: true, value: mapPolicy(result.rows[0]!) };
      } catch (err: unknown) {
        if (isUniqueViolation(err)) {
          return { ok: false, error: { kind: "conflict", entity: "policy" } };
        }
        return safeError("Failed to create policy");
      }
    },

    async getPolicyById(orgId: Uuid, policyId: Uuid): Promise<PoliciesResult<Policy>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM policies_policies WHERE org_id = $1 AND id = $2`,
          [orgId, policyId],
        );
        if (result.rowCount === 0) return { ok: false, error: { kind: "not_found" } };
        return { ok: true, value: mapPolicy(result.rows[0]!) };
      } catch {
        return safeError("Failed to read policy");
      }
    },

    async listPoliciesPaged(
      orgId: Uuid,
      params: PageQueryParams,
      filter?: { status?: string; category?: string },
    ): Promise<PoliciesResult<PagedResult<Policy>>> {
      try {
        const values: unknown[] = [orgId, params.limit + 1];
        const where: string[] = ["org_id = $1"];
        if (filter?.status) {
          values.push(filter.status);
          where.push(`status = $${values.length}`);
        }
        if (filter?.category) {
          values.push(filter.category);
          where.push(`category = $${values.length}`);
        }
        if (params.cursor) {
          values.push(params.cursor.createdAt, params.cursor.id);
          where.push(`(created_at, id) < ($${values.length - 1}, $${values.length})`);
        }
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM policies_policies
            WHERE ${where.join(" AND ")}
            ORDER BY created_at DESC, id DESC
            LIMIT $2`,
          values,
        );
        return { ok: true, value: takePage(result.rows.map(mapPolicy), params.limit) };
      } catch {
        return safeError("Failed to list policies");
      }
    },

    async updatePolicy(
      orgId: Uuid,
      policyId: Uuid,
      input: UpdatePolicyInput,
      updatedAt: Date,
    ): Promise<PoliciesResult<Policy>> {
      try {
        const sets: string[] = [];
        const values: unknown[] = [orgId, policyId, updatedAt.toISOString()];
        if (input.title !== undefined) {
          values.push(input.title);
          sets.push(`title = $${values.length}`);
        }
        if (input.category !== undefined) {
          values.push(input.category);
          sets.push(`category = $${values.length}`);
        }
        if (input.status !== undefined) {
          values.push(input.status);
          sets.push(`status = $${values.length}`);
          if (input.status === "retired") sets.push(`retired_at = $3`);
        }
        if (sets.length === 0) return this.getPolicyById(orgId, policyId);
        const result = await executor.execute<Record<string, unknown>>(
          `UPDATE policies_policies
              SET ${sets.join(", ")}, updated_at = $3
            WHERE org_id = $1 AND id = $2
            RETURNING *`,
          values,
        );
        if (result.rowCount === 0) return { ok: false, error: { kind: "not_found" } };
        return { ok: true, value: mapPolicy(result.rows[0]!) };
      } catch {
        return safeError("Failed to update policy");
      }
    },

    async createVersion(input: CreateVersionInput): Promise<PoliciesResult<PolicyVersion>> {
      try {
        // The next version number is allocated in the INSERT itself, under the
        // (org_id, policy_id, version) unique index: D1 has no interactive
        // transaction, so a read-then-write would race two concurrent
        // publishes into the same number.
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO policies_versions
             (id, org_id, policy_id, version, body_md, summary, created_at)
           SELECT $1, $2, $3,
                  COALESCE((SELECT MAX(version) FROM policies_versions
                             WHERE org_id = $2 AND policy_id = $3), 0) + 1,
                  $4, $5, $6
            WHERE EXISTS (SELECT 1 FROM policies_policies WHERE org_id = $2 AND id = $3)
           RETURNING *`,
          [
            input.id,
            input.orgId,
            input.policyId,
            input.bodyMd,
            input.summary,
            input.createdAt.toISOString(),
          ],
        );
        if (result.rowCount === 0) return { ok: false, error: { kind: "not_found" } };
        return { ok: true, value: mapVersion(result.rows[0]!) };
      } catch (err: unknown) {
        if (isUniqueViolation(err)) {
          return { ok: false, error: { kind: "conflict", entity: "policy_version" } };
        }
        return safeError("Failed to create policy version");
      }
    },

    async getVersionById(orgId: Uuid, versionId: Uuid): Promise<PoliciesResult<PolicyVersion>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM policies_versions WHERE org_id = $1 AND id = $2`,
          [orgId, versionId],
        );
        if (result.rowCount === 0) return { ok: false, error: { kind: "not_found" } };
        return { ok: true, value: mapVersion(result.rows[0]!) };
      } catch {
        return safeError("Failed to read policy version");
      }
    },

    async listVersions(orgId: Uuid, policyId: Uuid): Promise<PoliciesResult<PolicyVersion[]>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM policies_versions
            WHERE org_id = $1 AND policy_id = $2
            ORDER BY version DESC`,
          [orgId, policyId],
        );
        return { ok: true, value: result.rows.map(mapVersion) };
      } catch {
        return safeError("Failed to list policy versions");
      }
    },

    async attachDocument(
      orgId: Uuid,
      versionId: Uuid,
      input: AttachDocumentInput,
    ): Promise<PoliciesResult<PolicyVersion>> {
      try {
        // `published_at IS NULL` in the WHERE is the immutability rule, not a
        // convention: a published version cannot gain or change a document.
        const result = await executor.execute<Record<string, unknown>>(
          `UPDATE policies_versions
              SET object_key = $3, content_type = $4, byte_size = $5,
                  sha256 = $6, filename = $7
            WHERE org_id = $1 AND id = $2 AND published_at IS NULL
            RETURNING *`,
          [
            orgId,
            versionId,
            input.objectKey,
            input.contentType,
            input.byteSize,
            input.sha256,
            input.filename,
          ],
        );
        if (result.rowCount === 0) {
          const existing = await executor.execute<Record<string, unknown>>(
            `SELECT id FROM policies_versions WHERE org_id = $1 AND id = $2`,
            [orgId, versionId],
          );
          if (existing.rowCount === 0) return { ok: false, error: { kind: "not_found" } };
          return { ok: false, error: { kind: "immutable", entity: "policy_version" } };
        }
        return { ok: true, value: mapVersion(result.rows[0]!) };
      } catch {
        return safeError("Failed to attach the document");
      }
    },

    async publishVersion(
      orgId: Uuid,
      versionId: Uuid,
      publishedBy: string,
      publishedAt: Date,
    ): Promise<PoliciesResult<PolicyVersion>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `UPDATE policies_versions
              SET published_at = $3, published_by = $4
            WHERE org_id = $1 AND id = $2
              AND published_at IS NULL
              AND (object_key IS NOT NULL OR (body_md IS NOT NULL AND body_md <> ''))
            RETURNING *`,
          [orgId, versionId, publishedAt.toISOString(), publishedBy],
        );
        if (result.rowCount === 0) {
          const existing = await executor.execute<Record<string, unknown>>(
            `SELECT published_at, object_key, body_md
               FROM policies_versions WHERE org_id = $1 AND id = $2`,
            [orgId, versionId],
          );
          if (existing.rowCount === 0) return { ok: false, error: { kind: "not_found" } };
          const row = existing.rows[0]!;
          if (row.published_at) {
            return { ok: false, error: { kind: "immutable", entity: "policy_version" } };
          }
          return { ok: false, error: { kind: "conflict", entity: "version_empty" } };
        }
        const published = mapVersion(result.rows[0]!);
        // The register points at the newest published version. A separate
        // statement because D1 cannot roll back; the version row is the
        // record of truth and this pointer is derived from it.
        await executor.execute(
          `UPDATE policies_policies
              SET current_version_id = $3, status = 'active', updated_at = $4
            WHERE org_id = $1 AND id = $2`,
          [orgId, published.policyId, published.id, publishedAt.toISOString()],
        );
        return { ok: true, value: published };
      } catch {
        return safeError("Failed to publish the policy version");
      }
    },

    async upsertStaff(input: UpsertStaffInput): Promise<PoliciesResult<StaffMember>> {
      try {
        // A roster re-upload is an UPDATE, not a duplicate: the identity of a
        // member of staff is their email within the organization.
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO policies_staff
             (id, org_id, full_name, email, email_lower, work_state, location, role,
              status, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', $9, $9)
           ON CONFLICT (org_id, email_lower) DO UPDATE SET
             full_name  = excluded.full_name,
             email      = excluded.email,
             work_state = excluded.work_state,
             location   = excluded.location,
             role       = excluded.role,
             updated_at = excluded.updated_at
           RETURNING *`,
          [
            input.id,
            input.orgId,
            input.fullName,
            input.email,
            input.emailLower,
            input.workState,
            input.location,
            input.role,
            input.createdAt.toISOString(),
          ],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "conflict", entity: "staff" } };
        }
        return { ok: true, value: mapStaff(result.rows[0]!) };
      } catch (err: unknown) {
        if (isUniqueViolation(err)) {
          return { ok: false, error: { kind: "conflict", entity: "staff" } };
        }
        return safeError("Failed to save the staff member");
      }
    },

    async getStaffById(orgId: Uuid, staffId: Uuid): Promise<PoliciesResult<StaffMember>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM policies_staff WHERE org_id = $1 AND id = $2`,
          [orgId, staffId],
        );
        if (result.rowCount === 0) return { ok: false, error: { kind: "not_found" } };
        return { ok: true, value: mapStaff(result.rows[0]!) };
      } catch {
        return safeError("Failed to read the staff member");
      }
    },

    async listStaffPaged(
      orgId: Uuid,
      params: PageQueryParams,
      filter?: StaffFilter,
    ): Promise<PoliciesResult<PagedResult<StaffMember>>> {
      try {
        const values: unknown[] = [orgId, params.limit + 1];
        const where: string[] = ["org_id = $1"];
        for (const [column, value] of [
          ["work_state", filter?.workState],
          ["location", filter?.location],
          ["role", filter?.role],
          ["status", filter?.status],
        ] as const) {
          if (value) {
            values.push(value);
            where.push(`${column} = $${values.length}`);
          }
        }
        if (params.cursor) {
          values.push(params.cursor.createdAt, params.cursor.id);
          where.push(`(created_at, id) < ($${values.length - 1}, $${values.length})`);
        }
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM policies_staff
            WHERE ${where.join(" AND ")}
            ORDER BY created_at DESC, id DESC
            LIMIT $2`,
          values,
        );
        return { ok: true, value: takePage(result.rows.map(mapStaff), params.limit) };
      } catch {
        return safeError("Failed to list staff");
      }
    },

    async setStaffStatus(
      orgId: Uuid,
      staffId: Uuid,
      status: string,
      updatedAt: Date,
    ): Promise<PoliciesResult<StaffMember>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `UPDATE policies_staff
              SET status = $3, updated_at = $4
            WHERE org_id = $1 AND id = $2
            RETURNING *`,
          [orgId, staffId, status, updatedAt.toISOString()],
        );
        if (result.rowCount === 0) return { ok: false, error: { kind: "not_found" } };
        return { ok: true, value: mapStaff(result.rows[0]!) };
      } catch {
        return safeError("Failed to update the staff member");
      }
    },
  };
}
