-- Skillcheck M1 baseline schema.
-- Style ported from operation-hired: TEXT ids, enum-as-CHECK inline constraints,
-- datetime('now') defaults on bookkeeping columns only (never on graded/published
-- data — those derive time from snapshot_date so screening/publishing stay wall-clock
-- free and bit-for-bit reproducible). Numbered migrations live in db/migrations/.
--
-- Validity vs findings (agenteval separation): frontmatter_valid is a column on skills,
-- never a finding. An invalid skill gets zero findings and zero grade rows and is
-- excluded from the graded cohort; the invalid count is published separately.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- runs — one row per pipeline invocation. The provenance anchor for every number.
-- snapshot_date is set by harvest and INHERITED by screen (screen never reads the
-- clock). cohort_hash + ruleset_hash make a screen run's inputs verifiable; a repro
-- against a drifted DB or ruleset fails loudly on hash mismatch.
-- ---------------------------------------------------------------------------
CREATE TABLE runs (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('harvest','screen','publish')),
  started_at    TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at   TEXT,
  status        TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','complete','failed')),
  snapshot_date TEXT,                 -- YYYY-MM-DD
  seed          INTEGER,              -- screen only
  sample_n      INTEGER,              -- screen only; NULL = full cohort
  cohort_hash   TEXT,                 -- sha256 over sorted screened skill ids
  ruleset_hash  TEXT,                 -- sha256 over canonicalized rule packs
  code_version  TEXT,                 -- git HEAD
  node_version  TEXT,
  params_json   TEXT                  -- full CLI args + source-selection record (canonical JSON)
);

-- ---------------------------------------------------------------------------
-- skills — the deduped cohort. id is stable across runs (hash of repo+path).
-- UNIQUE(repo, path) is the dedupe key. Hygiene/abandonment inputs are all captured
-- at harvest so grading never touches the network or the clock.
-- ---------------------------------------------------------------------------
CREATE TABLE skills (
  id                 TEXT PRIMARY KEY,   -- 'sk_' + hex16(sha256(repo || '\n' || path))
  repo               TEXT NOT NULL,      -- 'owner/name'
  path               TEXT NOT NULL,      -- SKILL.md path within repo
  source             TEXT NOT NULL CHECK (source IN
                       ('anthropics_skills','official_marketplace','community_registry','code_search')),
  source_detail      TEXT,               -- registry/marketplace entry name
  sources_json       TEXT,               -- all sources that listed it (priority order keeps highest in `source`)
  name               TEXT,
  description        TEXT,
  frontmatter_valid  INTEGER NOT NULL DEFAULT 0 CHECK (frontmatter_valid IN (0,1)),
  frontmatter_json   TEXT,               -- canonical JSON, NULL when invalid
  repo_stars         INTEGER,
  repo_pushed_at     TEXT,               -- repo-level last push (primary abandonment signal)
  repo_archived      INTEGER CHECK (repo_archived IN (0,1)),
  repo_fork          INTEGER CHECK (repo_fork IN (0,1)),
  repo_license       TEXT,
  default_branch     TEXT,
  head_sha           TEXT,               -- commit the mirror snapshot pinned
  content_sha256     TEXT,               -- SKILL.md bytes — cross-repo copy detection
  dir_file_count     INTEGER,
  dir_bytes          INTEGER,
  mirror_path        TEXT,               -- relative path under data/mirror/
  harvest_run_id     TEXT NOT NULL REFERENCES runs(id),
  first_seen_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (repo, path)
);

-- ---------------------------------------------------------------------------
-- findings — one row per rule hit, with machine evidence. id is content-derived so
-- re-inserts are idempotent (INSERT OR IGNORE). line/col are NOT NULL DEFAULT 0
-- (0 = file-level) because SQLite treats NULLs as distinct, which would let duplicate
-- file-level findings accumulate. matched_text/context are SANITIZED at emission
-- (invisible codepoints escaped, capped) — the audit must not republish live payloads.
-- ---------------------------------------------------------------------------
CREATE TABLE findings (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL REFERENCES runs(id),
  skill_id     TEXT NOT NULL REFERENCES skills(id),
  rule_id      TEXT NOT NULL,
  pack         TEXT NOT NULL,
  severity     TEXT NOT NULL CHECK (severity IN ('critical','high','medium','low','info')),
  file         TEXT NOT NULL,
  line         INTEGER NOT NULL DEFAULT 0,
  col          INTEGER NOT NULL DEFAULT 0,
  matched_text TEXT NOT NULL,
  context      TEXT,
  message      TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- claims — README quantified-claim/metric tokens. M1 extracts + counts only;
-- `verified` stays 'unverified' until the M2 honesty judge fills it.
-- ---------------------------------------------------------------------------
CREATE TABLE claims (
  id         TEXT PRIMARY KEY,
  run_id     TEXT NOT NULL REFERENCES runs(id),
  skill_id   TEXT NOT NULL REFERENCES skills(id),
  claim_type TEXT NOT NULL CHECK (claim_type IN ('metric','claim')),
  token      TEXT NOT NULL,
  file       TEXT NOT NULL,
  line       INTEGER NOT NULL DEFAULT 0,
  context    TEXT,
  verified   TEXT NOT NULL DEFAULT 'unverified' CHECK (verified IN ('unverified','supported','unsupported'))
);

-- ---------------------------------------------------------------------------
-- grades — one row per (skill, dimension). Effectiveness + Honesty are stored as
-- explicit 'not_yet_benchmarked' rows in M1 so honest labeling is structural, not a
-- rendering choice. tier is an absolute per-skill function of inputs_json (never
-- cohort-relative) so a sampled run reproduces a full run's grades exactly.
-- ---------------------------------------------------------------------------
CREATE TABLE grades (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES runs(id),
  skill_id    TEXT NOT NULL REFERENCES skills(id),
  dimension   TEXT NOT NULL CHECK (dimension IN ('effectiveness','safety','honesty','hygiene')),
  tier        TEXT NOT NULL CHECK (tier IN ('A','B','C','D','F','not_yet_benchmarked')),
  inputs_json TEXT,                     -- deterministic grading inputs (provenance)
  UNIQUE (run_id, skill_id, dimension)
);

-- ---------------------------------------------------------------------------
-- calls — LLM gateway cost ledger (the OH upgrade: stderr → persisted rows). Unused
-- by the M1 static pipeline but built + tested now as core infra for M2.
-- ---------------------------------------------------------------------------
CREATE TABLE calls (
  id                    TEXT PRIMARY KEY,
  run_id                TEXT REFERENCES runs(id),
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  provider              TEXT NOT NULL,
  model                 TEXT NOT NULL,
  purpose               TEXT,
  input_tokens          INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens         INTEGER NOT NULL DEFAULT 0,
  cost_usd              REAL NOT NULL DEFAULT 0,
  error                 TEXT
);

-- ---------------------------------------------------------------------------
-- disclosures — responsible-disclosure state per skill with a qualifying finding.
-- placeholder_id is HMAC(anon_salt, skill_id) — NOT sha256(skill_id), which would be
-- reversible since the cohort universe is public. anon_salt lives in `meta`, is random,
-- and is never published (gitignored with the DB). Release is a human command, never
-- auto-triggered by the due date (14 days is a floor, not a timer).
-- ---------------------------------------------------------------------------
CREATE TABLE disclosures (
  skill_id              TEXT PRIMARY KEY REFERENCES skills(id),
  first_critical_run_id TEXT NOT NULL REFERENCES runs(id),
  placeholder_id        TEXT NOT NULL UNIQUE,   -- 'SC-ANON-' + hex8(HMAC_SHA256(anon_salt, skill_id))
  status                TEXT NOT NULL DEFAULT 'pending_notice'
                          CHECK (status IN ('pending_notice','notified','disclosed','resolved','withdrawn')),
  notified_at           TEXT,
  disclosure_due_at     TEXT,                   -- notified_at + 14 days
  notes                 TEXT
);

-- ---------------------------------------------------------------------------
-- meta — small key/value store. Holds anon_salt (random, NEVER published).
-- ---------------------------------------------------------------------------
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- harvest_tasks — resumability checkpoints. A killed harvest re-runs from here;
-- every discovery is an idempotent upsert so re-running is safe.
-- ---------------------------------------------------------------------------
CREATE TABLE harvest_tasks (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES runs(id),
  kind        TEXT NOT NULL CHECK (kind IN
                ('clone','tree_scan','code_search_slice','registry_parse','marketplace','repo_meta_batch')),
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','failed')),
  detail_json TEXT,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Indexes -------------------------------------------------------------------
CREATE INDEX idx_skills_source            ON skills(source);
CREATE INDEX idx_skills_frontmatter_valid ON skills(frontmatter_valid);
CREATE INDEX idx_skills_pushed_at         ON skills(repo_pushed_at);
CREATE INDEX idx_skills_content_sha       ON skills(content_sha256);
CREATE INDEX idx_findings_skill           ON findings(skill_id);
CREATE INDEX idx_findings_run             ON findings(run_id);
CREATE INDEX idx_findings_rule            ON findings(rule_id);
CREATE INDEX idx_findings_severity        ON findings(severity);
CREATE INDEX idx_claims_skill             ON claims(skill_id);
CREATE INDEX idx_claims_run               ON claims(run_id);
CREATE INDEX idx_grades_run               ON grades(run_id);
CREATE INDEX idx_calls_run                ON calls(run_id);
CREATE INDEX idx_harvest_tasks_run_status ON harvest_tasks(run_id, status);
