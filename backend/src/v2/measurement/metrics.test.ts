import assert from "node:assert/strict";
import test from "node:test";
import { buildDeliveryReport } from "./metrics";

test("a campaign with no events reports null rates, not zero", () => {
  const report = buildDeliveryReport({
    campaignId: "c1",
    settledSpend: "5000",
    observed: { impressions: 0, clicks: 0 },
  });
  // Zero would read as "clicks are free". Null says "we have no clicks".
  assert.equal(report.effectiveCpc, null);
  assert.equal(report.effectiveCpm, null);
  assert.deepEqual(report.observed, { impressions: 0, clicks: 0 });
});

test("effective rates are derived from real spend and real counts", () => {
  const report = buildDeliveryReport({
    campaignId: "c1",
    settledSpend: "10000",
    observed: { impressions: 2000, clicks: 40 },
  });
  assert.equal(report.effectiveCpc, "250"); // 10000 / 40
  assert.equal(report.effectiveCpm, "5000"); // 10000 * 1000 / 2000
});

test("rates floor rather than reporting fractional minor units", () => {
  const report = buildDeliveryReport({
    campaignId: "c1",
    settledSpend: "100",
    observed: { impressions: 3, clicks: 3 },
  });
  assert.equal(report.effectiveCpc, "33");
});

test("both figures are labelled with where they came from", () => {
  const report = buildDeliveryReport({
    campaignId: "c1",
    settledSpend: "1",
    observed: { impressions: 1, clicks: 1 },
  });
  assert.equal(report.measurementSource, "application-observed");
  assert.equal(report.spendSource, "settled-onchain-receipts");
  assert.match(report.note, /not audited/);
  assert.match(report.note, /not a billing basis/);
});
