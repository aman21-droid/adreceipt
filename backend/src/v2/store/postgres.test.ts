import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "crypto";
import { parseManifest } from "../campaigns/manifest";
import { manifestFixture } from "../testing/fake-store";
import { createPostgresStore, PostgresStore } from "./postgres";
import { StorageUnavailableError } from "./store";

/**
 * Integration tests for the real SQL.
 *
 * The service tests prove the orchestration is correct against a fake that
 * models the store's contract. They cannot prove the contract itself holds -
 * whether `SELECT ... FOR UPDATE` actually serialises two overlapping
 * reservations is a question about PostgreSQL, and only PostgreSQL can answer
 * it. That is what these do.
 *
 * They are skipped without DATABASE_URL so the suite still runs on a machine or
 * CI job with no database. Skipped is not passed: the concurrency guarantee is
 * unverified until this runs somewhere with a real server.
 *
 *   DATABASE_URL=postgres://localhost/adreceipt_test npm --prefix backend test
 */

const DATABASE_URL = process.env.DATABASE_URL;
const skip = DATABASE_URL ? false : "DATABASE_URL is not set";

test("refuses to construct a store without a connection string", () => {
  assert.throws(() => createPostgresStore(undefined), StorageUnavailableError);
  assert.throws(() => createPostgresStore(""), StorageUnavailableError);
});

test("postgres: schema applies and is idempotent", { skip }, async () => {
  const store = createPostgresStore(DATABASE_URL);
  try {
    await store.migrate();
    await store.migrate();
  } finally {
    await store.close();
  }
});

test("postgres: campaign data survives a new connection", { skip }, async () => {
  const first = createPostgresStore(DATABASE_URL);
  let campaignId: string;
  let advertiserId: string;
  try {
    await first.migrate();
    const advertiser = await first.createAdvertiser({
      name: `restart-${randomUUID().slice(0, 8)}`,
      payer: "0x455a064eb69b064124bce89f677ce89d50b92911",
    });
    advertiserId = advertiser.id;
    const campaign = await first.createCampaign({
      advertiserId,
      manifest: parseManifest(manifestFixture({ name: "Survives restart" })),
    });
    campaignId = campaign.id;
  } finally {
    await first.close();
  }

  // A completely new pool, standing in for a restarted process.
  const second = createPostgresStore(DATABASE_URL);
  try {
    const found = await second.getCampaign(campaignId);
    assert.equal(found?.manifest.name, "Survives restart");
    assert.equal(found?.state, "DRAFT");
  } finally {
    await second.close();
  }
});

test("postgres: revisions are preserved, not overwritten", { skip }, async () => {
  const store = createPostgresStore(DATABASE_URL);
  try {
    await store.migrate();
    const advertiser = await store.createAdvertiser({
      name: `revisions-${randomUUID().slice(0, 8)}`,
      payer: "0x455a064eb69b064124bce89f677ce89d50b92911",
    });
    const campaign = await store.createCampaign({
      advertiserId: advertiser.id,
      manifest: parseManifest(manifestFixture({ name: "First" })),
    });
    await store.reviseCampaign(campaign.id, parseManifest(manifestFixture({ name: "Second" })));

    const history = await store.listRevisions(campaign.id);
    assert.equal(history.length, 2);
    assert.equal(history[0].manifest.name, "First");
    assert.equal(history[0].revisionHash, campaign.revisionHash);
    assert.equal(history[1].manifest.name, "Second");
  } finally {
    await store.close();
  }
});

test("postgres: overlapping reservations cannot exceed the budget", { skip }, async () => {
  const store = createPostgresStore(DATABASE_URL);
  try {
    await store.migrate();
    const advertiser = await store.createAdvertiser({
      name: `concurrency-${randomUUID().slice(0, 8)}`,
      payer: "0x455a064eb69b064124bce89f677ce89d50b92911",
    });
    const campaign = await store.createCampaign({
      advertiserId: advertiser.id,
      manifest: parseManifest(manifestFixture({ bidAmount: "600", totalBudget: "1000" })),
    });

    // Ten simultaneous attempts at 600 against a 1000 budget. Exactly one fits.
    // Without the row lock several would read the same "0 reserved" and commit.
    const attempts = Array.from({ length: 10 }, (_, i) =>
      store.reserve({
        reservationKey: `${campaign.id}-${i}`,
        campaignId: campaign.id,
        amount: "600",
        settledSpend: "0",
        totalBudget: "1000",
      }),
    );
    const results = await Promise.all(attempts);

    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.equal(await store.activeReserved(campaign.id), "600");
  } finally {
    await store.close();
  }
});

test("postgres: measurement writes deduplicate on the event key", { skip }, async () => {
  const store = createPostgresStore(DATABASE_URL);
  try {
    await store.migrate();
    const advertiser = await store.createAdvertiser({
      name: `events-${randomUUID().slice(0, 8)}`,
      payer: "0x455a064eb69b064124bce89f677ce89d50b92911",
    });
    const campaign = await store.createCampaign({
      advertiserId: advertiser.id,
      manifest: parseManifest(manifestFixture()),
    });

    const key = `${campaign.id}-impression-1`;
    const first = await store.recordEvent({
      eventKey: key,
      campaignId: campaign.id,
      kind: "IMPRESSION",
    });
    const second = await store.recordEvent({
      eventKey: key,
      campaignId: campaign.id,
      kind: "IMPRESSION",
    });

    assert.equal(first.recorded, true);
    assert.equal(second.recorded, false);
    assert.deepEqual(await store.deliveryTotals(campaign.id), { impressions: 1, clicks: 0 });
  } finally {
    await store.close();
  }
});

// Referenced so the import is used even when every integration test is skipped.
assert.equal(typeof PostgresStore, "function");
