-- 210_policies_assignments
-- Assignment rounds and the acknowledgment requests they send (AS2).
-- Bounded context: policies
-- schema policies: a round is a photograph of the roster at one instant; each
-- acknowledgment row is one member of staff's request and, once confirmed, the
-- proof — naming the exact version, the timestamp and the IP.

-- Assignment rounds: one policy version sent to one audience.
CREATE TABLE IF NOT EXISTS policies_assignments (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL,
  policy_id    TEXT NOT NULL,
  version_id   TEXT NOT NULL,
  reason       TEXT NOT NULL DEFAULT 'initial'
               CHECK (reason IN ('initial', 'new_version', 'scheduled')),
  audience     TEXT NOT NULL DEFAULT '{}',
  due_at       TEXT,
  status       TEXT NOT NULL DEFAULT 'open'
               CHECK (status IN ('open', 'closed')),
  schedule_key TEXT,
  created_by   TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  closed_at    TEXT,
  FOREIGN KEY (org_id, policy_id) REFERENCES policies_policies (org_id, id),
  FOREIGN KEY (org_id, version_id) REFERENCES policies_versions (org_id, id)
);

-- table policies_assignments: Assignment rounds. Every query must scope by org_id.
-- column policies_assignments.version_id: The exact published version this round asks staff to acknowledge.
-- column policies_assignments.audience: JSON { states, locations, roles }; an empty list matches everyone.
-- column policies_assignments.schedule_key: Set only on a round the nightly re-collection opened; unique per org, which is what makes the cron idempotent.

CREATE UNIQUE INDEX IF NOT EXISTS policies_assignments_org_id_id_idx
  ON policies_assignments (org_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS policies_assignments_org_schedule_key_idx
  ON policies_assignments (org_id, schedule_key)
  WHERE schedule_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS policies_assignments_org_created_idx
  ON policies_assignments (org_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS policies_assignments_org_policy_idx
  ON policies_assignments (org_id, policy_id, created_at DESC);

-- Acknowledgment requests and records. The link token is never stored: only
-- its SHA-256, so a leaked database cannot be replayed as links.
CREATE TABLE IF NOT EXISTS policies_acknowledgments (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL,
  assignment_id   TEXT NOT NULL,
  staff_id        TEXT NOT NULL,
  policy_id       TEXT NOT NULL,
  version_id      TEXT NOT NULL,
  token_hash      TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  sent_at         TEXT,
  acknowledged_at TEXT,
  ack_ip          TEXT,
  ack_user_agent  TEXT,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'acknowledged', 'superseded')),
  superseded_at   TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (org_id, assignment_id) REFERENCES policies_assignments (org_id, id),
  FOREIGN KEY (org_id, staff_id) REFERENCES policies_staff (org_id, id)
);

-- table policies_acknowledgments: One member of staff's acknowledgment request within a round, and its proof once confirmed.
-- column policies_acknowledgments.version_id: Denormalized from the round so the proof names the version even if the round is edited.
-- column policies_acknowledgments.token_hash: SHA-256 (hex) of the link token; the token itself exists only in the email.
-- column policies_acknowledgments.ack_ip: CF-Connecting-IP at the moment of confirmation.

CREATE UNIQUE INDEX IF NOT EXISTS policies_acknowledgments_token_hash_idx
  ON policies_acknowledgments (token_hash);

CREATE UNIQUE INDEX IF NOT EXISTS policies_acknowledgments_org_id_id_idx
  ON policies_acknowledgments (org_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS policies_acknowledgments_assignment_staff_idx
  ON policies_acknowledgments (assignment_id, staff_id);

CREATE INDEX IF NOT EXISTS policies_acknowledgments_org_policy_staff_idx
  ON policies_acknowledgments (org_id, policy_id, staff_id, status);

CREATE INDEX IF NOT EXISTS policies_acknowledgments_org_staff_created_idx
  ON policies_acknowledgments (org_id, staff_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS policies_acknowledgments_org_assignment_idx
  ON policies_acknowledgments (org_id, assignment_id, status);
