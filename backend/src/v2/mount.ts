import type { Router } from "express";
import { config } from "../config";
import { createGraphSpendReader } from "./budget/spend";
import { createV2Router, createUnavailableV2Router } from "./routes";
import { CampaignService } from "./service";
import { createPostgresStore } from "./store/postgres";
import { StorageUnavailableError } from "./store/store";

/**
 * Build the V2 router, or a router that explains why there isn't one.
 *
 * The server starts either way. A missing database must not take down receipt
 * verification, which has no dependency on it - but it must also not be papered
 * over, so every /v2 route answers 503 with the reason until it is configured.
 */
export function mountV2(): Router {
  if (!config.databaseUrl) {
    return createUnavailableV2Router(
      "DATABASE_URL is not set. Campaign services require PostgreSQL; there is no fallback store.",
    );
  }
  if (!config.graphQueryUrl) {
    // Budget authorisation reads settled spend from the Graph. Without it every
    // reservation would fail closed anyway; saying so up front is clearer than
    // letting each call discover it.
    return createUnavailableV2Router(
      "GRAPH_QUERY_URL is not set. Campaign budget authorisation requires settled spend from the Graph.",
    );
  }

  try {
    const store = createPostgresStore(config.databaseUrl);
    const spend = createGraphSpendReader({
      queryUrl: config.graphQueryUrl,
      apiKey: config.graphApiKey || undefined,
    });
    const service = new CampaignService({
      store,
      spend,
      relevanceFloor: config.relevanceFloor,
    });
    return createV2Router({ service, store });
  } catch (cause) {
    if (cause instanceof StorageUnavailableError) {
      return createUnavailableV2Router(cause.message);
    }
    throw cause;
  }
}
