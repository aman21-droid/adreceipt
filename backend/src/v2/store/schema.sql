-- AdReceipt V2 campaign, reservation and measurement schema.
--
-- Applied by migrate.ts, which runs this file inside one transaction and
-- records it in schema_migrations. The file is idempotent so re-running it is
-- safe; it is versioned rather than edited once it has shipped.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version     TEXT PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS advertisers (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT        NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  payer       TEXT        NOT NULL CHECK (payer ~ '^0x[0-9a-f]{40}$'),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The live head of each campaign. Terms are duplicated from the newest revision
-- so matching reads one row rather than joining on every request; the revision
-- table remains the audit trail.
CREATE TABLE IF NOT EXISTS campaigns (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  advertiser_id   UUID        NOT NULL REFERENCES advertisers(id) ON DELETE RESTRICT,
  state           TEXT        NOT NULL CHECK (state IN ('DRAFT', 'APPROVED', 'PAUSED')),
  revision_number INTEGER     NOT NULL CHECK (revision_number >= 1),
  revision_hash   TEXT        NOT NULL CHECK (revision_hash ~ '^0x[0-9a-f]{64}$'),
  manifest        JSONB       NOT NULL,
  total_budget    NUMERIC(78,0) NOT NULL CHECK (total_budget > 0),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS campaigns_state_idx ON campaigns (state);
CREATE INDEX IF NOT EXISTS campaigns_advertiser_idx ON campaigns (advertiser_id);

-- Append only. There is no UPDATE or DELETE path to this table in the code.
CREATE TABLE IF NOT EXISTS campaign_revisions (
  campaign_id     UUID        NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  revision_number INTEGER     NOT NULL CHECK (revision_number >= 1),
  revision_hash   TEXT        NOT NULL,
  manifest        JSONB       NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id, revision_number)
);

-- An application-level hold on part of a campaign budget, taken before a
-- placement is offered and released when it is abandoned. The contract does not
-- enforce aggregate budgets, so this table plus settled Graph spend is what
-- stops over-delivery.
CREATE TABLE IF NOT EXISTS reservations (
  reservation_key TEXT PRIMARY KEY,
  campaign_id     UUID          NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  amount          NUMERIC(78,0) NOT NULL CHECK (amount > 0),
  state           TEXT          NOT NULL CHECK (state IN ('ACTIVE', 'RELEASED')),
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
  released_at     TIMESTAMPTZ
);

-- Partial index: only ACTIVE rows are ever summed, and they are summed on every
-- reservation attempt.
CREATE INDEX IF NOT EXISTS reservations_active_idx
  ON reservations (campaign_id) WHERE state = 'ACTIVE';

-- Application-observed delivery. Deliberately carries no query, no user
-- identifier and no request metadata: an impression record is a count, and
-- anything else here would be a second copy of data the envelope exists to
-- keep out of storage.
CREATE TABLE IF NOT EXISTS measurement_events (
  event_key   TEXT PRIMARY KEY,
  campaign_id UUID        NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  kind        TEXT        NOT NULL CHECK (kind IN ('IMPRESSION', 'CLICK')),
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS measurement_events_campaign_idx
  ON measurement_events (campaign_id, kind);
