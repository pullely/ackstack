import type { Env } from "./env.js";
import type { AcknowledgmentView } from "@saas/db/policies";
import type { Uuid } from "@saas/db/ids";
import { createRoundsRepository } from "@saas/db/policies";
import { createEventsRepository } from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/d1";
import { resend, SEND_BUDGET } from "./rounds.js";
import { generateRequestId } from "./ids.js";

/**
 * The send sweep (every ten minutes). A round larger than one invocation's
 * send budget, or a request whose enqueue failed, is left with `sent_at`
 * NULL; this sends it, minting a fresh link as it does.
 */
export async function sweepUnsent(env: Env, now: Date): Promise<{ sent: number; pending: number }> {
  if (!env.PLATFORM_DB) return { sent: 0, pending: 0 };
  const executor = createSqlExecutor(env.PLATFORM_DB);
  try {
    const rounds = createRoundsRepository(executor);
    const events = createEventsRepository(executor);
    const unsent = await rounds.listUnsent(SEND_BUDGET);
    if (!unsent.ok || unsent.value.length === 0) return { sent: 0, pending: 0 };

    const byOrg = new Map<string, AcknowledgmentView[]>();
    for (const ack of unsent.value) {
      const list = byOrg.get(ack.orgId) ?? [];
      list.push(ack);
      byOrg.set(ack.orgId, list);
    }
    let sent = 0;
    for (const [orgId, list] of byOrg) {
      const result = await resend(
        {
          env,
          requestId: generateRequestId(),
          now,
          rounds,
          events,
          actor: { subjectType: "system", subjectId: "policies-worker" },
        },
        list,
        "policy.acknowledgment_request",
      );
      if (result.sent.length > 0) await rounds.markSent(orgId as Uuid, result.sent, now);
      sent += result.sent.length;
    }
    return { sent, pending: unsent.value.length };
  } finally {
    await executor.dispose();
  }
}
