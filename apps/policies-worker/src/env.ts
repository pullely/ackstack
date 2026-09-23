export interface Env {
  PLATFORM_DB?: D1Database;
  /** The policy document store. Private; this worker is its only reader. */
  POLICY_DOCS?: R2Bucket;
  MEMBERSHIP_WORKER?: Fetcher;
  POLICY_WORKER?: Fetcher;
  /** AS2: acknowledgment request emails go out through notifications-worker. */
  NOTIFICATIONS_WORKER?: Fetcher;
  /** The console origin the emailed link points at: `${ACK_LINK_BASE_URL}/ack/<token>`. */
  ACK_LINK_BASE_URL?: string;
  /** The baseline's inline-delivery profile: when "true", created links are also returned to the admin. */
  DEBUG_DELIVERY?: string;
  ENVIRONMENT: string;
}
