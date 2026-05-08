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
  const requiredTables = ["notification_deliveries", "in_app_notifications"];
  const requiredColumns = {
    notification_deliveries: [
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
    ],
    in_app_notifications: [
      "id",
      "recipient_user_id",
      "recipient_role",
      "scope",
      "type",
      "title",
      "message",
      "severity",
      "resource_type",
      "resource_id",
      "metadata",
      "is_read",
      "read_at",
      "created_at",
      "expires_at"
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
  const tables = requiredTables.reduce((summary, tableName) => {
    summary[tableName] = existingTables.has(tableName);
    return summary;
  }, {});

  const columnsResult = await query(
    `select table_name, column_name
     from information_schema.columns
     where table_schema = 'public'
     and table_name = any($1::text[])`,
    [requiredTables]
  );

  const columnsByTable = columnsResult.rows.reduce((summary, row) => {
    if (!summary[row.table_name]) {
      summary[row.table_name] = new Set();
    }

    summary[row.table_name].add(row.column_name);
    return summary;
  }, {});

  const columns = Object.entries(requiredColumns).reduce((summary, [tableName, tableColumns]) => {
    const existingColumns = columnsByTable[tableName] || new Set();
    const missingColumns = tableColumns.filter((columnName) => !existingColumns.has(columnName));

    summary[tableName] = {
      status: missingColumns.length === 0 ? "ready" : "missing_columns",
      missingColumns
    };

    return summary;
  }, {});

  const missingTables = requiredTables.filter((tableName) => !tables[tableName]);
  const missingColumns = Object.entries(columns)
    .filter(([, columnSummary]) => columnSummary.missingColumns.length > 0)
    .map(([tableName, columnSummary]) => ({
      table: tableName,
      columns: columnSummary.missingColumns
    }));

  return {
    status: missingTables.length === 0 && missingColumns.length === 0 ? "ready" : "not_ready",
    tables,
    missingTables,
    columns,
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
