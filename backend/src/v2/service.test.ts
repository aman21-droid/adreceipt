import assert from "node:assert/strict";
import test from "node:test";
import { CampaignService } from "./service";
import { FakeStore, envelopeFixture, manifestFixture } from "./testing/fake-store";
import type { SpendReader } from "./budget/spend";

function spendReader(settled: string | Error): SpendReader {
  return {
    async settledSpend() {
      if (settled instanceof Error) throw settled;
      return { settled, blockNumber: 100 };
    },
  };
}

async function setup(options: { settled?: string | Error; floor?: number } = {}) {
  const store = new FakeStore();
  const service = new CampaignService({
    store,
    spend: spendReader(options.settled ?? "0"),
    relevanceFloor: options.floor ?? 0.5,
  });
  const advertiser = await store.createAdvertiser({
    name: "DeployCo",
    payer: "0x455a064eB69b064124bcE89f677Ce89d50B92911",
  });
  return { store, service, advertiser };
}

test("a draft is not deliverable until it is explicitly approved", async () => {
  const { service, advertiser } = await setup();
  const draft = await service.createDraft(advertiser.id, manifestFixture());
  assert.equal(draft.state, "DRAFT");

  const beforeApproval = await service.findPlacement({ proposedEnvelope: envelopeFixture() });
  assert.equal(beforeApproval.adServed, false);

  await service.approve(draft.id);
  const afterApproval = await service.findPlacement({ proposedEnvelope: envelopeFixture() });
  assert.equal(afterApproval.adServed, true);

  await service.pause(draft.id);
  const afterPause = await service.findPlacement({ proposedEnvelope: envelopeFixture() });
  assert.equal(afterPause.adServed, false);
});

test("revisions are appended and earlier ones survive unchanged", async () => {
  const { service, advertiser } = await setup();
  const first = await service.createDraft(advertiser.id, manifestFixture({ name: "First" }));
  const second = await service.revise(first.id, manifestFixture({ name: "Second" }));

  assert.equal(second.revisionNumber, 2);
  assert.notEqual(second.revisionHash, first.revisionHash);

  const history = await service.revisions(first.id);
  assert.equal(history.length, 2);
  assert.equal(history[0].revisionHash, first.revisionHash, "revision 1 hash must not change");
  assert.equal(history[0].manifest.name, "First");
  assert.equal(history[1].manifest.name, "Second");
});

test("approving a campaign does not change what it agreed to run", async () => {
  const { service, advertiser } = await setup();
  const draft = await service.createDraft(advertiser.id, manifestFixture());
  const approved = await service.approve(draft.id);
  assert.equal(approved.revisionHash, draft.revisionHash);
});

test("budget authorisation fails closed when settled spend cannot be read", async () => {
  const { service, store, advertiser } = await setup({ settled: new Error("graph down") });
  const campaign = await service.createDraft(advertiser.id, manifestFixture());
  await service.approve(campaign.id);

  const outcome = await service.reserve({
    reservationKey: "reservation-key-001",
    campaignId: campaign.id,
    amount: "100",
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false && outcome.reason, "BUDGET_UNAVAILABLE");
  // An unknown spend figure must not be treated as a small one: nothing is held.
  assert.equal(await store.activeReserved(campaign.id), "0");
});

test("settled spend counts against the budget", async () => {
  // Budget 10000, already settled 9950, so only 50 is left.
  const { service, advertiser } = await setup({ settled: "9950" });
  const campaign = await service.createDraft(
    advertiser.id,
    manifestFixture({ totalBudget: "10000" }),
  );
  await service.approve(campaign.id);

  const tooBig = await service.reserve({
    reservationKey: "reservation-key-big",
    campaignId: campaign.id,
    amount: "100",
  });
  assert.equal(tooBig.ok === false && tooBig.reason, "BUDGET_EXHAUSTED");

  const fits = await service.reserve({
    reservationKey: "reservation-key-fits",
    campaignId: campaign.id,
    amount: "50",
  });
  assert.equal(fits.ok, true);
});

test("reservations are idempotent under retry", async () => {
  const { service, store, advertiser } = await setup();
  const campaign = await service.createDraft(
    advertiser.id,
    manifestFixture({ totalBudget: "1000" }),
  );
  await service.approve(campaign.id);

  const first = await service.reserve({
    reservationKey: "same-key-01",
    campaignId: campaign.id,
    amount: "600",
  });
  const retry = await service.reserve({
    reservationKey: "same-key-01",
    campaignId: campaign.id,
    amount: "600",
  });

  assert.equal(first.ok && first.alreadyHeld, false);
  assert.equal(retry.ok && retry.alreadyHeld, true);
  // A retry must not consume the budget twice.
  assert.equal(await store.activeReserved(campaign.id), "600");
});

test("concurrent reservations cannot exceed the remaining budget", async () => {
  const { service, store, advertiser } = await setup();
  store.reserveDelay = 5; // force the two attempts to overlap
  const campaign = await service.createDraft(
    advertiser.id,
    manifestFixture({ totalBudget: "1000" }),
  );
  await service.approve(campaign.id);

  const [a, b] = await Promise.all([
    service.reserve({ reservationKey: "concurrent-a", campaignId: campaign.id, amount: "600" }),
    service.reserve({ reservationKey: "concurrent-b", campaignId: campaign.id, amount: "600" }),
  ]);

  const succeeded = [a, b].filter((result) => result.ok).length;
  assert.equal(succeeded, 1, "exactly one of two overlapping 600s fits in a 1000 budget");
  assert.equal(await store.activeReserved(campaign.id), "600");
});

test("releasing a reservation returns its budget", async () => {
  const { service, store, advertiser } = await setup();
  const campaign = await service.createDraft(
    advertiser.id,
    manifestFixture({ totalBudget: "1000" }),
  );
  await service.approve(campaign.id);

  await service.reserve({
    reservationKey: "release-me-01",
    campaignId: campaign.id,
    amount: "900",
  });
  assert.equal(await store.activeReserved(campaign.id), "900");

  assert.equal(await service.release("release-me-01"), true);
  assert.equal(await store.activeReserved(campaign.id), "0");
  // Releasing twice is not an error, but it is not a second release either.
  assert.equal(await service.release("release-me-01"), false);

  const after = await service.reserve({
    reservationKey: "after-release",
    campaignId: campaign.id,
    amount: "900",
  });
  assert.equal(after.ok, true);
});

test("delivery starts at zero and impression writes deduplicate", async () => {
  const { service, advertiser } = await setup({ settled: "10000" });
  const campaign = await service.createDraft(advertiser.id, manifestFixture());
  await service.approve(campaign.id);

  const empty = await service.report(campaign.id);
  assert.deepEqual(empty.observed, { impressions: 0, clicks: 0 });
  assert.equal(empty.effectiveCpc, null);

  const first = await service.recordEvent({
    eventKey: "impression-01",
    campaignId: campaign.id,
    kind: "IMPRESSION",
  });
  const repeat = await service.recordEvent({
    eventKey: "impression-01",
    campaignId: campaign.id,
    kind: "IMPRESSION",
  });
  await service.recordEvent({ eventKey: "click-01", campaignId: campaign.id, kind: "CLICK" });

  assert.equal(first.recorded, true);
  assert.equal(repeat.recorded, false);

  const report = await service.report(campaign.id);
  assert.deepEqual(report.observed, { impressions: 1, clicks: 1 });
  assert.equal(report.effectiveCpc, "10000");
});

test("a refused context returns a reason and considers no campaigns", async () => {
  const { service, advertiser } = await setup();
  const campaign = await service.createDraft(advertiser.id, manifestFixture());
  await service.approve(campaign.id);

  const sensitive = await service.findPlacement({
    proposedEnvelope: envelopeFixture({ categories: ["self_harm"] }),
  });
  assert.equal(sensitive.adServed, false);
  assert.equal(sensitive.adServed === false && sensitive.reason, "SENSITIVE_CONTEXT");
  // Policy refused before matching, so nothing was evaluated.
  assert.deepEqual(sensitive.trace, []);

  const unavailable = await service.findPlacement({
    proposedEnvelope: envelopeFixture(),
    classificationAvailable: false,
  });
  assert.equal(unavailable.adServed === false && unavailable.reason, "CLASSIFICATION_UNAVAILABLE");
});

test("no raw query text can reach a placement response", async () => {
  const { service, advertiser } = await setup();
  const campaign = await service.createDraft(advertiser.id, manifestFixture());
  await service.approve(campaign.id);

  // The envelope type has no field for it, and a caller that adds one is rejected.
  const smuggled = await service.findPlacement({
    proposedEnvelope: envelopeFixture({ query: "where should I deploy my node app" }),
  });
  assert.equal(smuggled.adServed, false);
  assert.equal(smuggled.adServed === false && smuggled.reason, "CLASSIFICATION_INVALID");

  const clean = await service.findPlacement({ proposedEnvelope: envelopeFixture() });
  assert.equal(JSON.stringify(clean).includes("where should I deploy"), false);
});
