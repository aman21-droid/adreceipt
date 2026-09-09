import type { ContextEnvelopeV2 } from "../context/envelope";
import type { CampaignRecord } from "../campaigns/manifest";
import type { NoAdReason } from "../reasons";

/**
 * Eligibility-first campaign selection.
 *
 * The ordering of the two phases is the whole design. Every campaign is first
 * judged on whether it may run at all - approved, not blocked by the context,
 * relevant enough - and only the survivors are ranked by bid. Money therefore
 * decides between campaigns that were already appropriate; it never promotes one
 * that was not. A ranking that mixed bid into the eligibility score would let a
 * large enough bid buy its way past the relevance floor, which is the failure
 * mode this exists to prevent.
 *
 * The trace explains the decision without exposing anyone's targeting rules.
 * Each entry says whether a campaign survived and, if not, which gate stopped
 * it - never which topics it was targeting or refusing.
 */

export type TraceCode = "ELIGIBLE" | "NOT_APPROVED" | "BLOCKED_BY_CONTEXT" | "BELOW_FLOOR";

export interface TraceEntry {
  campaignId: string;
  code: TraceCode;
  /** 0..1, rounded to three places so the trace is stable to compare. */
  relevance: number;
}

export interface Selection {
  selected?: CampaignRecord;
  relevance?: number;
  trace: TraceEntry[];
  reason?: NoAdReason;
}

/**
 * Share of the campaign's targeted topics present in the context.
 *
 * Denominated by what the campaign asked for rather than by what the context
 * contains, so a broad context does not dilute a precisely targeted campaign.
 */
export function relevanceOf(campaign: CampaignRecord, envelope: ContextEnvelopeV2): number {
  const targets = campaign.manifest.targetTopics;
  if (targets.length === 0) return 0;
  const context = new Set([...envelope.topics, ...envelope.categories]);
  const matched = targets.filter((topic) => context.has(topic)).length;
  return Math.round((matched / targets.length) * 1000) / 1000;
}

function blocked(campaign: CampaignRecord, envelope: ContextEnvelopeV2): boolean {
  const context = new Set([...envelope.topics, ...envelope.categories]);
  return campaign.manifest.blockedTopics.some((topic) => context.has(topic));
}

export function selectCampaign(
  campaigns: CampaignRecord[],
  envelope: ContextEnvelopeV2,
  relevanceFloor: number,
): Selection {
  const trace: TraceEntry[] = [];
  const eligible: { campaign: CampaignRecord; relevance: number }[] = [];

  for (const campaign of campaigns) {
    const relevance = relevanceOf(campaign, envelope);

    if (campaign.state !== "APPROVED") {
      trace.push({ campaignId: campaign.id, code: "NOT_APPROVED", relevance });
      continue;
    }
    if (blocked(campaign, envelope)) {
      trace.push({ campaignId: campaign.id, code: "BLOCKED_BY_CONTEXT", relevance });
      continue;
    }
    if (relevance < relevanceFloor) {
      trace.push({ campaignId: campaign.id, code: "BELOW_FLOOR", relevance });
      continue;
    }
    trace.push({ campaignId: campaign.id, code: "ELIGIBLE", relevance });
    eligible.push({ campaign, relevance });
  }

  if (eligible.length === 0) {
    // Distinguish "nothing could ever have run" from "things ran but none were
    // relevant enough" - they call for different action by an operator.
    const anyApproved = trace.some((entry) => entry.code !== "NOT_APPROVED");
    const onlyFloor = trace.some((entry) => entry.code === "BELOW_FLOOR");
    return {
      trace,
      reason: onlyFloor && anyApproved ? "BELOW_RELEVANCE_FLOOR" : "NO_ELIGIBLE_CAMPAIGN",
    };
  }

  // Bid decides, but only here. Ties break on revision hash so the same inputs
  // always produce the same winner rather than depending on row order.
  eligible.sort((a, b) => {
    const bid = BigInt(b.campaign.manifest.bidAmount) - BigInt(a.campaign.manifest.bidAmount);
    if (bid !== 0n) return bid > 0n ? 1 : -1;
    return a.campaign.revisionHash.localeCompare(b.campaign.revisionHash);
  });

  return { selected: eligible[0].campaign, relevance: eligible[0].relevance, trace };
}
