import { EnvelopeError, isSensitive, parseEnvelope, type ContextEnvelopeV2 } from "./envelope";
import type { NoAdReason } from "../reasons";

/**
 * Policy gate.
 *
 * Everything here fails closed. A classifier that is unreachable, a classifier
 * that returns nonsense, and an audience whose age is simply unknown all land
 * on the same outcome - no advertising - because the alternative in each case is
 * to serve an ad into a context nobody has vouched for.
 *
 * `UNKNOWN` deserves its own note: it is not a soft `ADULT`. Treating absence of
 * evidence as permission is exactly the failure this gate exists to prevent, so
 * it gets a distinct reason code and the same refusal as `UNDER_18`.
 */

export type PolicyDecision =
  | { allowed: true; envelope: ContextEnvelopeV2 }
  | { allowed: false; reason: NoAdReason };

/**
 * Run a proposed classification through validation and policy in one step.
 *
 * `proposed` is whatever the classifier produced. `available` is false when the
 * classifier could not be consulted at all, which is a different failure from
 * it answering badly and is reported as such.
 */
export function decideContext(
  proposed: unknown,
  options: { available?: boolean; now?: Date } = {},
): PolicyDecision {
  if (options.available === false) {
    return { allowed: false, reason: "CLASSIFICATION_UNAVAILABLE" };
  }
  if (proposed === undefined || proposed === null) {
    return { allowed: false, reason: "CLASSIFICATION_UNAVAILABLE" };
  }

  let envelope: ContextEnvelopeV2;
  try {
    envelope = parseEnvelope(proposed, options.now ?? new Date());
  } catch (cause) {
    if (cause instanceof EnvelopeError) return { allowed: false, reason: "CLASSIFICATION_INVALID" };
    throw cause;
  }

  if (envelope.adultState === "UNDER_18") return { allowed: false, reason: "AGE_UNDER_18" };
  if (envelope.adultState === "UNKNOWN") return { allowed: false, reason: "AGE_UNKNOWN" };
  if (isSensitive(envelope)) return { allowed: false, reason: "SENSITIVE_CONTEXT" };

  return { allowed: true, envelope };
}
