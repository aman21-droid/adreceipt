import assert from "node:assert/strict";
import test from "node:test";
import { parseEnvelope, sensitiveHits, EnvelopeError } from "./envelope";
import { decideContext } from "./policy";
import { envelopeFixture } from "../testing/fake-store";

test("a valid envelope is accepted and normalised", () => {
  const envelope = parseEnvelope(
    envelopeFixture({ topics: ["backend_hosting", "backend_hosting", "devops"] }),
    new Date("2026-01-01T00:00:00.000Z"),
  );
  assert.deepEqual(envelope.topics, ["backend_hosting", "devops"]);
  assert.equal(envelope.classifiedAt, "2026-01-01T00:00:00.000Z");
});

test("the server clock sets classifiedAt, not the classifier", () => {
  const envelope = parseEnvelope(
    envelopeFixture({ classifiedAt: "1999-01-01T00:00:00.000Z" }),
    new Date("2026-05-05T10:00:00.000Z"),
  );
  assert.equal(envelope.classifiedAt, "2026-05-05T10:00:00.000Z");
});

test("an envelope carrying the raw query is rejected outright", () => {
  for (const field of ["query", "rawQuery", "text", "prompt", "queryHash", "rawQueryHash"]) {
    assert.throws(
      () => parseEnvelope(envelopeFixture({ [field]: "how do I treat my anxiety" })),
      EnvelopeError,
      `${field} should be rejected`,
    );
  }
});

test("malformed classifier output is rejected rather than defaulted", () => {
  const cases: unknown[] = [
    null,
    "not an object",
    envelopeFixture({ schemaVersion: 1 }),
    envelopeFixture({ adultState: "PROBABLY" }),
    envelopeFixture({ confidence: 1.5 }),
    envelopeFixture({ confidence: "high" }),
    envelopeFixture({ topics: "backend_hosting" }),
    envelopeFixture({ topics: ["Backend Hosting"] }),
    envelopeFixture({ topics: Array.from({ length: 17 }, (_, i) => `t${i}`) }),
  ];
  for (const value of cases) {
    assert.throws(() => parseEnvelope(value), EnvelopeError);
  }
});

test("sensitive categories are detected in topics or categories", () => {
  assert.deepEqual(sensitiveHits(parseEnvelope(envelopeFixture({ categories: ["self_harm"] }))), [
    "self_harm",
  ]);
  assert.deepEqual(
    sensitiveHits(parseEnvelope(envelopeFixture({ topics: ["politics"], categories: [] }))),
    ["politics"],
  );
  assert.deepEqual(sensitiveHits(parseEnvelope(envelopeFixture())), []);
});

test("every blocked category from the policy suppresses advertising", () => {
  const blocked = [
    "health",
    "mental_health",
    "self_harm",
    "politics",
    "sexual_content",
    "gambling",
    "weapons",
    "drugs_alcohol",
    "dangerous_or_illegal",
  ];
  for (const category of blocked) {
    const decision = decideContext(envelopeFixture({ categories: [category] }));
    assert.equal(decision.allowed, false, `${category} should be blocked`);
    assert.equal(decision.allowed === false && decision.reason, "SENSITIVE_CONTEXT");
  }
});

test("unknown age is not treated as adult", () => {
  const decision = decideContext(envelopeFixture({ adultState: "UNKNOWN" }));
  assert.equal(decision.allowed, false);
  assert.equal(decision.allowed === false && decision.reason, "AGE_UNKNOWN");
});

test("under 18 is refused with its own reason", () => {
  const decision = decideContext(envelopeFixture({ adultState: "UNDER_18" }));
  assert.equal(decision.allowed, false);
  assert.equal(decision.allowed === false && decision.reason, "AGE_UNDER_18");
});

test("unavailable and invalid classification are distinct refusals", () => {
  const unavailable = decideContext(envelopeFixture(), { available: false });
  assert.equal(unavailable.allowed === false && unavailable.reason, "CLASSIFICATION_UNAVAILABLE");

  const missing = decideContext(undefined);
  assert.equal(missing.allowed === false && missing.reason, "CLASSIFICATION_UNAVAILABLE");

  const invalid = decideContext({ schemaVersion: 2, adultState: "ADULT" });
  assert.equal(invalid.allowed === false && invalid.reason, "CLASSIFICATION_INVALID");
});

test("an adult, non-sensitive context is allowed", () => {
  const decision = decideContext(envelopeFixture());
  assert.equal(decision.allowed, true);
});
