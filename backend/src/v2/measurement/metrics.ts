import type { DeliveryTotals } from "../store/store";

/**
 * Delivery reporting.
 *
 * Two rules shape this module.
 *
 * First, nothing is invented. Every figure is either a count of events this
 * application actually observed or arithmetic over those counts and settled
 * spend. Where there is no denominator the answer is `null`, not zero and not an
 * estimate - a campaign with no clicks has no cost per click, and printing 0.00
 * would read as "clicks are free" rather than "we have no clicks".
 *
 * Second, the source is labelled. V1 settlement is a fixed price per placement,
 * not CPC or CPM billing. Effective CPC and CPM are therefore derived
 * observations, useful for comparison but not what anyone was charged, and the
 * response says so rather than leaving a reader to assume.
 */

export interface DeliveryReport {
  campaignId: string;
  /** Sum of settled receipts for this campaign, minor units. From the Graph. */
  settledSpend: string;
  /** Counts this application observed. Not audited, not fraud-proof. */
  observed: DeliveryTotals;
  /** settledSpend / clicks, minor units, or null when there are no clicks. */
  effectiveCpc: string | null;
  /** settledSpend / impressions * 1000, or null when there are no impressions. */
  effectiveCpm: string | null;
  /** Machine-readable provenance for the two count fields. */
  measurementSource: "application-observed";
  /** Machine-readable provenance for the money field. */
  spendSource: "settled-onchain-receipts";
  note: string;
}

const NOTE =
  "Impression and click counts are observed by this application and are not audited. " +
  "Settlement is a fixed amount per placement; effective CPC and CPM are derived from " +
  "settled spend and observed events, and are not a billing basis.";

/** Integer division, floored. Money is never reported to fractional minor units. */
function divide(total: string, count: number): string | null {
  if (count <= 0) return null;
  return (BigInt(total) / BigInt(count)).toString();
}

export function buildDeliveryReport(input: {
  campaignId: string;
  settledSpend: string;
  observed: DeliveryTotals;
}): DeliveryReport {
  return {
    campaignId: input.campaignId,
    settledSpend: input.settledSpend,
    observed: input.observed,
    effectiveCpc: divide(input.settledSpend, input.observed.clicks),
    effectiveCpm:
      input.observed.impressions > 0
        ? ((BigInt(input.settledSpend) * 1000n) / BigInt(input.observed.impressions)).toString()
        : null,
    measurementSource: "application-observed",
    spendSource: "settled-onchain-receipts",
    note: NOTE,
  };
}
