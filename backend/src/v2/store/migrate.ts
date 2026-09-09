import { config } from "../../config";
import { createPostgresStore } from "./postgres";

/**
 * Apply the V2 schema.
 *
 *   DATABASE_URL=postgres://... npm --prefix backend run migrate
 *
 * The schema file is idempotent, so this is safe to re-run and safe to call on
 * deploy. It exits non-zero on failure rather than logging and continuing: a
 * half-migrated database should stop a rollout, not quietly serve traffic.
 */
async function main(): Promise<void> {
  const store = createPostgresStore(config.databaseUrl || process.env.DATABASE_URL);
  try {
    await store.migrate();
    // eslint-disable-next-line no-console
    console.log("V2 schema applied.");
  } finally {
    await store.close();
  }
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
