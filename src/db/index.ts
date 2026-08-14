import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";

import * as schema from "@/db/schema";

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error(
    "DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.",
  );
}

/**
 * Neon's HTTP driver: one round trip per statement, no pooled TCP connection to
 * leak across serverless invocations.
 *
 * Constructed eagerly on purpose — `@auth/drizzle-adapter` sniffs the dialect
 * with an `instanceof` check, so this cannot be a lazy Proxy.
 */
export const db = drizzle(neon(url), { schema });

export { schema };
