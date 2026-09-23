import type { Env } from "./env.js";
import { route } from "./router.js";
import { sweepUnsent } from "./scheduled.js";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return route(request, env);
  },

  /**
   * Every ten minutes: send acknowledgment requests a round left unsent (a
   * round larger than one invocation's send budget, or a failed enqueue).
   */
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    try {
      const result = await sweepUnsent(env, new Date());
      if (result.pending > 0) {
        console.warn(`[scheduled] sweep: ${result.sent} sent of ${result.pending} unsent`);
      }
    } catch (err) {
      console.error("[scheduled] sweep failed", err instanceof Error ? err.message : "unknown");
    }
  },
} satisfies ExportedHandler<Env>;

// perf(db): reverted to per-request DB client (task 0134 connection reuse rolled back).
