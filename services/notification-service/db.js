const { Pool } = require("pg");
require("dotenv").config();

const connectionString = process.env.NOTIFICATION_DATABASE_URL;
let pool;

function createDatabaseConfigError() {
  const error = new Error("Missing required environment variable: NOTIFICATION_DATABASE_URL");
  error.code = "MISSING_NOTIFICATION_DATABASE_URL";
  return error;
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

function getPool() {
  if (!connectionString) {
    throw createDatabaseConfigError();
  }

  if (!pool) {
    pool = new Pool({
      connectionString,
      ssl: isLocalDatabaseUrl(connectionString)
        ? false
        : {
            rejectUnauthorized: false
          }
    });
  }

  return pool;
}

function compactSql(text) {
  return String(text).replace(/\s+/g, " ").trim();
}

async function query(text, params) {
  try {
    return await getPool().query(text, params);
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
    "notification_type",
    "recipient_email",
    "subject",
    "status",
    "booking_id",
    "ticket_id",
    "payment_id",
    "alert_severity",
    "provider_message_id",
    "error_message",
    "metadata",
    "created_at",
    "updated_at"
  ];

  const tableResult = await query(
    `select table_name
     from information_schema.tables
     where table_schema = 'public'
     and table_name = 'notification_deliveries'
     limit 1`
  );

  if (tableResult.rowCount === 0) {
    return {
      status: "not_ready",
      tables: {
        notification_deliveries: false
      },
      missingTables: ["notification_deliveries"],
      missingColumns: []
    };
  }

  const columnsResult = await query(
    `select column_name
     from information_schema.columns
     where table_schema = 'public'
     and table_name = 'notification_deliveries'`
  );

  const existingColumns = new Set(columnsResult.rows.map((row) => row.column_name));
  const missingColumns = requiredColumns.filter((columnName) => !existingColumns.has(columnName));

  return {
    status: missingColumns.length === 0 ? "ready" : "not_ready",
    tables: {
      notification_deliveries: true
    },
    missingTables: [],
    missingColumns
  };
}

async function closePool() {
  if (pool) {
    await pool.end();
  }
}

module.exports = {
  query,
  checkDatabaseConnection,
  checkDatabaseSchema,
  closePool
};
