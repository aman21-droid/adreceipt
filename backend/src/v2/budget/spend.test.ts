import assert from "node:assert/strict";
import test from "node:test";
import { createGraphSpendReader, onchainCampaignId, parseSpendPage, sumAmounts } from "./spend";

const meta = { block: { number: 100 }, hasIndexingErrors: false };

function page(amounts: string[]) {
  return { data: { receipts: amounts.map((amount) => ({ amount })), _meta: meta } };
}

test("a valid page parses to its amounts", () => {
  const parsed = parseSpendPage(page(["100", "250"]));
  assert.deepEqual(parsed.amounts, ["100", "250"]);
  assert.equal(parsed.blockNumber, 100);
});

test("amounts sum as integers, not floats", () => {
  // Well beyond Number.MAX_SAFE_INTEGER: this is why the code uses BigInt.
  assert.equal(sumAmounts(["9007199254740993", "9007199254740993"]), "18014398509481986");
  assert.equal(sumAmounts([]), "0");
});

test("indexing errors are a failure, not a smaller number", () => {
  assert.throws(
    () =>
      parseSpendPage({
        data: { receipts: [], _meta: { block: { number: 5 }, hasIndexingErrors: true } },
      }),
    /indexing errors/,
  );
});

test("malformed responses throw rather than reporting zero spend", () => {
  const cases: unknown[] = [
    null,
    "nope",
    { errors: [{ message: "boom" }] },
    { data: { receipts: [], _meta: {} } },
    { data: { _meta: meta } },
    { data: { receipts: [{ amount: "1.5" }], _meta: meta } },
    { data: { receipts: [{ amount: 100 }], _meta: meta } },
  ];
  for (const value of cases) {
    assert.throws(() => parseSpendPage(value));
  }
});

test("the on-chain campaign id is a deterministic bytes32", () => {
  const id = onchainCampaignId("11111111-2222-3333-4444-555555555555");
  assert.match(id, /^0x[0-9a-f]{64}$/);
  assert.equal(id, onchainCampaignId("11111111-2222-3333-4444-555555555555"));
  assert.notEqual(id, onchainCampaignId("11111111-2222-3333-4444-555555555556"));
});

test("the reader sums a single short page", async () => {
  const reader = createGraphSpendReader({
    queryUrl: "https://graph.example/query",
    fetchImpl: (async () =>
      new Response(JSON.stringify(page(["100", "400"])), { status: 200 })) as typeof fetch,
  });
  const result = await reader.settledSpend("11111111-2222-3333-4444-555555555555");
  assert.equal(result.settled, "500");
  assert.equal(result.blockNumber, 100);
});

test("a transport failure throws so the caller can fail closed", async () => {
  const reader = createGraphSpendReader({
    queryUrl: "https://graph.example/query",
    fetchImpl: (async () => new Response("nope", { status: 502 })) as typeof fetch,
  });
  await assert.rejects(
    () => reader.settledSpend("11111111-2222-3333-4444-555555555555"),
    /Graph responded 502/,
  );
});

test("an unconfigured endpoint throws rather than returning zero", async () => {
  const reader = createGraphSpendReader({ queryUrl: "" });
  await assert.rejects(
    () => reader.settledSpend("11111111-2222-3333-4444-555555555555"),
    /not configured/,
  );
});
