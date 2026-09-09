import { decideContext } from "./context/policy";
import {
  parseManifest,
  toPublicPlacement,
  type CampaignRecord,
  type PublicPlacement,
} from "./campaigns/manifest";
import { selectCampaign, type TraceEntry } from "./matching/select";
import { buildDeliveryReport, type DeliveryReport } from "./measurement/metrics";
import type { SpendReader } from "./budget/spend";
import { NotFoundError, type EventKind, type Store } from "./store/store";
import type { NoAdReason } from "./reasons";

/**
 * Orchestration for the campaign services.
 *
 * A model may propose a campaign draft or a context envelope; from the moment
 * either arrives, deterministic code owns the outcome. Validation, policy,
 * matching, budget authorisation and every state change happen here, against
 * types the model cannot widen. That division is what keeps the system
 * predictable: the model contributes language, not permission.
 */

export interface ServiceDeps {
  store: Store;
  spend: SpendReader;
  /** Minimum relevance an eligible campaign must reach before bids are compared. */
  relevanceFloor: number;
  now?: () => Date;
}

export type PlacementDecision =
  | { adServed: true; placement: PublicPlacement; relevance: number; trace: TraceEntry[] }
  | { adServed: false; reason: NoAdReason; trace: TraceEntry[] };

export type ReservationOutcome =
  | { ok: true; reservationKey: string; alreadyHeld: boolean }
  | { ok: false; reason: Extract<NoAdReason, "BUDGET_EXHAUSTED" | "BUDGET_UNAVAILABLE"> };

export class CampaignService {
  constructor(private readonly deps: ServiceDeps) {}

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  // -- campaigns ----------------------------------------------------------

  async createDraft(advertiserId: string, manifestInput: unknown): Promise<CampaignRecord> {
    const advertiser = await this.deps.store.getAdvertiser(advertiserId);
    if (!advertiser) throw new NotFoundError(`advertiser ${advertiserId} does not exist`);
    return this.deps.store.createCampaign({
      advertiserId,
      manifest: parseManifest(manifestInput),
    });
  }

  async revise(campaignId: string, manifestInput: unknown): Promise<CampaignRecord> {
    const manifest = parseManifest(manifestInput);
    const existing = await this.deps.store.getCampaign(campaignId);
    if (!existing) throw new NotFoundError(`campaign ${campaignId} does not exist`);
    return this.deps.store.reviseCampaign(campaignId, manifest);
  }

  /**
   * Launch requires this call. A campaign never becomes deliverable as a side
   * effect of being created or edited - approval is its own explicit act, so
   * "who turned this on" always has an answer.
   */
  async approve(campaignId: string): Promise<CampaignRecord> {
    return this.deps.store.setCampaignState(campaignId, "APPROVED");
  }

  async pause(campaignId: string): Promise<CampaignRecord> {
    return this.deps.store.setCampaignState(campaignId, "PAUSED");
  }

  async get(campaignId: string): Promise<CampaignRecord | null> {
    return this.deps.store.getCampaign(campaignId);
  }

  async revisions(campaignId: string) {
    return this.deps.store.listRevisions(campaignId);
  }

  // -- eligibility --------------------------------------------------------

  /**
   * Classify, apply policy, then match. Any refusal short-circuits with a stable
   * reason code and an empty trace: if policy said no, no campaign was ever
   * considered, and a trace listing candidates would misrepresent that.
   */
  async findPlacement(input: {
    proposedEnvelope: unknown;
    classificationAvailable?: boolean;
  }): Promise<PlacementDecision> {
    const decision = decideContext(input.proposedEnvelope, {
      available: input.classificationAvailable,
      now: this.now(),
    });
    if (!decision.allowed) return { adServed: false, reason: decision.reason, trace: [] };

    const approved = await this.deps.store.listApproved();
    const selection = selectCampaign(approved, decision.envelope, this.deps.relevanceFloor);

    if (!selection.selected) {
      return {
        adServed: false,
        reason: selection.reason ?? "NO_ELIGIBLE_CAMPAIGN",
        trace: selection.trace,
      };
    }
    return {
      adServed: true,
      placement: toPublicPlacement(selection.selected, selection.selected.manifest.bidAmount),
      relevance: selection.relevance ?? 0,
      trace: selection.trace,
    };
  }

  // -- budget -------------------------------------------------------------

  /**
   * Authorise and hold part of a campaign budget.
   *
   * Settled spend is read from the Graph on every attempt rather than cached. If
   * that read fails the answer is BUDGET_UNAVAILABLE and nothing is held: an
   * unknown spend figure cannot be treated as a small one.
   */
  async reserve(input: {
    reservationKey: string;
    campaignId: string;
    amount: string;
  }): Promise<ReservationOutcome> {
    const campaign = await this.deps.store.getCampaign(input.campaignId);
    if (!campaign) throw new NotFoundError(`campaign ${input.campaignId} does not exist`);

    let settled: string;
    try {
      settled = (await this.deps.spend.settledSpend(input.campaignId)).settled;
    } catch {
      return { ok: false, reason: "BUDGET_UNAVAILABLE" };
    }

    const result = await this.deps.store.reserve({
      reservationKey: input.reservationKey,
      campaignId: input.campaignId,
      amount: input.amount,
      settledSpend: settled,
      totalBudget: campaign.manifest.totalBudget,
    });
    return result.ok
      ? { ok: true, reservationKey: result.reservationKey, alreadyHeld: result.alreadyHeld }
      : { ok: false, reason: "BUDGET_EXHAUSTED" };
  }

  async release(reservationKey: string): Promise<boolean> {
    return this.deps.store.release(reservationKey);
  }

  // -- measurement --------------------------------------------------------

  async recordEvent(input: {
    eventKey: string;
    campaignId: string;
    kind: EventKind;
  }): Promise<{ recorded: boolean }> {
    const campaign = await this.deps.store.getCampaign(input.campaignId);
    if (!campaign) throw new NotFoundError(`campaign ${input.campaignId} does not exist`);
    return this.deps.store.recordEvent(input);
  }

  /**
   * Delivery report. Spend comes from the chain, counts from this application,
   * and the two are labelled separately because they are not equally trustworthy.
   */
  async report(campaignId: string): Promise<DeliveryReport> {
    const campaign = await this.deps.store.getCampaign(campaignId);
    if (!campaign) throw new NotFoundError(`campaign ${campaignId} does not exist`);

    const observed = await this.deps.store.deliveryTotals(campaignId);
    const settled = (await this.deps.spend.settledSpend(campaignId)).settled;
    return buildDeliveryReport({ campaignId, settledSpend: settled, observed });
  }
}
