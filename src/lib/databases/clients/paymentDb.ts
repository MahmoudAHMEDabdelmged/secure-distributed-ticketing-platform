import { databaseEnv } from "../../../config/env/databaseEnv";

export const paymentDb = {
  connectionString: databaseEnv.paymentDatabaseUrl,
};

// Placeholder only. A real PostgreSQL client will be added later after the project chooses pg, Drizzle, Prisma, or another database library.
