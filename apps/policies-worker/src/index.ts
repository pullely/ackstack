import type { Env } from "./env.js";
import { route } from "./router.js";
import { sweepUnsent } from "./scheduled.js";
import { runRecollection } from "./recollection.js";

/** The nightly re-collection trigger; every other trigger is the send sweep. */
export const RECOLLECTION_CRON = "15 6 * * *";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return route(request, env);
  },

  /**
   * Two triggers. Nightly (06:15 UTC): open the due re-collection rounds, with
   * no human (AS3). Every ten minutes: send acknowledgment requests a round
   * left unsent (AS2).
   */
  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const now = new Date(controller.scheduledTime || Date.now());
    try {
      if (controller.cron === RECOLLECTION_CRON) {
        const summary = await runRecollection(env, now);
        // eslint-disable-next-line no-console -- one structured line per nightly run
        console.log(JSON.stringify({ level: "info", msg: "recollection", ...summary }));
        return;
      }
      const result = await sweepUnsent(env, now);
      if (result.pending > 0) {
        console.warn(`[scheduled] sweep: ${result.sent} sent of ${result.pending} unsent`);
      }
    } catch (err) {
      console.error("[scheduled] failed", controller.cron, err instanceof Error ? err.message : "unknown");
    }
  },
} satisfies ExportedHandler<Env>;

// perf(db): reverted to per-request DB client (task 0134 connection reuse rolled back).
