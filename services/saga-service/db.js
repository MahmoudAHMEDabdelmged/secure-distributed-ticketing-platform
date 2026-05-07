const { Pool } = require("pg");
require("dotenv").config();

const connectionString = process.env.SAGA_DATABASE_URL;
let pool;

function isConfiguredDatabaseUrl(value) {
  return typeof value === "string" &&
    value.trim().length > 0 &&
    !value.includes("PUT_REAL_SAGA_NEON_DATABASE_URL_HERE") &&
    !value.includes("PASTE_");
}

function createDatabaseConfigError() {
  const error = new Error("Missing required environment variable: SAGA_DATABASE_URL");
  error.code = "MISSING_SAGA_DATABASE_URL";
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
  if (!isConfiguredDatabaseUrl(connectionString)) {
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
  const requiredTables = ["saga_flows", "saga_steps"];
  const requiredColumns = {
    saga_flows: [
      "id",
      "idempotency_key",
      "saga_type",
      "status",
      "user_id",
      "booking_id",
      "payment_id",
      "ticket_ids",
      "notification_ids",
      "event_id",
      "section_id",
      "quantity",
      "amount_cents",
      "currency",
      "current_step",
      "failure_reason",
      "retry_count",
      "max_retries",
      "is_retryable",
      "metadata",
      "created_at",
      "updated_at",
      "completed_at"
    ],
    saga_steps: [
      "id",
      "saga_id",
      "step_name",
      "status",
      "attempt_count",
      "request_payload",
      "response_payload",
      "error_message",
      "started_at",
      "completed_at"
    ]
  };

  const tableResult = await query(
    `select table_name
     from information_schema.tables
     where table_schema = 'public'
     and table_name = any($1::text[])`,
    [requiredTables]
  );

  const existingTables = new Set(tableResult.rows.map((row) => row.table_name));
  const missingTables = requiredTables.filter((tableName) => !existingTables.has(tableName));
  const missingColumns = {};

  for (const tableName of requiredTables) {
    if (!existingTables.has(tableName)) {
      missingColumns[tableName] = [];
      continue;
    }

    const columnsResult = await query(
      `select column_name
       from information_schema.columns
       where table_schema = 'public'
       and table_name = $1`,
      [tableName]
    );

    const existingColumns = new Set(columnsResult.rows.map((row) => row.column_name));
    missingColumns[tableName] = requiredColumns[tableName].filter((columnName) => !existingColumns.has(columnName));
  }

  const hasMissingColumns = Object.values(missingColumns).some((columns) => columns.length > 0);

  return {
    status: missingTables.length === 0 && !hasMissingColumns ? "ready" : "not_ready",
    tables: {
      saga_flows: existingTables.has("saga_flows"),
      saga_steps: existingTables.has("saga_steps")
    },
    missingTables,
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
