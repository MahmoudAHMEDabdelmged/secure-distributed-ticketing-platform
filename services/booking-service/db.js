const { Pool } = require("pg");
require("dotenv").config();

const connectionString = process.env.BOOKING_DATABASE_URL;

if (!connectionString) {
  throw new Error("Missing required environment variable: BOOKING_DATABASE_URL");
}

function isLocalDatabaseUrl(url) {
  try {
    const parsedUrl = new URL(url);
    const hostname = parsedUrl.hostname.toLowerCase();

    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch (error) {
    return url.includes("localhost") || url.includes("127.0.0.1");
  }
}

const pool = new Pool({
  connectionString,
  ssl: isLocalDatabaseUrl(connectionString)
    ? false
    : {
        rejectUnauthorized: false
      }
});

function compactSql(text) {
  return String(text).replace(/\s+/g, " ").trim();
}

async function query(text, params) {
  try {
    return await pool.query(text, params);
  } catch (error) {
    error.sql = compactSql(text);
    throw error;
  }
}

async function checkDatabaseConnection() {
  const startedAt = Date.now();

  await query("select 1");

  return {
    status: "up",
    latencyMs: Date.now() - startedAt
  };
}

async function checkDatabaseSchema() {
  const requiredColumns = [
    "id",
    "user_id",
    "user_email",
    "event_id",
    "section_id",
    "event_title",
    "section_name",
    "quantity",
    "unit_price_cents",
    "total_price_cents",
    "currency",
    "status",
    "expires_at",
    "created_at",
    "updated_at"
  ];

  const tableResult = await query(
    `select table_name
     from information_schema.tables
     where table_schema = 'public'
     and table_name = 'bookings'
     limit 1`
  );

  if (tableResult.rowCount === 0) {
    return {
      status: "not_ready",
      tables: {
        bookings: false
      },
      missingTables: ["bookings"],
      missingColumns: []
    };
  }

  const columnsResult = await query(
    `select column_name
     from information_schema.columns
     where table_schema = 'public'
     and table_name = 'bookings'`
  );

  const existingColumns = new Set(columnsResult.rows.map((row) => row.column_name));
  const missingColumns = requiredColumns.filter((columnName) => !existingColumns.has(columnName));

  return {
    status: missingColumns.length === 0 ? "ready" : "not_ready",
    tables: {
      bookings: true
    },
    missingTables: [],
    missingColumns
  };
}

module.exports = {
  pool,
  query,
  checkDatabaseConnection,
  checkDatabaseSchema
};
