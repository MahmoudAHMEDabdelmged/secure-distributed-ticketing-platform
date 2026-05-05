const { Pool } = require("pg");
require("dotenv").config();

const connectionString = process.env.EVENTS_DATABASE_URL;

if (!connectionString) {
  throw new Error("Missing required environment variable: EVENTS_DATABASE_URL");
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

async function checkRequiredSchema() {
  const requiredTables = ["venues", "events", "event_sections"];
  const requiredColumns = {
    venues: ["id", "name", "city", "country", "address", "created_at", "updated_at"],
    events: [
      "id",
      "venue_id",
      "title",
      "description",
      "category",
      "starts_at",
      "ends_at",
      "status",
      "image_url",
      "created_by_user_id",
      "created_at",
      "updated_at"
    ],
    event_sections: [
      "id",
      "event_id",
      "name",
      "price_cents",
      "currency",
      "total_capacity",
      "available_capacity",
      "created_at",
      "updated_at"
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

module.exports = {
  pool,
  query,
  checkDatabaseConnection,
  checkRequiredSchema
};
