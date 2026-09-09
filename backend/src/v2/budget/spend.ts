import { id as keccakUtf8, isHexString } from "ethers";

/**
 * Settled spend, read from the Graph.
 *
 * The deployed contract enforces nothing about aggregate campaign budgets - it
 * checks one signed quote at a time. So "how much has this campaign actually
 * spent" has exactly one truthful source, the indexed receipts, and this module
 * is the only thing that answers it.
 *
 * Every failure here throws. There is no zero-on-error path: reading zero spend
 * when the Graph is unreachable would report the entire budget as available and
 * authorise delivery that has already been paid for. The caller turns a throw
 * into BUDGET_UNAVAILABLE and serves no ad, which is the safe direction to be
 * wrong in.
 */

const SPEND_QUERY = `query CampaignSpend($campaignId: Bytes!, $first: Int!, $skip: Int!) {
  receipts(first: $first, skip: $skip, where: { campaignId: $campaignId }, orderBy: blockNumber, orderDirection: asc) { amount }
  _meta { block { number } hasIndexingErrors }
}`;

const PAGE = 500;
const MAX_PAGES = 20;
const DECIMAL = /^(0|[1-9][0-9]*)$/;

/**
 * The on-chain campaign identifier for a stored campaign.
 *
 * Campaign rows are keyed by UUID, receipts by bytes32. Hashing the UUID gives a
 * stable, collision-resistant link between the two without putting a database
 * key on chain, and without needing a lookup table that could drift.
 */
export function onchainCampaignId(campaignId: string): string {
  return keccakUtf8(campaignId);
}

export interface SpendResult {
  /** Total settled, in minor units of the settlement asset. */
  settled: string;
  /** Graph head at the time of the read, for staleness reporting. */
  blockNumber: number;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Pure parser, so the summing rules are testable without a network. */
export function parseSpendPage(value: unknown): { amounts: string[]; blockNumber: number } {
  const body = object(value);
  if (!body) throw new Error("Graph response is not an object");
  if (Array.isArray(body.errors) && body.errors.length > 0) {
    throw new Error("Graph returned query errors");
  }
  const data = object(body.data);
  const meta = object(data?._meta);
  const block = object(meta?.block);
  if (!Number.isSafeInteger(block?.number) || Number(block?.number) < 0) {
    throw new Error("Graph response is missing valid metadata");
  }
  if (meta?.hasIndexingErrors === true) {
    throw new Error("Graph reports indexing errors");
  }
  const receipts = data?.receipts;
  if (!Array.isArray(receipts)) throw new Error("Graph response is missing receipts");

  const amounts = receipts.map((entry) => {
    const receipt = object(entry);
    const amount = receipt?.amount;
    if (typeof amount !== "string" || !DECIMAL.test(amount)) {
      throw new Error("Graph receipt has an invalid amount");
    }
    return amount;
  });
  return { amounts, blockNumber: Number(block?.number) };
}

export function sumAmounts(amounts: string[]): string {
  return amounts.reduce((total, amount) => total + BigInt(amount), 0n).toString();
}

export interface SpendReader {
  settledSpend(campaignId: string): Promise<SpendResult>;
}

export function createGraphSpendReader(options: {
  queryUrl: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}): SpendReader {
  const doFetch = options.fetchImpl ?? fetch;

  return {
    async settledSpend(campaignId: string): Promise<SpendResult> {
      if (!options.queryUrl) throw new Error("Graph query URL is not configured");
      const onchain = onchainCampaignId(campaignId);
      if (!isHexString(onchain, 32)) throw new Error("campaign id did not hash to bytes32");

      const amounts: string[] = [];
      let blockNumber = 0;

      for (let page = 0; page < MAX_PAGES; page++) {
        const response = await doFetch(options.queryUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
          },
          body: JSON.stringify({
            query: SPEND_QUERY,
            variables: { campaignId: onchain, first: PAGE, skip: page * PAGE },
          }),
        });
        if (!response.ok) throw new Error(`Graph responded ${response.status}`);

        const parsed = parseSpendPage(await response.json());
        blockNumber = parsed.blockNumber;
        amounts.push(...parsed.amounts);
        if (parsed.amounts.length < PAGE) {
          return { settled: sumAmounts(amounts), blockNumber };
        }
      }
      // Refusing beats silently truncating: a partial sum understates spend and
      // would authorise delivery beyond the budget.
      throw new Error("campaign has more receipts than the spend reader will page through");
    },
  };
}
