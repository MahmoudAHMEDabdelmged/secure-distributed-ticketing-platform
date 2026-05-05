const { Pool } = require("pg");
require("dotenv").config();

const connectionString = process.env.TICKET_DATABASE_URL;

if (!connectionString) {
  throw new Error("Missing required environment variable: TICKET_DATABASE_URL");
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
    "booking_id",
    "user_id",
    "user_email",
    "event_id",
    "section_id",
    "event_title",
    "section_name",
    "ticket_number",
    "verification_token_hash",
    "verification_url",
    "status",
    "issued_at",
    "used_at",
    "expires_at",
    "created_at",
    "updated_at"
  ];

  const tableResult = await query(
    `select table_name
     from information_schema.tables
     where table_schema = 'public'
     and table_name = 'issued_tickets'
     limit 1`
  );

  if (tableResult.rowCount === 0) {
    return {
      status: "not_ready",
      tables: {
        issued_tickets: false
      },
      missingTables: ["issued_tickets"],
      missingColumns: []
    };
  }

  const columnsResult = await query(
    `select column_name
     from information_schema.columns
     where table_schema = 'public'
     and table_name = 'issued_tickets'`
  );

  const existingColumns = new Set(columnsResult.rows.map((row) => row.column_name));
  const missingColumns = requiredColumns.filter((columnName) => !existingColumns.has(columnName));

  return {
    status: missingColumns.length === 0 ? "ready" : "not_ready",
    tables: {
      issued_tickets: true
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
