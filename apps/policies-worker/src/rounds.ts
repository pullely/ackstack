import type { Env } from "./env.js";
import type { Policy, PolicyVersion, StaffMember } from "@saas/db/policies";
import type {
  Acknowledgment,
  AcknowledgmentView,
  Assignment,
  Audience,
  RoundsRepository,
} from "@saas/db/policies";
import type { EventsRepository } from "@saas/db/events";
import type { Uuid } from "@saas/db/ids";
import { enqueueNotification, buildIdempotencyKey } from "@saas/notifications-client";
import { hashToken, linkExpiry, mintToken } from "./tokens.js";
import {
  assignmentPublicId,
  orgPublicId,
  policyPublicId,
  staffPublicId,
  versionPublicId,
} from "./ids.js";

/**
 * The round machinery, shared by a hand-made round (POST /assignments), a
 * reminder, the send sweep, a new-version round and the nightly
 * re-collection (AS3) — so every path mints, stores and sends a link the same
 * way.
 */

/**
 * How many emails one invocation hands to the mailer. Each is a service-binding
 * subrequest; the rest of a large round goes out on the next sweep (every ten
 * minutes), which rotates the link as it sends.
 */
export const SEND_BUDGET = 40;

export type Enqueue = typeof enqueueNotification;

export interface RoundContext {
  env: Env;
  requestId: string;
  now: Date;
  rounds: RoundsRepository;
  events: EventsRepository;
  actor: { subjectType: string; subjectId: string };
  enqueue?: Enqueue;
}

export interface SentLink {
  staffId: string;
  link: string;
}

export function ackLink(env: Env, token: string): string {
  const base = (env.ACK_LINK_BASE_URL ?? "").replace(/\/+$/, "");
  return `${base}/ack/${token}`;
}

export function isDebugDelivery(env: Env): boolean {
  return env.DEBUG_DELIVERY === "true";
}

export function normalizeAudience(raw: unknown): Audience | null {
  if (raw === undefined || raw === null) return { states: [], locations: [], roles: [] };
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: Audience = { states: [], locations: [], roles: [] };
  for (const key of ["states", "locations", "roles"] as const) {
    const value = (raw as Record<string, unknown>)[key];
    if (value === undefined || value === null) continue;
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) return null;
    const cleaned = (value as string[]).map((v) => v.trim()).filter((v) => v.length > 0);
    out[key] = key === "states" ? cleaned.map((v) => v.toUpperCase()) : cleaned;
  }
  if (out.states.some((s) => !/^[A-Z]{2}$/.test(s))) return null;
  return out;
}

async function sendOne(
  ctx: RoundContext,
  request: {
    ackId: string;
    orgId: string;
    staffEmail: string;
    staffName: string;
    policyTitle: string;
    version: number;
    summary: string | null;
    dueAt: Date | null;
    token: string;
    template: "policy.acknowledgment_request" | "policy.acknowledgment_reminder";
    attempt: string;
  },
): Promise<boolean> {
  const enqueue = ctx.enqueue ?? enqueueNotification;
  const result = await enqueue(
    ctx.env,
    {
      internalActor: "policies-worker",
      actorSubjectType: ctx.actor.subjectType,
      actorSubjectId: ctx.actor.subjectId,
      requestId: ctx.requestId,
    },
    {
      orgId: request.orgId,
      category: "product",
      templateKey: request.template,
      // The link IS the message, the way a login code is for auth.magic_link:
      // the database keeps only the token's hash.
      templateData: {
        staffName: request.staffName,
        policyTitle: request.policyTitle,
        version: request.version,
        summary: request.summary ?? "",
        dueAt: request.dueAt ? request.dueAt.toISOString() : "",
        link: ackLink(ctx.env, request.token),
      },
      recipient: { channel: "email", address: request.staffEmail },
      idempotencyKey: buildIdempotencyKey(request.template, request.ackId, request.attempt),
    },
  );
  return result.ok;
}

export type OpenRoundResult =
  | {
      kind: "opened";
      assignment: Assignment;
      acknowledgments: Acknowledgment[];
      sent: number;
      links: SentLink[];
    }
  | { kind: "duplicate" }
  | { kind: "empty" }
  | { kind: "error" };

export async function openRound(
  ctx: RoundContext,
  input: {
    orgId: Uuid;
    policy: Policy;
    version: PolicyVersion;
    reason: "initial" | "new_version" | "scheduled";
    audience: Audience;
    dueAt: Date | null;
    scheduleKey?: string | null;
    /** A fixed recipient list (new-version and scheduled rounds); otherwise the audience is resolved. */
    recipients?: StaffMember[];
  },
): Promise<OpenRoundResult> {
  let recipients = input.recipients;
  if (!recipients) {
    const resolved = await ctx.rounds.resolveAudience(input.orgId, input.audience);
    if (!resolved.ok) return { kind: "error" };
    recipients = resolved.value;
  }
  if (recipients.length === 0) return { kind: "empty" };

  const created = await ctx.rounds.createAssignment({
    id: crypto.randomUUID(),
    orgId: input.orgId,
    policyId: input.policy.id,
    versionId: input.version.id,
    reason: input.reason,
    audience: input.audience,
    dueAt: input.dueAt,
    scheduleKey: input.scheduleKey ?? null,
    createdBy: ctx.actor.subjectType === "user" ? ctx.actor.subjectId : null,
    createdAt: ctx.now,
  });
  if (!created.ok) return created.error.kind === "conflict" ? { kind: "duplicate" } : { kind: "error" };
  const assignment = created.value;

  const tokens = new Map<string, string>(); // staffId → token
  const rows = [];
  for (const staff of recipients) {
    const token = mintToken();
    tokens.set(staff.id, token);
    rows.push({ id: crypto.randomUUID(), staffId: staff.id, tokenHash: await hashToken(token) });
  }
  const acks = await ctx.rounds.createAcknowledgments(assignment, rows, linkExpiry(ctx.now, input.dueAt));
  if (!acks.ok) return { kind: "error" };

  const byStaff = new Map(recipients.map((s) => [s.id, s]));
  const sentIds: string[] = [];
  const links: SentLink[] = [];
  for (const ack of acks.value.slice(0, SEND_BUDGET)) {
    const staff = byStaff.get(ack.staffId);
    const token = tokens.get(ack.staffId);
    if (!staff || !token) continue;
    const ok = await sendOne(ctx, {
      ackId: ack.id,
      orgId: input.orgId,
      staffEmail: staff.email,
      staffName: staff.fullName,
      policyTitle: input.policy.title,
      version: input.version.version,
      summary: input.version.summary,
      dueAt: input.dueAt,
      token,
      template: "policy.acknowledgment_request",
      attempt: "initial",
    });
    if (ok) sentIds.push(ack.id);
    links.push({ staffId: staffPublicId(staff.id), link: ackLink(ctx.env, token) });
  }
  if (sentIds.length > 0) await ctx.rounds.markSent(input.orgId, sentIds, ctx.now);

  const base = {
    version: 1,
    source: "policies-worker",
    occurredAt: ctx.now,
    actorType: ctx.actor.subjectType,
    actorId: ctx.actor.subjectId,
    orgId: input.orgId,
    subjectKind: "assignment",
    subjectId: assignment.id,
    subjectName: `${input.policy.title} v${input.version.version}`,
    requestId: ctx.requestId,
  };
  const payload = {
    orgId: orgPublicId(input.orgId),
    assignmentId: assignmentPublicId(assignment.id),
    policyId: policyPublicId(input.policy.id),
    versionId: versionPublicId(input.version.id),
    version: input.version.version,
    reason: input.reason,
    recipients: acks.value.length,
  };
  await ctx.events.appendEventWithAudit({
    event: { ...base, id: crypto.randomUUID(), type: "assignment.created", payload },
    audit: {
      id: crypto.randomUUID(),
      category: "policies",
      description: `Assigned "${input.policy.title}" v${input.version.version} to ${acks.value.length} member(s) of staff (${input.reason})`,
    },
  });
  if (sentIds.length > 0) {
    await ctx.events.appendEventWithAudit({
      event: {
        ...base,
        id: crypto.randomUUID(),
        type: "acknowledgment.sent",
        payload: { ...payload, sent: sentIds.length },
      },
      audit: {
        id: crypto.randomUUID(),
        category: "policies",
        description: `Sent ${sentIds.length} acknowledgment request(s) for "${input.policy.title}" v${input.version.version}`,
      },
    });
  }

  return { kind: "opened", assignment, acknowledgments: acks.value, sent: sentIds.length, links };
}

/**
 * Re-send to pending requests: a reminder for a round, or the sweep for rows
 * that never went out. The stored hash is all we have, so each send mints a
 * fresh link and retires the previous one.
 */
export async function resend(
  ctx: RoundContext,
  pending: AcknowledgmentView[],
  template: "policy.acknowledgment_request" | "policy.acknowledgment_reminder",
): Promise<{ sent: string[]; links: SentLink[] }> {
  const sent: string[] = [];
  const links: SentLink[] = [];
  for (const ack of pending.slice(0, SEND_BUDGET)) {
    const token = mintToken();
    const rotated = await ctx.rounds.rotateToken(
      ack.orgId as Uuid,
      ack.id,
      await hashToken(token),
      linkExpiry(ctx.now, ack.dueAt),
    );
    if (!rotated.ok) continue;
    const ok = await sendOne(ctx, {
      ackId: ack.id,
      orgId: ack.orgId,
      staffEmail: ack.staffEmail,
      staffName: ack.staffName,
      policyTitle: ack.policyTitle,
      version: ack.version,
      summary: ack.versionSummary,
      dueAt: ack.dueAt,
      token,
      template,
      attempt: String(ctx.now.getTime()),
    });
    if (ok) sent.push(ack.id);
    links.push({ staffId: staffPublicId(ack.staffId), link: ackLink(ctx.env, token) });
  }
  return { sent, links };
}
