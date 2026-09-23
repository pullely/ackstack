import type { SqlExecutor } from "../d1/executor.js";
import type { Uuid } from "../ids/index.js";
import type {
  CursorPosition,
  PagedResult,
  PageQueryParams,
  PoliciesResult,
  StaffMember,
} from "./types.js";

/**
 * Assignment rounds and acknowledgment requests (AS2).
 *
 * Every write that a caller branches on carries `RETURNING`: the D1 executor
 * reports `rowCount` as the number of rows RETURNED, so an UPDATE or INSERT
 * without it always looks like it touched nothing.
 */

export interface Audience {
  states: string[];
  locations: string[];
  roles: string[];
}

export interface Assignment {
  id: string;
  orgId: string;
  policyId: string;
  versionId: string;
  reason: string;
  audience: Audience;
  dueAt: Date | null;
  status: string;
  scheduleKey: string | null;
  createdBy: string | null;
  createdAt: Date;
  closedAt: Date | null;
}

export interface Acknowledgment {
  id: string;
  orgId: string;
  assignmentId: string;
  staffId: string;
  policyId: string;
  versionId: string;
  expiresAt: Date;
  sentAt: Date | null;
  acknowledgedAt: Date | null;
  ackIp: string | null;
  ackUserAgent: string | null;
  status: string;
  supersededAt: Date | null;
  createdAt: Date;
}

/** An acknowledgment joined to the names an export or a detail view needs. */
export interface AcknowledgmentView extends Acknowledgment {
  staffName: string;
  staffEmail: string;
  staffWorkState: string | null;
  staffLocation: string | null;
  staffRole: string | null;
  policyTitle: string;
  version: number;
  versionSummary: string | null;
  dueAt: Date | null;
}

/** What the public lane shows a member of staff holding a link. */
export interface AckLinkView {
  acknowledgment: Acknowledgment;
  staffName: string;
  policyTitle: string;
  policyCategory: string;
  version: number;
  bodyMd: string | null;
  summary: string | null;
  objectKey: string | null;
  contentType: string | null;
  filename: string | null;
  sha256: string | null;
}

export interface Tally {
  pending: number;
  acknowledged: number;
  superseded: number;
}

export interface CreateAssignmentInput {
  id: string;
  orgId: string;
  policyId: string;
  versionId: string;
  reason: "initial" | "new_version" | "scheduled";
  audience: Audience;
  dueAt: Date | null;
  scheduleKey: string | null;
  createdBy: string | null;
  createdAt: Date;
}

export interface CreateAcknowledgmentInput {
  id: string;
  staffId: string;
  tokenHash: string;
}

export type RecordOutcome =
  | { kind: "recorded"; acknowledgment: Acknowledgment }
  | { kind: "already_recorded"; acknowledgment: Acknowledgment }
  | { kind: "invalid" };

export interface RoundsRepository {
  resolveAudience(orgId: Uuid, audience: Audience): Promise<PoliciesResult<StaffMember[]>>;
  createAssignment(input: CreateAssignmentInput): Promise<PoliciesResult<Assignment>>;
  createAcknowledgments(
    assignment: Assignment,
    rows: CreateAcknowledgmentInput[],
    expiresAt: Date,
  ): Promise<PoliciesResult<Acknowledgment[]>>;
  markSent(orgId: Uuid, ackIds: string[], sentAt: Date): Promise<PoliciesResult<number>>;
  rotateToken(
    orgId: Uuid,
    ackId: string,
    tokenHash: string,
    expiresAt: Date,
  ): Promise<PoliciesResult<Acknowledgment>>;
  getAssignment(orgId: Uuid, assignmentId: Uuid): Promise<PoliciesResult<Assignment>>;
  listAssignmentsPaged(
    orgId: Uuid,
    params: PageQueryParams,
    filter?: { policyId?: string; status?: string },
  ): Promise<PoliciesResult<PagedResult<Assignment>>>;
  tally(orgId: Uuid, assignmentId: Uuid): Promise<PoliciesResult<Tally>>;
  listForAssignment(
    orgId: Uuid,
    assignmentId: Uuid,
    status?: string,
  ): Promise<PoliciesResult<AcknowledgmentView[]>>;
  listUnsent(limit: number): Promise<PoliciesResult<AcknowledgmentView[]>>;
  listAcknowledgmentsPaged(
    orgId: Uuid,
    params: PageQueryParams,
    filter?: { policyId?: string; staffId?: string; status?: string },
  ): Promise<PoliciesResult<PagedResult<AcknowledgmentView>>>;
  findByTokenHash(tokenHash: string): Promise<PoliciesResult<AckLinkView>>;
  recordAcknowledgment(
    tokenHash: string,
    at: Date,
    ip: string | null,
    userAgent: string | null,
  ): Promise<PoliciesResult<RecordOutcome>>;
  supersedePending(
    orgId: Uuid,
    policyId: Uuid,
    keepVersionId: Uuid,
    at: Date,
  ): Promise<PoliciesResult<Acknowledgment[]>>;
  listStaffEverAssigned(orgId: Uuid, policyId: Uuid): Promise<PoliciesResult<StaffMember[]>>;
  /** Every acknowledgment row for a policy or a member of staff, newest first (the exports). */
  listAllAcknowledgments(
    orgId: Uuid,
    filter: { policyId?: string; staffId?: string },
  ): Promise<PoliciesResult<AcknowledgmentView[]>>;
}

/** D1 binds at most 100 parameters per statement; keep every IN list and multi-row insert under it. */
const MAX_PARAMS = 90;

function iso(value: unknown): Date | null {
  return value ? new Date(value as string) : null;
}

function parseAudience(raw: unknown): Audience {
  try {
    const value = JSON.parse(typeof raw === "string" ? raw : "{}") as Partial<Audience>;
    return {
      states: Array.isArray(value.states) ? value.states : [],
      locations: Array.isArray(value.locations) ? value.locations : [],
      roles: Array.isArray(value.roles) ? value.roles : [],
    };
  } catch {
    return { states: [], locations: [], roles: [] };
  }
}

export function mapAssignment(row: Record<string, unknown>): Assignment {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    policyId: row.policy_id as string,
    versionId: row.version_id as string,
    reason: row.reason as string,
    audience: parseAudience(row.audience),
    dueAt: iso(row.due_at),
    status: row.status as string,
    scheduleKey: (row.schedule_key as string | null) ?? null,
    createdBy: (row.created_by as string | null) ?? null,
    createdAt: new Date(row.created_at as string),
    closedAt: iso(row.closed_at),
  };
}

export function mapAcknowledgment(row: Record<string, unknown>): Acknowledgment {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    assignmentId: row.assignment_id as string,
    staffId: row.staff_id as string,
    policyId: row.policy_id as string,
    versionId: row.version_id as string,
    expiresAt: new Date(row.expires_at as string),
    sentAt: iso(row.sent_at),
    acknowledgedAt: iso(row.acknowledged_at),
    ackIp: (row.ack_ip as string | null) ?? null,
    ackUserAgent: (row.ack_user_agent as string | null) ?? null,
    status: row.status as string,
    supersededAt: iso(row.superseded_at),
    createdAt: new Date(row.created_at as string),
  };
}

function mapView(row: Record<string, unknown>): AcknowledgmentView {
  return {
    ...mapAcknowledgment(row),
    staffName: row.staff_name as string,
    staffEmail: row.staff_email as string,
    staffWorkState: (row.staff_work_state as string | null) ?? null,
    staffLocation: (row.staff_location as string | null) ?? null,
    staffRole: (row.staff_role as string | null) ?? null,
    policyTitle: row.policy_title as string,
    version: Number(row.version_number),
    versionSummary: (row.version_summary as string | null) ?? null,
    dueAt: iso(row.assignment_due_at),
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

function takePage<T extends { createdAt: Date; id: string }>(
  rows: T[],
  limit: number,
): PagedResult<T> {
  const items = rows.slice(0, limit);
  let nextCursor: CursorPosition | null = null;
  if (rows.length > limit) {
    const last = items[items.length - 1];
    if (last) nextCursor = { createdAt: last.createdAt.toISOString(), id: last.id };
  }
  return { items, nextCursor };
}

function internal(message: string): PoliciesResult<never> {
  return { ok: false, error: { kind: "internal", message } };
}

/** The joined projection every acknowledgment view reads. */
const VIEW_SELECT = `
  SELECT a.*,
         s.full_name  AS staff_name,
         s.email      AS staff_email,
         s.work_state AS staff_work_state,
         s.location   AS staff_location,
         s.role       AS staff_role,
         p.title      AS policy_title,
         v.version    AS version_number,
         v.summary    AS version_summary,
         g.due_at     AS assignment_due_at
    FROM policies_acknowledgments a
    JOIN policies_assignments g ON g.org_id = a.org_id AND g.id = a.assignment_id
    JOIN policies_staff    s ON s.org_id = a.org_id AND s.id = a.staff_id
    JOIN policies_policies p ON p.org_id = a.org_id AND p.id = a.policy_id
    JOIN policies_versions v ON v.org_id = a.org_id AND v.id = a.version_id`;

export function createRoundsRepository(executor: SqlExecutor): RoundsRepository {
  return {
    async resolveAudience(orgId, audience) {
      try {
        const values: unknown[] = [orgId];
        const where = ["org_id = $1", "status = 'active'"];
        const inList = (column: string, list: string[], lower: boolean) => {
          const cleaned = list.map((v) => v.trim()).filter((v) => v.length > 0);
          if (cleaned.length === 0) return;
          const marks = cleaned.map((v) => {
            values.push(lower ? v.toLowerCase() : v.toUpperCase());
            return `$${values.length}`;
          });
          where.push(`${lower ? `lower(${column})` : `upper(${column})`} IN (${marks.join(", ")})`);
        };
        inList("work_state", audience.states, false);
        inList("location", audience.locations, true);
        inList("role", audience.roles, true);
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM policies_staff WHERE ${where.join(" AND ")} ORDER BY created_at, id`,
          values,
        );
        return { ok: true, value: result.rows.map(mapStaff) };
      } catch {
        return internal("Failed to resolve the audience");
      }
    },

    async createAssignment(input) {
      try {
        // ON CONFLICT DO NOTHING covers the partial (org_id, schedule_key)
        // index: a second nightly run on the same day returns no row, which
        // the caller reads as "already opened".
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO policies_assignments
             (id, org_id, policy_id, version_id, reason, audience, due_at, status,
              schedule_key, created_by, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'open', $8, $9, $10)
           ON CONFLICT DO NOTHING
           RETURNING *`,
          [
            input.id,
            input.orgId,
            input.policyId,
            input.versionId,
            input.reason,
            JSON.stringify(input.audience),
            input.dueAt ? input.dueAt.toISOString() : null,
            input.scheduleKey,
            input.createdBy,
            input.createdAt.toISOString(),
          ],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "conflict", entity: "assignment" } };
        }
        return { ok: true, value: mapAssignment(result.rows[0]!) };
      } catch {
        return internal("Failed to create the assignment");
      }
    },

    async createAcknowledgments(assignment, rows, expiresAt) {
      try {
        const created: Acknowledgment[] = [];
        const perRow = 9;
        const chunkSize = Math.max(1, Math.floor(MAX_PARAMS / perRow));
        const createdAt = assignment.createdAt.toISOString();
        for (let i = 0; i < rows.length; i += chunkSize) {
          const chunk = rows.slice(i, i + chunkSize);
          const values: unknown[] = [];
          const tuples = chunk.map((row) => {
            values.push(
              row.id,
              assignment.orgId,
              assignment.id,
              row.staffId,
              assignment.policyId,
              assignment.versionId,
              row.tokenHash,
              expiresAt.toISOString(),
              createdAt,
            );
            const b = values.length - perRow;
            const marks = Array.from({ length: perRow }, (_, k) => `$${b + k + 1}`);
            return `(${marks.slice(0, 8).join(", ")}, 'pending', ${marks[8]})`;
          });
          const result = await executor.execute<Record<string, unknown>>(
            `INSERT INTO policies_acknowledgments
               (id, org_id, assignment_id, staff_id, policy_id, version_id, token_hash,
                expires_at, status, created_at)
             VALUES ${tuples.join(", ")}
             ON CONFLICT DO NOTHING
             RETURNING *`,
            values,
          );
          created.push(...result.rows.map(mapAcknowledgment));
        }
        return { ok: true, value: created };
      } catch {
        return internal("Failed to create the acknowledgment requests");
      }
    },

    async markSent(orgId, ackIds, sentAt) {
      try {
        let marked = 0;
        const chunkSize = MAX_PARAMS - 2;
        for (let i = 0; i < ackIds.length; i += chunkSize) {
          const chunk = ackIds.slice(i, i + chunkSize);
          const marks = chunk.map((_, j) => `$${j + 3}`);
          const result = await executor.execute<Record<string, unknown>>(
            `UPDATE policies_acknowledgments
                SET sent_at = $2
              WHERE org_id = $1 AND id IN (${marks.join(", ")})
              RETURNING id`,
            [orgId, sentAt.toISOString(), ...chunk],
          );
          marked += result.rowCount;
        }
        return { ok: true, value: marked };
      } catch {
        return internal("Failed to mark the requests sent");
      }
    },

    async rotateToken(orgId, ackId, tokenHash, expiresAt) {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `UPDATE policies_acknowledgments
              SET token_hash = $3, expires_at = $4
            WHERE org_id = $1 AND id = $2 AND status = 'pending'
            RETURNING *`,
          [orgId, ackId, tokenHash, expiresAt.toISOString()],
        );
        if (result.rowCount === 0) return { ok: false, error: { kind: "not_found" } };
        return { ok: true, value: mapAcknowledgment(result.rows[0]!) };
      } catch {
        return internal("Failed to rotate the link");
      }
    },

    async getAssignment(orgId, assignmentId) {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM policies_assignments WHERE org_id = $1 AND id = $2`,
          [orgId, assignmentId],
        );
        if (result.rowCount === 0) return { ok: false, error: { kind: "not_found" } };
        return { ok: true, value: mapAssignment(result.rows[0]!) };
      } catch {
        return internal("Failed to read the assignment");
      }
    },

    async listAssignmentsPaged(orgId, params, filter) {
      try {
        const values: unknown[] = [orgId, params.limit + 1];
        const where = ["org_id = $1"];
        if (filter?.policyId) {
          values.push(filter.policyId);
          where.push(`policy_id = $${values.length}`);
        }
        if (filter?.status) {
          values.push(filter.status);
          where.push(`status = $${values.length}`);
        }
        if (params.cursor) {
          values.push(params.cursor.createdAt, params.cursor.id);
          where.push(`(created_at, id) < ($${values.length - 1}, $${values.length})`);
        }
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM policies_assignments
            WHERE ${where.join(" AND ")}
            ORDER BY created_at DESC, id DESC
            LIMIT $2`,
          values,
        );
        return { ok: true, value: takePage(result.rows.map(mapAssignment), params.limit) };
      } catch {
        return internal("Failed to list assignments");
      }
    },

    async tally(orgId, assignmentId) {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT status, COUNT(*) AS n FROM policies_acknowledgments
            WHERE org_id = $1 AND assignment_id = $2
            GROUP BY status`,
          [orgId, assignmentId],
        );
        const tally: Tally = { pending: 0, acknowledged: 0, superseded: 0 };
        for (const row of result.rows) {
          const status = row.status as keyof Tally;
          if (status in tally) tally[status] = Number(row.n);
        }
        return { ok: true, value: tally };
      } catch {
        return internal("Failed to count the round");
      }
    },

    async listForAssignment(orgId, assignmentId, status) {
      try {
        const values: unknown[] = [orgId, assignmentId];
        let extra = "";
        if (status) {
          values.push(status);
          extra = ` AND a.status = $3`;
        }
        const result = await executor.execute<Record<string, unknown>>(
          `${VIEW_SELECT}
            WHERE a.org_id = $1 AND a.assignment_id = $2${extra}
            ORDER BY s.full_name, a.id`,
          values,
        );
        return { ok: true, value: result.rows.map(mapView) };
      } catch {
        return internal("Failed to list the round's recipients");
      }
    },

    async listUnsent(limit) {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `${VIEW_SELECT}
            WHERE a.sent_at IS NULL AND a.status = 'pending'
            ORDER BY a.created_at, a.id
            LIMIT $1`,
          [limit],
        );
        return { ok: true, value: result.rows.map(mapView) };
      } catch {
        return internal("Failed to list unsent requests");
      }
    },

    async listAcknowledgmentsPaged(orgId, params, filter) {
      try {
        const values: unknown[] = [orgId, params.limit + 1];
        const where = ["a.org_id = $1"];
        if (filter?.policyId) {
          values.push(filter.policyId);
          where.push(`a.policy_id = $${values.length}`);
        }
        if (filter?.staffId) {
          values.push(filter.staffId);
          where.push(`a.staff_id = $${values.length}`);
        }
        if (filter?.status) {
          values.push(filter.status);
          where.push(`a.status = $${values.length}`);
        }
        if (params.cursor) {
          values.push(params.cursor.createdAt, params.cursor.id);
          where.push(`(a.created_at, a.id) < ($${values.length - 1}, $${values.length})`);
        }
        const result = await executor.execute<Record<string, unknown>>(
          `${VIEW_SELECT}
            WHERE ${where.join(" AND ")}
            ORDER BY a.created_at DESC, a.id DESC
            LIMIT $2`,
          values,
        );
        return { ok: true, value: takePage(result.rows.map(mapView), params.limit) };
      } catch {
        return internal("Failed to list acknowledgments");
      }
    },

    async findByTokenHash(tokenHash) {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT a.*,
                  s.full_name    AS staff_name,
                  p.title        AS policy_title,
                  p.category     AS policy_category,
                  v.version      AS version_number,
                  v.body_md      AS body_md,
                  v.summary      AS summary,
                  v.object_key   AS object_key,
                  v.content_type AS content_type,
                  v.filename     AS filename,
                  v.sha256       AS sha256
             FROM policies_acknowledgments a
             JOIN policies_staff    s ON s.org_id = a.org_id AND s.id = a.staff_id
             JOIN policies_policies p ON p.org_id = a.org_id AND p.id = a.policy_id
             JOIN policies_versions v ON v.org_id = a.org_id AND v.id = a.version_id
            WHERE a.token_hash = $1`,
          [tokenHash],
        );
        if (result.rowCount === 0) return { ok: false, error: { kind: "not_found" } };
        const row = result.rows[0]!;
        return {
          ok: true,
          value: {
            acknowledgment: mapAcknowledgment(row),
            staffName: row.staff_name as string,
            policyTitle: row.policy_title as string,
            policyCategory: row.policy_category as string,
            version: Number(row.version_number),
            bodyMd: (row.body_md as string | null) ?? null,
            summary: (row.summary as string | null) ?? null,
            objectKey: (row.object_key as string | null) ?? null,
            contentType: (row.content_type as string | null) ?? null,
            filename: (row.filename as string | null) ?? null,
            sha256: (row.sha256 as string | null) ?? null,
          },
        };
      } catch {
        return internal("Failed to read the link");
      }
    },

    async recordAcknowledgment(tokenHash, at, ip, userAgent) {
      try {
        // One conditional UPDATE is the whole single-use rule: a second
        // confirmation finds status <> 'pending' and changes nothing.
        const result = await executor.execute<Record<string, unknown>>(
          `UPDATE policies_acknowledgments
              SET status = 'acknowledged', acknowledged_at = $2, ack_ip = $3, ack_user_agent = $4
            WHERE token_hash = $1 AND status = 'pending' AND expires_at > $2
            RETURNING *`,
          [tokenHash, at.toISOString(), ip, userAgent],
        );
        if (result.rowCount > 0) {
          return { ok: true, value: { kind: "recorded", acknowledgment: mapAcknowledgment(result.rows[0]!) } };
        }
        const existing = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM policies_acknowledgments WHERE token_hash = $1`,
          [tokenHash],
        );
        const row = existing.rows[0];
        if (row && row.status === "acknowledged") {
          return { ok: true, value: { kind: "already_recorded", acknowledgment: mapAcknowledgment(row) } };
        }
        return { ok: true, value: { kind: "invalid" } };
      } catch {
        return internal("Failed to record the acknowledgment");
      }
    },

    async supersedePending(orgId, policyId, keepVersionId, at) {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `UPDATE policies_acknowledgments
              SET status = 'superseded', superseded_at = $4
            WHERE org_id = $1 AND policy_id = $2 AND version_id <> $3 AND status = 'pending'
            RETURNING *`,
          [orgId, policyId, keepVersionId, at.toISOString()],
        );
        return { ok: true, value: result.rows.map(mapAcknowledgment) };
      } catch {
        return internal("Failed to supersede outstanding requests");
      }
    },

    async listStaffEverAssigned(orgId, policyId) {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT s.* FROM policies_staff s
            WHERE s.org_id = $1 AND s.status = 'active'
              AND EXISTS (SELECT 1 FROM policies_acknowledgments a
                           WHERE a.org_id = s.org_id AND a.staff_id = s.id AND a.policy_id = $2)
            ORDER BY s.created_at, s.id`,
          [orgId, policyId],
        );
        return { ok: true, value: result.rows.map(mapStaff) };
      } catch {
        return internal("Failed to list previously assigned staff");
      }
    },
    async listAllAcknowledgments(orgId, filter) {
      try {
        const values: unknown[] = [orgId];
        const where = ["a.org_id = $1"];
        if (filter.policyId) {
          values.push(filter.policyId);
          where.push(`a.policy_id = $${values.length}`);
        }
        if (filter.staffId) {
          values.push(filter.staffId);
          where.push(`a.staff_id = $${values.length}`);
        }
        const result = await executor.execute<Record<string, unknown>>(
          `${VIEW_SELECT}
            WHERE ${where.join(" AND ")}
            ORDER BY a.created_at DESC, a.id DESC
            LIMIT 10000`,
          values,
        );
        return { ok: true, value: result.rows.map(mapView) };
      } catch {
        return internal("Failed to list acknowledgments for export");
      }
    },
  };
}
