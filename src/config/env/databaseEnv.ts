type DatabaseEnv = {
  authDatabaseUrl: string;
  eventsDatabaseUrl: string;
  bookingDatabaseUrl: string;
  paymentDatabaseUrl: string;
  ticketDatabaseUrl: string;
};

function requireEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

export function getDatabaseEnv(): DatabaseEnv {
  return {
    authDatabaseUrl: requireEnv("AUTH_DATABASE_URL"),
    eventsDatabaseUrl: requireEnv("EVENTS_DATABASE_URL"),
    bookingDatabaseUrl: requireEnv("BOOKING_DATABASE_URL"),
    paymentDatabaseUrl: requireEnv("PAYMENT_DATABASE_URL"),
    ticketDatabaseUrl: requireEnv("TICKET_DATABASE_URL"),
  };
}

export const databaseEnv = getDatabaseEnv();
