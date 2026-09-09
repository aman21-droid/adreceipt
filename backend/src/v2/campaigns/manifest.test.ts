import assert from "node:assert/strict";
import test from "node:test";
import {
  ManifestError,
  canonicalise,
  parseManifest,
  revisionHash,
  toPublicPlacement,
} from "./manifest";
import { manifestFixture } from "../testing/fake-store";

test("a valid manifest is accepted and canonicalised", () => {
  const manifest = parseManifest(
    manifestFixture({ targetTopics: ["devops", "backend_hosting", "devops"] }),
  );
  // Sorted and de-duplicated, so the hash does not depend on input order.
  assert.deepEqual(manifest.targetTopics, ["backend_hosting", "devops"]);
});

test("the revision hash is deterministic and order independent", () => {
  const a = parseManifest(manifestFixture({ targetTopics: ["a_topic", "b_topic"] }));
  const b = parseManifest(manifestFixture({ targetTopics: ["b_topic", "a_topic"] }));
  assert.equal(revisionHash(a), revisionHash(b));
  assert.match(revisionHash(a), /^0x[0-9a-f]{64}$/);
});

test("any change to the terms changes the revision hash", () => {
  const base = parseManifest(manifestFixture());
  const baseHash = revisionHash(base);

  const changes = [
    manifestFixture({ name: "Different name" }),
    manifestFixture({ productRef: "other-product" }),
    manifestFixture({ recommendationText: "Different words entirely." }),
    manifestFixture({ targetTopics: ["something_else"] }),
    manifestFixture({ blockedTopics: ["gambling"] }),
    manifestFixture({ bidAmount: "1001" }),
    manifestFixture({ totalBudget: "10001" }),
  ];
  for (const change of changes) {
    assert.notEqual(revisionHash(parseManifest(change)), baseHash);
  }
});

test("canonical form pins field order rather than relying on key insertion", () => {
  const manifest = parseManifest(manifestFixture());
  assert.equal(
    canonicalise(manifest),
    JSON.stringify([
      2,
      manifest.name,
      manifest.productRef,
      manifest.recommendationText,
      manifest.targetTopics,
      manifest.blockedTopics,
      manifest.bidAmount,
      manifest.totalBudget,
    ]),
  );
});

test("invalid manifests are rejected", () => {
  const cases: [string, unknown][] = [
    ["wrong schema", manifestFixture({ schemaVersion: 1 } as never)],
    ["empty targeting", manifestFixture({ targetTopics: [] })],
    ["non-slug topic", manifestFixture({ targetTopics: ["Backend Hosting"] })],
    ["zero bid", manifestFixture({ bidAmount: "0" })],
    ["bid above budget", manifestFixture({ bidAmount: "20000", totalBudget: "10000" })],
    ["negative amount", manifestFixture({ bidAmount: "-5" })],
    ["fractional amount", manifestFixture({ bidAmount: "1.5" })],
    ["empty name", manifestFixture({ name: "   " })],
    [
      "contradictory topics",
      manifestFixture({ targetTopics: ["x_topic"], blockedTopics: ["x_topic"] }),
    ],
  ];
  for (const [label, value] of cases) {
    assert.throws(() => parseManifest(value), ManifestError, label);
  }
});

test("a public placement carries no targeting rules or budget", () => {
  const manifest = parseManifest(
    manifestFixture({ targetTopics: ["backend_hosting"], blockedTopics: ["gambling"] }),
  );
  const placement = toPublicPlacement(
    {
      id: "c1",
      advertiserId: "a1",
      state: "APPROVED",
      revisionNumber: 1,
      revisionHash: revisionHash(manifest),
      manifest,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    manifest.bidAmount,
  );

  const serialised = JSON.stringify(placement);
  assert.equal(serialised.includes("gambling"), false, "blocked topics must not leak");
  assert.equal(serialised.includes("backend_hosting"), false, "target topics must not leak");
  assert.equal(serialised.includes(manifest.totalBudget), false, "budget must not leak");
  assert.deepEqual(Object.keys(placement).sort(), [
    "amount",
    "campaignId",
    "productRef",
    "recommendationText",
    "revisionHash",
  ]);
});
