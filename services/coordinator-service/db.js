const { Pool } = require("pg");
require("dotenv").config();

const connectionString = process.env.COORDINATOR_DATABASE_URL;

if (!connectionString) {
  throw new Error("Missing required environment variable: COORDINATOR_DATABASE_URL");
}

function isLocalDatabaseUrl(url) {
  try {
    const parsedUrl = new URL(url);
    const hostname = parsedUrl.hostname.toLowerCase();

    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
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
  const requiredTables = [
    "coordinator_nodes",
    "leader_terms",
    "leader_votes",
    "heartbeats",
    "replicated_log",
    "log_replication_acks",
    "rsm_instances",
    "rsm_transitions",
    "consensus_outbox",
    "broadcast_messages",
    "broadcast_acks",
    "infrastructure_topology",
    "fault_injection_events"
  ];
  const requiredColumns = {
    coordinator_nodes: [
      "node_id",
      "role",
      "status",
      "current_term",
      "voted_for",
      "last_heartbeat_at",
      "last_seen_at",
      "created_at",
      "updated_at"
    ],
    leader_terms: ["id", "term", "leader_id", "elected_at", "reason"],
    leader_votes: ["id", "term", "candidate_id", "voter_id", "granted", "reason", "created_at"],
    heartbeats: ["id", "term", "leader_id", "follower_id", "status", "created_at"],
    replicated_log: [
      "log_index",
      "term",
      "leader_id",
      "rsm_id",
      "booking_id",
      "event_type",
      "payload",
      "ordering_type",
      "status",
      "commit_quorum",
      "ack_count",
      "created_at",
      "committed_at"
    ],
    log_replication_acks: ["id", "log_index", "node_id", "ack_status", "reason", "created_at"],
    rsm_instances: ["rsm_id", "booking_id", "current_state", "version", "status", "created_at", "updated_at"],
    rsm_transitions: [
      "transition_id",
      "rsm_id",
      "log_index",
      "from_state",
      "to_state",
      "event_type",
      "valid",
      "rejection_reason",
      "term",
      "committed_by_leader",
      "created_at"
    ],
    consensus_outbox: [
      "id",
      "log_index",
      "target_node_id",
      "message_type",
      "payload",
      "status",
      "retry_count",
      "last_error",
      "created_at",
      "processed_at"
    ],
    broadcast_messages: [
      "id",
      "mode",
      "leader_id",
      "term",
      "event_type",
      "payload",
      "required_acks",
      "received_acks",
      "result",
      "created_at",
      "completed_at"
    ],
    broadcast_acks: ["id", "broadcast_id", "node_id", "ack_status", "reason", "created_at"],
    infrastructure_topology: [
      "id",
      "service_name",
      "service_type",
      "replicas",
      "database_name",
      "region",
      "availability_zone",
      "estimated_rps",
      "status",
      "created_at"
    ],
    fault_injection_events: [
      "id",
      "node_id",
      "event_type",
      "reason",
      "system_safety",
      "system_liveness",
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
  await pool.end();
}

module.exports = {
  pool,
  query,
  checkDatabaseConnection,
  checkRequiredSchema,
  closePool
};
