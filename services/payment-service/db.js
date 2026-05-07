const { Pool } = require("pg");
require("dotenv").config();

const connectionString = process.env.PAYMENT_DATABASE_URL;

if (!connectionString) {
  throw new Error("Missing required environment variable: PAYMENT_DATABASE_URL");
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
    "amount_cents",
    "currency",
    "payment_method",
    "provider",
    "provider_payment_ref",
    "card_last4",
    "status",
    "failure_reason",
    "risk_score",
    "is_suspicious",
    "suspicious_reason",
    "booking_snapshot",
    "created_at",
    "updated_at"
  ];

  const tableResult = await query(
    `select table_name
     from information_schema.tables
     where table_schema = 'public'
     and table_name = 'payments'
     limit 1`
  );

  if (tableResult.rowCount === 0) {
    return {
      status: "not_ready",
      tables: {
        payments: false
      },
      missingTables: ["payments"],
      missingColumns: []
    };
  }

  const columnsResult = await query(
    `select column_name
     from information_schema.columns
     where table_schema = 'public'
     and table_name = 'payments'`
  );

  const existingColumns = new Set(columnsResult.rows.map((row) => row.column_name));
  const missingColumns = requiredColumns.filter((columnName) => !existingColumns.has(columnName));

  return {
    status: missingColumns.length === 0 ? "ready" : "not_ready",
    tables: {
      payments: true
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
