/**
 * ContextEnvelopeV2 - the sanitised description of a query that the rest of the
 * system is allowed to see.
 *
 * A model may propose this envelope. Nothing downstream trusts it until it has
 * been through `parseEnvelope`, because a classifier is an untrusted input like
 * any other: it can return the wrong shape, extra fields, or values outside the
 * allowed set, and every one of those has to be a hard failure rather than a
 * default.
 *
 * The envelope deliberately has no field for the query itself. That is the
 * privacy boundary of this design: the classifier is the only component that
 * ever sees the raw text, and what leaves it is a set of topic slugs and
 * categories. Advertisers, measurement records, logs and the chain therefore
 * cannot contain the query, because it never travels past this type.
 */

export type AdultState = "ADULT" | "UNDER_18" | "UNKNOWN";

const ADULT_STATES: readonly AdultState[] = ["ADULT", "UNDER_18", "UNKNOWN"];

/**
 * Categories that suppress advertising outright. The starting list is the one
 * named in the issue; it is a floor, not a ceiling.
 */
export const SENSITIVE_CATEGORIES = [
  "health",
  "mental_health",
  "self_harm",
  "politics",
  "sexual_content",
  "gambling",
  "weapons",
  "drugs_alcohol",
  "dangerous_or_illegal",
] as const;

export type SensitiveCategory = (typeof SENSITIVE_CATEGORIES)[number];

export interface ContextEnvelopeV2 {
  schemaVersion: 2;
  /** Coarse subject slugs used for matching. Never free text from the query. */
  topics: string[];
  /** Classifier categories, including sensitive ones so policy can act on them. */
  categories: string[];
  adultState: AdultState;
  /** Classifier self-reported confidence, 0..1 inclusive. */
  confidence: number;
  /** ISO-8601, set by the server rather than the model. */
  classifiedAt: string;
}

/** A slug: lowercase, digits, underscore. Anything else is a rejected shape. */
const SLUG = /^[a-z0-9][a-z0-9_]{0,62}$/;

const MAX_TOPICS = 16;
const MAX_CATEGORIES = 16;

export class EnvelopeError extends Error {}

function slugList(value: unknown, field: string, max: number): string[] {
  if (!Array.isArray(value)) throw new EnvelopeError(`${field} must be an array`);
  if (value.length > max) throw new EnvelopeError(`${field} has more than ${max} entries`);
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !SLUG.test(entry)) {
      throw new EnvelopeError(`${field} contains a value that is not a slug`);
    }
    // Duplicates are dropped rather than rejected: a classifier repeating itself
    // is noise, not a policy problem, and de-duplicating keeps matching honest.
    if (!out.includes(entry)) out.push(entry);
  }
  return out;
}

/**
 * Validate a proposed envelope.
 *
 * `classifiedAt` is taken from the caller-supplied clock rather than from the
 * model, so a classifier cannot backdate or future-date a decision.
 */
export function parseEnvelope(value: unknown, now: Date = new Date()): ContextEnvelopeV2 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new EnvelopeError("envelope must be an object");
  }
  const raw = value as Record<string, unknown>;

  if (raw.schemaVersion !== 2) throw new EnvelopeError("schemaVersion must be 2");

  // A raw query reaching this point means a caller tried to smuggle one through.
  // Reject rather than strip, so the mistake is visible where it was made.
  for (const forbidden of ["query", "rawQuery", "text", "prompt", "queryHash", "rawQueryHash"]) {
    if (forbidden in raw) {
      throw new EnvelopeError(`envelope must not carry "${forbidden}"`);
    }
  }

  const adultState = raw.adultState;
  if (typeof adultState !== "string" || !ADULT_STATES.includes(adultState as AdultState)) {
    throw new EnvelopeError("adultState must be ADULT, UNDER_18 or UNKNOWN");
  }

  const confidence = raw.confidence;
  if (
    typeof confidence !== "number" ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  ) {
    throw new EnvelopeError("confidence must be a number between 0 and 1");
  }

  return {
    schemaVersion: 2,
    topics: slugList(raw.topics, "topics", MAX_TOPICS),
    categories: slugList(raw.categories, "categories", MAX_CATEGORIES),
    adultState: adultState as AdultState,
    confidence,
    classifiedAt: now.toISOString(),
  };
}

/** The sensitive categories present in an envelope, in declaration order. */
export function sensitiveHits(envelope: ContextEnvelopeV2): SensitiveCategory[] {
  return SENSITIVE_CATEGORIES.filter(
    (category) => envelope.categories.includes(category) || envelope.topics.includes(category),
  );
}

export function isSensitive(envelope: ContextEnvelopeV2): boolean {
  return sensitiveHits(envelope).length > 0;
}
