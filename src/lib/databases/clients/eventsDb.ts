import { databaseEnv } from "../../../config/env/databaseEnv";

export const eventsDb = {
  connectionString: databaseEnv.eventsDatabaseUrl,
};

// Placeholder only. A real PostgreSQL client will be added later after the project chooses pg, Drizzle, Prisma, or another database library.
