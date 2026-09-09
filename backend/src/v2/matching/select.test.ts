import assert from "node:assert/strict";
import test from "node:test";
import {
  parseManifest,
  revisionHash,
  type CampaignRecord,
  type CampaignState,
} from "../campaigns/manifest";
import { parseEnvelope } from "../context/envelope";
import { relevanceOf, selectCampaign } from "./select";
import { envelopeFixture, manifestFixture } from "../testing/fake-store";

function campaign(
  id: string,
  overrides: Parameters<typeof manifestFixture>[0],
  state: CampaignState = "APPROVED",
): CampaignRecord {
  const manifest = parseManifest(manifestFixture(overrides));
  return {
    id,
    advertiserId: "advertiser",
    state,
    revisionNumber: 1,
    revisionHash: revisionHash(manifest),
    manifest,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

const context = parseEnvelope(
  envelopeFixture({ topics: ["backend_hosting"], categories: ["software"] }),
);

test("relevance is the share of targeted topics present in the context", () => {
  assert.equal(relevanceOf(campaign("a", { targetTopics: ["backend_hosting"] }), context), 1);
  assert.equal(
    relevanceOf(campaign("b", { targetTopics: ["backend_hosting", "unrelated_topic"] }), context),
    0.5,
  );
  assert.equal(relevanceOf(campaign("c", { targetTopics: ["unrelated_topic"] }), context), 0);
});

test("a higher bid does not rescue an irrelevant campaign", () => {
  const relevant = campaign("relevant", { targetTopics: ["backend_hosting"], bidAmount: "100" });
  const richButIrrelevant = campaign("rich", {
    targetTopics: ["luxury_watches"],
    bidAmount: "999999",
    totalBudget: "999999",
  });

  const result = selectCampaign([richButIrrelevant, relevant], context, 0.5);

  assert.equal(result.selected?.id, "relevant");
  // The expensive one was stopped at the floor, before bids were compared.
  assert.equal(result.trace.find((entry) => entry.campaignId === "rich")?.code, "BELOW_FLOOR");
});

test("bid ranks only among campaigns that already passed eligibility", () => {
  const cheap = campaign("cheap", { targetTopics: ["backend_hosting"], bidAmount: "100" });
  const rich = campaign("rich", {
    targetTopics: ["backend_hosting"],
    bidAmount: "5000",
    totalBudget: "5000",
  });
  const result = selectCampaign([cheap, rich], context, 0.5);
  assert.equal(result.selected?.id, "rich");
});

test("unapproved campaigns never reach ranking", () => {
  const draft = campaign(
    "draft",
    { targetTopics: ["backend_hosting"], bidAmount: "9999", totalBudget: "9999" },
    "DRAFT",
  );
  const paused = campaign(
    "paused",
    { targetTopics: ["backend_hosting"], bidAmount: "9999", totalBudget: "9999" },
    "PAUSED",
  );
  const live = campaign("live", { targetTopics: ["backend_hosting"], bidAmount: "10" });

  const result = selectCampaign([draft, paused, live], context, 0.5);
  assert.equal(result.selected?.id, "live");
  assert.equal(result.trace.find((e) => e.campaignId === "draft")?.code, "NOT_APPROVED");
  assert.equal(result.trace.find((e) => e.campaignId === "paused")?.code, "NOT_APPROVED");
});

test("a campaign's own blocked topics exclude it from that context", () => {
  const fussy = campaign("fussy", {
    targetTopics: ["backend_hosting"],
    blockedTopics: ["software"],
  });
  const result = selectCampaign([fussy], context, 0.5);
  assert.equal(result.selected, undefined);
  assert.equal(result.trace[0].code, "BLOCKED_BY_CONTEXT");
  assert.equal(result.reason, "NO_ELIGIBLE_CAMPAIGN");
});

test("below-floor and no-campaign are different reasons", () => {
  const irrelevant = campaign("irrelevant", { targetTopics: ["luxury_watches"] });
  assert.equal(selectCampaign([irrelevant], context, 0.5).reason, "BELOW_RELEVANCE_FLOOR");
  assert.equal(selectCampaign([], context, 0.5).reason, "NO_ELIGIBLE_CAMPAIGN");
});

test("ties break deterministically rather than on input order", () => {
  const a = campaign("a", { targetTopics: ["backend_hosting"], name: "A", bidAmount: "500" });
  const b = campaign("b", { targetTopics: ["backend_hosting"], name: "B", bidAmount: "500" });
  const forwards = selectCampaign([a, b], context, 0.5).selected?.id;
  const backwards = selectCampaign([b, a], context, 0.5).selected?.id;
  assert.equal(forwards, backwards);
});

test("the trace never contains a campaign's targeting rules", () => {
  const fussy = campaign("fussy", {
    targetTopics: ["backend_hosting"],
    blockedTopics: ["gambling"],
  });
  const serialised = JSON.stringify(selectCampaign([fussy], context, 0.5).trace);
  assert.equal(serialised.includes("gambling"), false);
  assert.equal(serialised.includes("backend_hosting"), false);
});
