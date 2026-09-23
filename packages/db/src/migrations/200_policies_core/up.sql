-- 200_policies_core
-- Policy acknowledgments foundation (AS1) — the versioned policy register and
-- the staff roster it is sent to.
-- Bounded context: policies
-- schema policies: Policy acknowledgments bounded context — owns policies,
-- their immutable versions, and the roster of staff who acknowledge them.

-- Policies table: one policy belongs to exactly one organization.
CREATE TABLE IF NOT EXISTS policies_policies (
  id                 TEXT PRIMARY KEY,
  org_id             TEXT NOT NULL,
  title              TEXT NOT NULL,
  slug               TEXT NOT NULL,
  slug_lower         TEXT NOT NULL,
  category           TEXT NOT NULL DEFAULT 'other'
                     CHECK (category IN ('handbook', 'harassment', 'workplace_violence', 'safety', 'other')),
  status             TEXT NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft', 'active', 'retired')),
  current_version_id TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  retired_at         TEXT
);

-- table policies_policies: Policies within an organization. Every query must scope by org_id.
-- column policies_policies.org_id: Owning organization — opaque reference, no cross-context FK.
-- column policies_policies.slug_lower: Lowercased slug for case-insensitive uniqueness within org.
-- column policies_policies.current_version_id: The newest PUBLISHED version; null until the first publish.

CREATE UNIQUE INDEX IF NOT EXISTS policies_org_slug_lower_idx
  ON policies_policies (org_id, slug_lower);

CREATE UNIQUE INDEX IF NOT EXISTS policies_org_id_id_idx
  ON policies_policies (org_id, id);

CREATE INDEX IF NOT EXISTS policies_org_created_idx
  ON policies_policies (org_id, created_at DESC, id DESC);

-- Policy versions: the thing a member of staff actually acknowledges. A
-- version carries two renditions of the same policy — the uploaded document in
-- R2 (object_key) and a Markdown rendition (body_md) that reads on a phone —
-- and both are frozen once published_at is set. A correction is a new version.
CREATE TABLE IF NOT EXISTS policies_versions (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,
  policy_id     TEXT NOT NULL,
  version       INTEGER NOT NULL,
  object_key    TEXT,
  content_type  TEXT,
  byte_size     INTEGER,
  sha256        TEXT,
  filename      TEXT,
  body_md       TEXT,
  summary       TEXT,
  published_at  TEXT,
  published_by  TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (org_id, policy_id) REFERENCES policies_policies (org_id, id)
);

-- table policies_versions: Immutable-once-published versions of a policy.
-- column policies_versions.org_id: Owning organization — denormalized for tenant isolation.
-- column policies_versions.object_key: R2 object key of the uploaded document; null until a document is put.
-- column policies_versions.sha256: Digest of the stored bytes, computed as they stream in.
-- column policies_versions.published_at: Set exactly once; a version with it set can never be written again.

CREATE UNIQUE INDEX IF NOT EXISTS policies_versions_org_policy_version_idx
  ON policies_versions (org_id, policy_id, version);

CREATE UNIQUE INDEX IF NOT EXISTS policies_versions_org_id_id_idx
  ON policies_versions (org_id, id);

CREATE INDEX IF NOT EXISTS policies_versions_org_policy_created_idx
  ON policies_versions (org_id, policy_id, created_at DESC, id DESC);

-- Staff: recipients, not users. They never authenticate; they hold a
-- single-use link token. A member of staff is deactivated, never deleted —
-- the proof of acknowledgment outlives the employment.
CREATE TABLE IF NOT EXISTS policies_staff (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL,
  full_name   TEXT NOT NULL,
  email       TEXT NOT NULL,
  email_lower TEXT NOT NULL,
  work_state  TEXT,
  location    TEXT,
  role        TEXT,
  status      TEXT NOT NULL DEFAULT 'active'
              CHECK (status IN ('active', 'inactive')),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- table policies_staff: The roster an assignment round is resolved against.
-- column policies_staff.org_id: Owning organization — opaque reference, no cross-context FK.
-- column policies_staff.email_lower: Lowercased email for case-insensitive uniqueness within org; a roster re-upload updates on it.
-- column policies_staff.work_state: Two-letter US state; the re-collection clock is chosen by it.

CREATE UNIQUE INDEX IF NOT EXISTS policies_staff_org_email_lower_idx
  ON policies_staff (org_id, email_lower);

CREATE UNIQUE INDEX IF NOT EXISTS policies_staff_org_id_id_idx
  ON policies_staff (org_id, id);

CREATE INDEX IF NOT EXISTS policies_staff_org_created_idx
  ON policies_staff (org_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS policies_staff_org_state_idx
  ON policies_staff (org_id, work_state, status);
