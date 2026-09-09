import { readFileSync } from "fs";
import { join } from "path";
import { Pool, type PoolClient } from "pg";
import {
  parseManifest,
  revisionHash,
  type CampaignManifestV2,
  type CampaignRecord,
  type CampaignState,
} from "../campaigns/manifest";
import {
  NotFoundError,
  StorageUnavailableError,
  type Advertiser,
  type CampaignRevision,
  type DeliveryTotals,
  type RecordEventInput,
  type ReserveInput,
  type ReserveResult,
  type Store,
} from "./store";

/**
 * PostgreSQL implementation of the persistence port.
 *
 * The only interesting method is `reserve`. Everything else is straightforward
 * reads and appends; that one has to hold a real invariant under concurrency,
 * and the way it does so is by taking a row lock on the campaign before it
 * looks at anything. Two requests for the same campaign therefore queue rather
 * than both reading the same "remaining" figure and both deciding there is room
 * for it. Without that lock the budget check is a time-of-check race that shows
 * up only under load, which is precisely when over-delivery costs money.
 */

const SCHEMA_VERSION = "001_campaign_eligibility_v2";

function mapCampaign(row: Record<string, unknown>): CampaignRecord {
  return {
    id: String(row.id),
    advertiserId: String(row.advertiser_id),
    state: String(row.state) as CampaignState,
    revisionNumber: Number(row.revision_number),
    revisionHash: String(row.revision_hash),
    // Re-validated on the way out: a row edited by hand is still untrusted input.
    manifest: parseManifest(row.manifest),
    createdAt: new Date(row.created_at as string).toISOString(),
    updatedAt: new Date(row.updated_at as string).toISOString(),
  };
}

export class PostgresStore implements Store {
  constructor(private readonly pool: Pool) {}

  private async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (cause) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw cause;
    } finally {
      client.release();
    }
  }

  async migrate(): Promise<void> {
    const sql = readFileSync(join(__dirname, "schema.sql"), "utf8");
    await this.tx(async (client) => {
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING",
        [SCHEMA_VERSION],
      );
    });
  }

  async createAdvertiser(input: { name: string; payer: string }): Promise<Advertiser> {
    const { rows } = await this.pool.query(
      "INSERT INTO advertisers (name, payer) VALUES ($1, $2) RETURNING id, name, payer, created_at",
      [input.name, input.payer.toLowerCase()],
    );
    const row = rows[0];
    return {
      id: String(row.id),
      name: String(row.name),
      payer: String(row.payer),
      createdAt: new Date(row.created_at).toISOString(),
    };
  }

  async getAdvertiser(id: string): Promise<Advertiser | null> {
    const { rows } = await this.pool.query(
      "SELECT id, name, payer, created_at FROM advertisers WHERE id = $1",
      [id],
    );
    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      id: String(row.id),
      name: String(row.name),
      payer: String(row.payer),
      createdAt: new Date(row.created_at).toISOString(),
    };
  }

  async createCampaign(input: {
    advertiserId: string;
    manifest: CampaignManifestV2;
  }): Promise<CampaignRecord> {
    const hash = revisionHash(input.manifest);
    return this.tx(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO campaigns (advertiser_id, state, revision_number, revision_hash, manifest, total_budget)
         VALUES ($1, 'DRAFT', 1, $2, $3, $4)
         RETURNING id, advertiser_id, state, revision_number, revision_hash, manifest, created_at, updated_at`,
        [input.advertiserId, hash, JSON.stringify(input.manifest), input.manifest.totalBudget],
      );
      await client.query(
        `INSERT INTO campaign_revisions (campaign_id, revision_number, revision_hash, manifest)
         VALUES ($1, 1, $2, $3)`,
        [rows[0].id, hash, JSON.stringify(input.manifest)],
      );
      return mapCampaign(rows[0]);
    });
  }

  async reviseCampaign(id: string, manifest: CampaignManifestV2): Promise<CampaignRecord> {
    const hash = revisionHash(manifest);
    return this.tx(async (client) => {
      const current = await client.query(
        "SELECT revision_number FROM campaigns WHERE id = $1 FOR UPDATE",
        [id],
      );
      if (current.rows.length === 0) throw new NotFoundError(`campaign ${id} does not exist`);
      const next = Number(current.rows[0].revision_number) + 1;

      const { rows } = await client.query(
        `UPDATE campaigns
            SET revision_number = $2, revision_hash = $3, manifest = $4,
                total_budget = $5, updated_at = now()
          WHERE id = $1
      RETURNING id, advertiser_id, state, revision_number, revision_hash, manifest, created_at, updated_at`,
        [id, next, hash, JSON.stringify(manifest), manifest.totalBudget],
      );
      await client.query(
        `INSERT INTO campaign_revisions (campaign_id, revision_number, revision_hash, manifest)
         VALUES ($1, $2, $3, $4)`,
        [id, next, hash, JSON.stringify(manifest)],
      );
      return mapCampaign(rows[0]);
    });
  }

  async setCampaignState(id: string, state: CampaignState): Promise<CampaignRecord> {
    const { rows } = await this.pool.query(
      `UPDATE campaigns SET state = $2, updated_at = now() WHERE id = $1
       RETURNING id, advertiser_id, state, revision_number, revision_hash, manifest, created_at, updated_at`,
      [id, state],
    );
    if (rows.length === 0) throw new NotFoundError(`campaign ${id} does not exist`);
    return mapCampaign(rows[0]);
  }

  async getCampaign(id: string): Promise<CampaignRecord | null> {
    const { rows } = await this.pool.query(
      `SELECT id, advertiser_id, state, revision_number, revision_hash, manifest, created_at, updated_at
         FROM campaigns WHERE id = $1`,
      [id],
    );
    return rows.length === 0 ? null : mapCampaign(rows[0]);
  }

  async listRevisions(id: string): Promise<CampaignRevision[]> {
    const { rows } = await this.pool.query(
      `SELECT revision_number, revision_hash, manifest, created_at
         FROM campaign_revisions WHERE campaign_id = $1 ORDER BY revision_number ASC`,
      [id],
    );
    return rows.map((row) => ({
      revisionNumber: Number(row.revision_number),
      revisionHash: String(row.revision_hash),
      manifest: parseManifest(row.manifest),
      createdAt: new Date(row.created_at).toISOString(),
    }));
  }

  async listApproved(): Promise<CampaignRecord[]> {
    const { rows } = await this.pool.query(
      `SELECT id, advertiser_id, state, revision_number, revision_hash, manifest, created_at, updated_at
         FROM campaigns WHERE state = 'APPROVED' ORDER BY created_at ASC`,
    );
    return rows.map(mapCampaign);
  }

  async reserve(input: ReserveInput): Promise<ReserveResult> {
    return this.tx(async (client) => {
      // Serialise every reservation for this campaign behind one lock. This is
      // the line that makes the budget check safe under concurrency.
      const campaign = await client.query("SELECT id FROM campaigns WHERE id = $1 FOR UPDATE", [
        input.campaignId,
      ]);
      if (campaign.rows.length === 0) {
        throw new NotFoundError(`campaign ${input.campaignId} does not exist`);
      }

      const existing = await client.query(
        "SELECT state FROM reservations WHERE reservation_key = $1",
        [input.reservationKey],
      );
      if (existing.rows.length > 0) {
        // Idempotent: a retried request is the same hold, not a second one.
        return { ok: true, reservationKey: input.reservationKey, alreadyHeld: true };
      }

      const held = await client.query(
        "SELECT COALESCE(SUM(amount), 0) AS total FROM reservations WHERE campaign_id = $1 AND state = 'ACTIVE'",
        [input.campaignId],
      );
      const committed =
        BigInt(input.settledSpend) + BigInt(String(held.rows[0].total)) + BigInt(input.amount);
      if (committed > BigInt(input.totalBudget)) {
        return { ok: false, reason: "BUDGET_EXHAUSTED" };
      }

      await client.query(
        "INSERT INTO reservations (reservation_key, campaign_id, amount, state) VALUES ($1, $2, $3, 'ACTIVE')",
        [input.reservationKey, input.campaignId, input.amount],
      );
      return { ok: true, reservationKey: input.reservationKey, alreadyHeld: false };
    });
  }

  async release(reservationKey: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      "UPDATE reservations SET state = 'RELEASED', released_at = now() WHERE reservation_key = $1 AND state = 'ACTIVE'",
      [reservationKey],
    );
    return (rowCount ?? 0) > 0;
  }

  async activeReserved(campaignId: string): Promise<string> {
    const { rows } = await this.pool.query(
      "SELECT COALESCE(SUM(amount), 0) AS total FROM reservations WHERE campaign_id = $1 AND state = 'ACTIVE'",
      [campaignId],
    );
    return String(rows[0].total);
  }

  async recordEvent(input: RecordEventInput): Promise<{ recorded: boolean }> {
    const { rowCount } = await this.pool.query(
      `INSERT INTO measurement_events (event_key, campaign_id, kind)
       VALUES ($1, $2, $3) ON CONFLICT (event_key) DO NOTHING`,
      [input.eventKey, input.campaignId, input.kind],
    );
    return { recorded: (rowCount ?? 0) > 0 };
  }

  async deliveryTotals(campaignId: string): Promise<DeliveryTotals> {
    const { rows } = await this.pool.query(
      `SELECT kind, COUNT(*)::int AS count FROM measurement_events
        WHERE campaign_id = $1 GROUP BY kind`,
      [campaignId],
    );
    const totals: DeliveryTotals = { impressions: 0, clicks: 0 };
    for (const row of rows) {
      if (row.kind === "IMPRESSION") totals.impressions = Number(row.count);
      if (row.kind === "CLICK") totals.clicks = Number(row.count);
    }
    return totals;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/**
 * Build the store, or refuse.
 *
 * No DATABASE_URL means no store - not a memory store, not a file. The V2 routes
 * surface that as a 503 so an operator sees a configuration problem rather than
 * a system that appears to work until it restarts.
 */
export function createPostgresStore(databaseUrl: string | undefined): PostgresStore {
  if (!databaseUrl) {
    throw new StorageUnavailableError(
      "DATABASE_URL is not set. Campaign services require PostgreSQL; there is no fallback store.",
    );
  }
  return new PostgresStore(new Pool({ connectionString: databaseUrl }));
}
