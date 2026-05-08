const { Pool } = require("pg");
require("dotenv").config();

const connectionString = process.env.MONITORING_DATABASE_URL;
const placeholderDatabaseUrls = new Set([
  "PUT_REAL_NEON_MONITORING_DB_URL_HERE",
  "real_neon_url_here"
]);

let pool = null;

function isDatabaseConfigured() {
  return Boolean(connectionString && !placeholderDatabaseUrls.has(connectionString));
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

function createConfigurationError() {
  const error = new Error("Monitoring database is not configured");
  error.code = "MISSING_MONITORING_DATABASE_URL";
  return error;
}

function getPool() {
  if (!isDatabaseConfigured()) {
    throw createConfigurationError();
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

async function checkRequiredSchema() {
  const requiredTables = [
    "service_health_checks",
    "monitoring_incidents",
    "monitoring_nodes",
    "rsm_events"
  ];
  const requiredColumns = {
    service_health_checks: [
      "id",
      "service_name",
      "service_url",
      "check_type",
      "status",
      "http_status",
      "latency_ms",
      "response_summary",
      "error_message",
      "checked_at"
    ],
    monitoring_incidents: [
      "id",
      "service_name",
      "incident_type",
      "severity",
      "status",
      "first_detected_at",
      "last_detected_at",
      "resolved_at",
      "consecutive_failures",
      "summary",
      "metadata"
    ],
    monitoring_nodes: [
      "id",
      "node_name",
      "service_name",
      "node_role",
      "status",
      "last_heartbeat_at",
      "metadata",
      "created_at",
      "updated_at"
    ],
    rsm_events: [
      "id",
      "term",
      "log_index",
      "event_type",
      "command",
      "status",
      "created_at"
    ]
  };

  const tablesResult = await query(
    `select table_name
     from information_schema.tables
     where table_schema = 'public'
     and table_name = any($1::text[])`,
    [requiredTables]
  );

  const existingTables = new Set(tablesResult.rows.map((row) => row.table_name));
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
    pool = null;
  }
}

module.exports = {
  query,
  checkDatabaseConnection,
  checkRequiredSchema,
  closePool,
  isDatabaseConfigured
};
