export interface Env {
  PLATFORM_DB?: D1Database;
  /** The policy document store. Private; this worker is its only reader. */
  POLICY_DOCS?: R2Bucket;
  MEMBERSHIP_WORKER?: Fetcher;
  POLICY_WORKER?: Fetcher;
  ENVIRONMENT: string;
}
