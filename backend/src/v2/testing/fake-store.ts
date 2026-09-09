import { randomUUID } from "crypto";
import {
  revisionHash,
  type CampaignManifestV2,
  type CampaignRecord,
  type CampaignState,
} from "../campaigns/manifest";
import {
  NotFoundError,
  type Advertiser,
  type CampaignRevision,
  type DeliveryTotals,
  type RecordEventInput,
  type ReserveInput,
  type ReserveResult,
  type Store,
} from "../store/store";

/**
 * A Store for tests.
 *
 * This exists so the services can be tested without PostgreSQL; it is never
 * wired into the server, which has exactly one store. Its job is to model the
 * *contract* the real store promises, not to be a second implementation of the
 * product.
 *
 * The part worth reading is the mutex in `reserve`. PostgreSQL serialises
 * concurrent reservations with `SELECT ... FOR UPDATE`; this mirrors that by
 * chaining per-campaign promises, so a test can prove the service delegates
 * atomicity correctly rather than re-checking the budget itself. Whether the
 * real SQL holds is a different question, answered by the integration test that
 * runs only when DATABASE_URL is set.
 */
export class FakeStore implements Store {
  private advertisers = new Map<string, Advertiser>();
  private campaigns = new Map<string, CampaignRecord>();
  private revisions = new Map<string, CampaignRevision[]>();
  private reservations = new Map<string, { campaignId: string; amount: string; active: boolean }>();
  private events = new Map<string, { campaignId: string; kind: string }>();
  private locks = new Map<string, Promise<unknown>>();

  /** Set by tests to make a reservation attempt yield mid-transaction. */
  reserveDelay = 0;

  async createAdvertiser(input: { name: string; payer: string }): Promise<Advertiser> {
    const advertiser: Advertiser = {
      id: randomUUID(),
      name: input.name,
      payer: input.payer.toLowerCase(),
      createdAt: new Date().toISOString(),
    };
    this.advertisers.set(advertiser.id, advertiser);
    return advertiser;
  }

  async getAdvertiser(id: string): Promise<Advertiser | null> {
    return this.advertisers.get(id) ?? null;
  }

  async createCampaign(input: {
    advertiserId: string;
    manifest: CampaignManifestV2;
  }): Promise<CampaignRecord> {
    const now = new Date().toISOString();
    const campaign: CampaignRecord = {
      id: randomUUID(),
      advertiserId: input.advertiserId,
      state: "DRAFT",
      revisionNumber: 1,
      revisionHash: revisionHash(input.manifest),
      manifest: input.manifest,
      createdAt: now,
      updatedAt: now,
    };
    this.campaigns.set(campaign.id, campaign);
    this.revisions.set(campaign.id, [
      {
        revisionNumber: 1,
        revisionHash: campaign.revisionHash,
        manifest: input.manifest,
        createdAt: now,
      },
    ]);
    return campaign;
  }

  async reviseCampaign(id: string, manifest: CampaignManifestV2): Promise<CampaignRecord> {
    const existing = this.campaigns.get(id);
    if (!existing) throw new NotFoundError(`campaign ${id} does not exist`);
    const next: CampaignRecord = {
      ...existing,
      revisionNumber: existing.revisionNumber + 1,
      revisionHash: revisionHash(manifest),
      manifest,
      updatedAt: new Date().toISOString(),
    };
    this.campaigns.set(id, next);
    const history = this.revisions.get(id) ?? [];
    history.push({
      revisionNumber: next.revisionNumber,
      revisionHash: next.revisionHash,
      manifest,
      createdAt: next.updatedAt,
    });
    this.revisions.set(id, history);
    return next;
  }

  async setCampaignState(id: string, state: CampaignState): Promise<CampaignRecord> {
    const existing = this.campaigns.get(id);
    if (!existing) throw new NotFoundError(`campaign ${id} does not exist`);
    const next = { ...existing, state, updatedAt: new Date().toISOString() };
    this.campaigns.set(id, next);
    return next;
  }

  async getCampaign(id: string): Promise<CampaignRecord | null> {
    return this.campaigns.get(id) ?? null;
  }

  async listRevisions(id: string): Promise<CampaignRevision[]> {
    return [...(this.revisions.get(id) ?? [])];
  }

  async listApproved(): Promise<CampaignRecord[]> {
    return [...this.campaigns.values()].filter((campaign) => campaign.state === "APPROVED");
  }

  async reserve(input: ReserveInput): Promise<ReserveResult> {
    // Queue behind any in-flight reservation for the same campaign, the way the
    // row lock does.
    const previous = this.locks.get(input.campaignId) ?? Promise.resolve();
    let unlock: () => void = () => undefined;
    this.locks.set(
      input.campaignId,
      new Promise<void>((resolve) => {
        unlock = resolve;
      }),
    );
    await previous;

    try {
      if (!this.campaigns.has(input.campaignId)) {
        throw new NotFoundError(`campaign ${input.campaignId} does not exist`);
      }
      if (this.reservations.has(input.reservationKey)) {
        return { ok: true, reservationKey: input.reservationKey, alreadyHeld: true };
      }
      // Yield inside the critical section. Anything that re-read state after
      // this point without the lock would interleave and over-reserve.
      if (this.reserveDelay > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.reserveDelay));
      }

      const held = [...this.reservations.values()]
        .filter((row) => row.campaignId === input.campaignId && row.active)
        .reduce((total, row) => total + BigInt(row.amount), 0n);

      if (BigInt(input.settledSpend) + held + BigInt(input.amount) > BigInt(input.totalBudget)) {
        return { ok: false, reason: "BUDGET_EXHAUSTED" };
      }
      this.reservations.set(input.reservationKey, {
        campaignId: input.campaignId,
        amount: input.amount,
        active: true,
      });
      return { ok: true, reservationKey: input.reservationKey, alreadyHeld: false };
    } finally {
      unlock();
    }
  }

  async release(reservationKey: string): Promise<boolean> {
    const row = this.reservations.get(reservationKey);
    if (!row?.active) return false;
    row.active = false;
    return true;
  }

  async activeReserved(campaignId: string): Promise<string> {
    return [...this.reservations.values()]
      .filter((row) => row.campaignId === campaignId && row.active)
      .reduce((total, row) => total + BigInt(row.amount), 0n)
      .toString();
  }

  async recordEvent(input: RecordEventInput): Promise<{ recorded: boolean }> {
    if (this.events.has(input.eventKey)) return { recorded: false };
    this.events.set(input.eventKey, { campaignId: input.campaignId, kind: input.kind });
    return { recorded: true };
  }

  async deliveryTotals(campaignId: string): Promise<DeliveryTotals> {
    const rows = [...this.events.values()].filter((row) => row.campaignId === campaignId);
    return {
      impressions: rows.filter((row) => row.kind === "IMPRESSION").length,
      clicks: rows.filter((row) => row.kind === "CLICK").length,
    };
  }

  async close(): Promise<void> {}
}

export function manifestFixture(overrides: Partial<CampaignManifestV2> = {}): CampaignManifestV2 {
  return {
    schemaVersion: 2,
    name: "DeployCo hosting",
    productRef: "deployco-managed-hosting",
    recommendationText: "DeployCo runs managed Node hosting with zero-config deploys.",
    targetTopics: ["backend_hosting"],
    blockedTopics: [],
    bidAmount: "1000",
    totalBudget: "10000",
    ...overrides,
  };
}

export function envelopeFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 2,
    topics: ["backend_hosting"],
    categories: ["software"],
    adultState: "ADULT",
    confidence: 0.9,
    ...overrides,
  };
}
