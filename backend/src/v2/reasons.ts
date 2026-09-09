/**
 * Stable reason codes for every no-ad decision.
 *
 * These are part of the API contract, not log strings. A caller has to be able
 * to branch on why no advertising was served, and an operator has to be able to
 * tell "we had no campaign for this" apart from "we could not read spend" -
 * those look identical from the outside and mean very different things.
 *
 * Codes are added, never renamed or repurposed.
 */
export type NoAdReason =
  /** The classifier could not be reached, or returned nothing. Fail closed. */
  | "CLASSIFICATION_UNAVAILABLE"
  /** The classifier answered, but the answer failed runtime validation. */
  | "CLASSIFICATION_INVALID"
  /** Adult state is UNKNOWN. Not ad-eligible; absence of proof is not proof. */
  | "AGE_UNKNOWN"
  /** Adult state is UNDER_18. Not ad-eligible. */
  | "AGE_UNDER_18"
  /** The context matched a blocked sensitive category. */
  | "SENSITIVE_CONTEXT"
  /** Policy passed, but no campaign was eligible at all. */
  | "NO_ELIGIBLE_CAMPAIGN"
  /** Campaigns were eligible but none reached the configured relevance floor. */
  | "BELOW_RELEVANCE_FLOOR"
  /** Settled spend could not be read, so remaining budget is unknown. */
  | "BUDGET_UNAVAILABLE"
  /** Remaining budget could not cover the proposed amount. */
  | "BUDGET_EXHAUSTED";

/**
 * Operator-facing text. Deliberately says nothing about the user's query, the
 * advertiser's private targeting, or the classifier's internals - these strings
 * are safe to return to any caller.
 */
export const REASON_TEXT: Record<NoAdReason, string> = {
  CLASSIFICATION_UNAVAILABLE: "Context classification was unavailable.",
  CLASSIFICATION_INVALID: "Context classification failed validation.",
  AGE_UNKNOWN: "Adult state is unknown.",
  AGE_UNDER_18: "Audience is not adult.",
  SENSITIVE_CONTEXT: "Context is in a blocked category.",
  NO_ELIGIBLE_CAMPAIGN: "No campaign was eligible.",
  BELOW_RELEVANCE_FLOOR: "No eligible campaign met the relevance floor.",
  BUDGET_UNAVAILABLE: "Settled spend could not be read.",
  BUDGET_EXHAUSTED: "Remaining budget is insufficient.",
};
