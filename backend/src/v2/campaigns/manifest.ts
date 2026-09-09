import { id as keccakUtf8 } from "ethers";

/**
 * CampaignManifestV2 - what an advertiser is asking to run.
 *
 * A manifest is never edited in place. Every accepted change writes a new
 * revision with its own hash and leaves the previous ones intact, so "what were
 * we running on Tuesday" has an answer that cannot be rewritten after the fact.
 * For a product whose entire claim is that sponsorship is checkable, an
 * editable campaign record would be a hole straight through the middle of it.
 *
 * The hash covers the manifest only - not the id, state, or timestamps - so it
 * identifies *what was asked for*, and two advertisers requesting the same terms
 * produce the same revision hash. Approving or pausing a campaign therefore does
 * not change its revision hash, which is the point: state is mutable, terms are
 * not.
 */

export type CampaignState = "DRAFT" | "APPROVED" | "PAUSED";

export interface CampaignManifestV2 {
  schemaVersion: 2;
  name: string;
  productRef: string;
  recommendationText: string;
  /** Topics this campaign wants. Private: never returned outside the owner. */
  targetTopics: string[];
  /** Topics this campaign refuses. Private, same reason. */
  blockedTopics: string[];
  /** Per-placement bid, integer minor units of the settlement asset. */
  bidAmount: string;
  /** Application-level cap across the campaign, same units. */
  totalBudget: string;
}

export interface CampaignRecord {
  id: string;
  advertiserId: string;
  state: CampaignState;
  revisionNumber: number;
  revisionHash: string;
  manifest: CampaignManifestV2;
  createdAt: string;
  updatedAt: string;
}

/** What a publisher or the frontend is allowed to see about a selected ad. */
export interface PublicPlacement {
  campaignId: string;
  revisionHash: string;
  productRef: string;
  recommendationText: string;
  amount: string;
}

export class ManifestError extends Error {}

const SLUG = /^[a-z0-9][a-z0-9_]{0,62}$/;
const UINT = /^(0|[1-9][0-9]{0,29})$/;
const MAX_TOPICS = 16;

function str(raw: Record<string, unknown>, field: string, min: number, max: number): string {
  const value = raw[field];
  if (typeof value !== "string") throw new ManifestError(`${field} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) {
    throw new ManifestError(`${field} must be ${min}-${max} characters`);
  }
  return trimmed;
}

function topics(raw: Record<string, unknown>, field: string, required: boolean): string[] {
  const value = raw[field] ?? [];
  if (!Array.isArray(value)) throw new ManifestError(`${field} must be an array`);
  if (value.length > MAX_TOPICS)
    throw new ManifestError(`${field} has more than ${MAX_TOPICS} entries`);
  for (const entry of value) {
    if (typeof entry !== "string" || !SLUG.test(entry)) {
      throw new ManifestError(`${field} contains a value that is not a slug`);
    }
  }
  // Sorted and de-duplicated so the revision hash is canonical: the same set of
  // topics in a different order is the same campaign and must hash alike.
  const unique = [...new Set(value as string[])].sort();
  if (required && unique.length === 0) throw new ManifestError(`${field} must not be empty`);
  return unique;
}

function amount(raw: Record<string, unknown>, field: string): string {
  const value = raw[field];
  if (typeof value !== "string" || !UINT.test(value)) {
    throw new ManifestError(`${field} must be an integer string in minor units`);
  }
  return value;
}

export function parseManifest(value: unknown): CampaignManifestV2 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ManifestError("manifest must be an object");
  }
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== 2) throw new ManifestError("schemaVersion must be 2");

  const manifest: CampaignManifestV2 = {
    schemaVersion: 2,
    name: str(raw, "name", 1, 120),
    productRef: str(raw, "productRef", 1, 120),
    recommendationText: str(raw, "recommendationText", 1, 1000),
    targetTopics: topics(raw, "targetTopics", true),
    blockedTopics: topics(raw, "blockedTopics", false),
    bidAmount: amount(raw, "bidAmount"),
    totalBudget: amount(raw, "totalBudget"),
  };

  if (BigInt(manifest.bidAmount) <= 0n)
    throw new ManifestError("bidAmount must be greater than zero");
  if (BigInt(manifest.totalBudget) <= 0n)
    throw new ManifestError("totalBudget must be greater than zero");
  if (BigInt(manifest.bidAmount) > BigInt(manifest.totalBudget)) {
    throw new ManifestError("bidAmount must not exceed totalBudget");
  }
  const overlap = manifest.targetTopics.filter((t) => manifest.blockedTopics.includes(t));
  if (overlap.length > 0) {
    throw new ManifestError("a topic cannot be both targeted and blocked");
  }
  return manifest;
}

/**
 * Canonical JSON: keys in a fixed order, arrays already sorted by parseManifest.
 * JSON.stringify key order follows insertion order, so listing the fields
 * explicitly here is what makes the encoding stable rather than incidental.
 */
export function canonicalise(manifest: CampaignManifestV2): string {
  return JSON.stringify([
    manifest.schemaVersion,
    manifest.name,
    manifest.productRef,
    manifest.recommendationText,
    manifest.targetTopics,
    manifest.blockedTopics,
    manifest.bidAmount,
    manifest.totalBudget,
  ]);
}

export function revisionHash(manifest: CampaignManifestV2): string {
  return keccakUtf8(canonicalise(manifest));
}

/**
 * Strip everything an advertiser is entitled to keep private. Targeting rules
 * and budgets are commercially sensitive and are never part of a placement
 * response or a decision trace shown outside the owning advertiser.
 */
export function toPublicPlacement(campaign: CampaignRecord, amountPaid: string): PublicPlacement {
  return {
    campaignId: campaign.id,
    revisionHash: campaign.revisionHash,
    productRef: campaign.manifest.productRef,
    recommendationText: campaign.manifest.recommendationText,
    amount: amountPaid,
  };
}
