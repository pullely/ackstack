-- 220_policies_rules
-- The re-collection calendar (AS3): how often each state requires a policy to
-- be acknowledged again.
-- Bounded context: policies
-- schema policies: per-organization rows from the start (seeded on first use
-- with the shipped defaults), so an employer can override any interval
-- without a code change.

CREATE TABLE IF NOT EXISTS policies_rules (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL,
  state           TEXT NOT NULL,
  category        TEXT NOT NULL,
  interval_months INTEGER NOT NULL CHECK (interval_months BETWEEN 1 AND 120),
  enabled         INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- table policies_rules: Re-collection intervals by work state and policy category. Every query must scope by org_id.
-- column policies_rules.state: Two-letter US state, or '*' for the organization default.
-- column policies_rules.category: A policies_policies.category, or '*' for every category.
-- column policies_rules.interval_months: How long an acknowledgment stays current before the nightly round asks again.

CREATE UNIQUE INDEX IF NOT EXISTS policies_rules_org_state_category_idx
  ON policies_rules (org_id, state, category);

CREATE UNIQUE INDEX IF NOT EXISTS policies_rules_org_id_id_idx
  ON policies_rules (org_id, id);
