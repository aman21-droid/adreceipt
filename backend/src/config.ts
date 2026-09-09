import { config as loadEnv } from "dotenv";
import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";

/**
 * Environment comes from `backend/.env` first, then the repo-root `.env`.
 * The root file is where the contract work already put CRE_SIMULATOR_PRIVATE_KEY,
 * so a fresh clone works without copying secrets around.
 */
const backendRoot = resolve(__dirname, "..");
const repoRoot = resolve(backendRoot, "..");

loadEnv({ path: join(backendRoot, ".env"), quiet: true });
loadEnv({ path: join(repoRoot, ".env"), quiet: true });

export interface Deployment {
  network: string;
  chainId: number;
  deployer: string;
  admin: string;
  parameters: {
    parentName: string;
    parentNode: string;
    placementLockSeconds: number;
    minPlacementWei: string;
    tierValiditySeconds: number;
    maxAccountAgeSeconds: number;
    minPlacements: number;
  };
  /** Block each contract was deployed in. Used as a log-scan lower bound. */
  blocks?: Record<string, number>;
  contracts: {
    AdvertiserRegistry: string;
    PlacementEscrow: string;
    TierAttestation: string;
    CREAttestationReceiver: string;
    PermissionedResolver: string;
    DisclosedSubnameRegistry: string;
    SuspiciousPatternRule: string;
  };
  roles: { creForwarder: string | null; creSimulator: string | null };
}

export interface SettlementDeployment {
  mode: "deployed";
  network: string;
  chainId: number;
  contract: "PlacementSettlementV1";
  constructor: { settlementAsset: string };
  address: string;
  deploymentBlock: number;
  deploymentTransaction: string;
  deployedAt: string;
}

const NETWORK = process.env.NETWORK ?? "sepolia";

/**
 * Addresses are read from the deployment record the deploy script writes, never
 * hardcoded. A redeploy therefore needs no code change here - which matters,
 * because PlacementEscrow and DisclosedSubnameRegistry are both expected to be
 * redeployed at least once before the demo.
 */
function loadDeployment(): Deployment {
  const path = join(repoRoot, "deployments", `${NETWORK}.json`);
  if (!existsSync(path)) {
    throw new Error(
      `No deployment record at ${path}. Run the deploy script for "${NETWORK}" first.`,
    );
  }
  return JSON.parse(readFileSync(path, "utf8")) as Deployment;
}

export const deployment = loadDeployment();
export const contracts = deployment.contracts;

function loadSettlementDeployment(): SettlementDeployment {
  const path = join(
    repoRoot,
    "deployments",
    `placement-settlement-${NETWORK}.json`,
  );
  if (!existsSync(path)) {
    throw new Error(`No settlement deployment record at ${path}.`);
  }
  return JSON.parse(readFileSync(path, "utf8")) as SettlementDeployment;
}

export const settlementDeployment = loadSettlementDeployment();

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

export const config = {
  network: NETWORK,
  chainId: deployment.chainId,
  rpcUrl: required("SEPOLIA_RPC_URL"),

  /**
   * The attestation key. This is deliberately NOT the deployer key: it holds
   * SIMULATOR_ROLE on the receiver and nothing else, so a leak costs us
   * attestations, not admin control of the registry.
   */
  simulatorPrivateKey: process.env.CRE_SIMULATOR_PRIVATE_KEY ?? "",

  // 8080 is a common default for local Apache/XAMPP installs, and a collision
  // there produces an EADDRINUSE that looks like our bug and is not.
  port: Number(process.env.PORT ?? 8787),

  /** Prefix for the DNS TXT record an advertiser publishes. */
  dnsRecordPrefix: process.env.DNS_RECORD_PREFIX ?? "_disclosed",
  dnsRecordKey: process.env.DNS_RECORD_KEY ?? "disclosed-verification",

  /** Resolvers queried for the challenge lookup. Agreement is required. */
  dnsResolvers: (process.env.DNS_RESOLVERS ?? "1.1.1.1,8.8.8.8")
    .split(",")
    .map((s) => s.trim()),
  graphQueryUrl: process.env.GRAPH_QUERY_URL ?? "",
  graphApiKey: process.env.GRAPH_API_KEY ?? "",
  graphMaxLag: Number(process.env.GRAPH_MAX_BLOCK_LAG ?? 20),
  settlementAddress: process.env.PLACEMENT_SETTLEMENT_ADDRESS ?? "",

  /**
   * PostgreSQL for the V2 campaign services. Intentionally has no default:
   * campaigns, reservations and measurement have no fallback store, and a
   * default here would invite one.
   */
  databaseUrl: process.env.DATABASE_URL ?? "",

  /**
   * Minimum share of a campaign's targeted topics that must appear in the
   * context before its bid is even compared. Raising it makes advertising rarer
   * and more relevant; it can never be bought past.
   */
  relevanceFloor: Number(process.env.RELEVANCE_FLOOR ?? 0.5),
  privyAppId: process.env.PRIVY_APP_ID ?? "",
  privyAppSecret: process.env.PRIVY_APP_SECRET ?? "",
  privyWalletId: process.env.PRIVY_WALLET_ID ?? "",
  privyPolicyId: process.env.PRIVY_POLICY_ID ?? "",
  privyAuthorizationPrivateKey:
    process.env.PRIVY_AUTHORIZATION_PRIVATE_KEY ??
    process.env.PRIVATE_KEY_PRIVY ??
    "",
};

export function requireSimulatorKey(): string {
  if (!config.simulatorPrivateKey) {
    throw new Error(
      "CRE_SIMULATOR_PRIVATE_KEY is not set. Attestation submission is disabled; reads still work.",
    );
  }
  return config.simulatorPrivateKey;
}
