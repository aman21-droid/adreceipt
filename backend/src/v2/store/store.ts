import type { CampaignManifestV2, CampaignRecord, CampaignState } from "../campaigns/manifest";

/**
 * The persistence port.
 *
 * Every mutable fact in V2 lives behind this interface so the services can be
 * tested without a database, while production has exactly one implementation:
 * PostgreSQL. There is deliberately no in-memory or JSON implementation wired
 * into the server. If the database is unavailable the API fails with a clear
 * error, because a campaign system that silently keeps running on memory would
 * lose spend authorisation state on restart and over-deliver.
 */

export interface Advertiser {
  id: string;
  name: string;
  /** Payer address used for settlement. Lowercased on write. */
  payer: string;
  createdAt: string;
}

export interface CampaignRevision {
  revisionNumber: number;
  revisionHash: string;
  manifest: CampaignManifestV2;
  createdAt: string;
}

export type EventKind = "IMPRESSION" | "CLICK";

export interface DeliveryTotals {
  impressions: number;
  clicks: number;
}

export type ReserveResult =
  | { ok: true; reservationKey: string; alreadyHeld: boolean }
  | { ok: false; reason: "BUDGET_EXHAUSTED" };

export interface ReserveInput {
  /** Idempotency key. A repeat with the same key is not a second reservation. */
  reservationKey: string;
  campaignId: string;
  amount: string;
  /**
   * Read outside the transaction, from the Graph, and passed in. Settled spend
   * is not ours to hold: the chain owns it, and caching it here would let this
   * table drift from the only record that actually decides what was paid.
   */
  settledSpend: string;
  totalBudget: string;
}

export interface RecordEventInput {
  /** Idempotency key: the same impression reported twice records once. */
  eventKey: string;
  campaignId: string;
  kind: EventKind;
}

export interface Store {
  createAdvertiser(input: { name: string; payer: string }): Promise<Advertiser>;
  getAdvertiser(id: string): Promise<Advertiser | null>;

  createCampaign(input: {
    advertiserId: string;
    manifest: CampaignManifestV2;
  }): Promise<CampaignRecord>;
  /** Appends a revision. Returns the campaign at its new revision. */
  reviseCampaign(id: string, manifest: CampaignManifestV2): Promise<CampaignRecord>;
  setCampaignState(id: string, state: CampaignState): Promise<CampaignRecord>;
  getCampaign(id: string): Promise<CampaignRecord | null>;
  listRevisions(id: string): Promise<CampaignRevision[]>;
  listApproved(): Promise<CampaignRecord[]>;

  /** Atomic: budget is re-checked under a lock inside the same transaction. */
  reserve(input: ReserveInput): Promise<ReserveResult>;
  release(reservationKey: string): Promise<boolean>;
  activeReserved(campaignId: string): Promise<string>;

  recordEvent(input: RecordEventInput): Promise<{ recorded: boolean }>;
  deliveryTotals(campaignId: string): Promise<DeliveryTotals>;

  close(): Promise<void>;
}

export class StorageUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageUnavailableError";
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}
