const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
require("dotenv").config();

const {
  pool,
  query,
  checkDatabaseConnection,
  checkRequiredSchema,
  closePool
} = require("./db");

class ApiError extends Error {
  constructor(statusCode, message, responseBody) {
    super(message);
    this.statusCode = statusCode;
    this.responseBody = responseBody || {
      message
    };
  }
}

const app = express();
const PORT = process.env.PORT || 4010;
const DEFAULT_CLUSTER_NODE_IDS = "coordinator-node-1,coordinator-node-2,coordinator-node-3";
const configuredClusterNodeIds = parseCsv(process.env.CLUSTER_NODE_IDS || DEFAULT_CLUSTER_NODE_IDS);
const NODE_ID = String(process.env.NODE_ID || configuredClusterNodeIds[0] || "coordinator-node-1").trim();
const CLUSTER_NODE_IDS = Array.from(new Set([NODE_ID, ...configuredClusterNodeIds]));
const ESTIMATED_USERS = parseIntegerEnv(process.env.ESTIMATED_USERS, 10000, { min: 1 });
const PEAK_CONCURRENT_USERS = parseIntegerEnv(process.env.PEAK_CONCURRENT_USERS, 1200, { min: 1 });
const ESTIMATED_QR_VALIDATIONS_PER_MINUTE = parseIntegerEnv(
  process.env.ESTIMATED_QR_VALIDATIONS_PER_MINUTE,
  1500,
  { min: 0 }
);
const ESTIMATED_BOOKING_REQUESTS_PER_MINUTE = parseIntegerEnv(
  process.env.ESTIMATED_BOOKING_REQUESTS_PER_MINUTE,
  700,
  { min: 0 }
);

const allowedTransitions = {
  INIT: {
    BOOKING_CREATED: "BOOKING_CREATED"
  },
  BOOKING_CREATED: {
    PAYMENT_PENDING: "PAYMENT_PENDING"
  },
  PAYMENT_PENDING: {
    PAYMENT_SUCCEEDED: "PAYMENT_SUCCEEDED",
    PAYMENT_FAILED: "PAYMENT_FAILED",
    PAYMENT_SUSPICIOUS: "PAYMENT_SUSPICIOUS"
  },
  PAYMENT_SUCCEEDED: {
    TICKET_ISSUED: "TICKET_ISSUED"
  },
  TICKET_ISSUED: {
    NOTIFICATION_PENDING: "NOTIFICATION_PENDING"
  },
  NOTIFICATION_PENDING: {
    NOTIFICATION_SENT: "NOTIFICATION_SENT"
  },
  NOTIFICATION_SENT: {
    COMPLETED: "COMPLETED"
  },
  PAYMENT_FAILED: {
    COMPENSATED: "COMPENSATED"
  },
  PAYMENT_SUSPICIOUS: {
    COMPENSATED: "COMPENSATED"
  }
};

app.use(helmet());
app.use(
  cors({
    origin(origin, callback) {
      const allowedOrigins = parseCsv(process.env.ALLOWED_ORIGINS || "http://localhost:3000,http://localhost:4000");

      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(new ApiError(403, "Origin is not allowed by CORS"));
    }
  })
);
app.use(express.json({ limit: "1mb" }));

function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function parseCsv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseIntegerEnv(value, defaultValue, options = {}) {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }

  const parsedValue = Number(value);

  if (!Number.isInteger(parsedValue)) {
    return defaultValue;
  }

  if (options.min !== undefined && parsedValue < options.min) {
    return defaultValue;
  }

  if (options.max !== undefined && parsedValue > options.max) {
    return defaultValue;
  }

  return parsedValue;
}

function parseIntegerQuery(value, fieldName, defaultValue, options = {}) {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }

  const parsedValue = Number(value);

  if (!Number.isInteger(parsedValue)) {
    throw new ApiError(400, `${fieldName} must be an integer`);
  }

  if (options.min !== undefined && parsedValue < options.min) {
    throw new ApiError(400, `${fieldName} must be at least ${options.min}`);
  }

  if (options.max !== undefined && parsedValue > options.max) {
    throw new ApiError(400, `${fieldName} must be at most ${options.max}`);
  }

  return parsedValue;
}

function compactSql(text) {
  return String(text).replace(/\s+/g, " ").trim();
}

async function runClientQuery(client, text, params) {
  try {
    return await client.query(text, params);
  } catch (error) {
    error.sql = compactSql(text);
    throw error;
  }
}

async function runQuery(client, text, params) {
  if (client) {
    return runClientQuery(client, text, params);
  }

  return query(text, params);
}

async function withTransaction(callback) {
  const client = await pool.connect();
  let transactionStarted = false;

  try {
    await runClientQuery(client, "begin");
    transactionStarted = true;
    const result = await callback(client);
    await runClientQuery(client, "commit");
    return result;
  } catch (error) {
    if (transactionStarted) {
      try {
        await runClientQuery(client, "rollback");
      } catch (rollbackError) {
        console.error("Coordinator transaction rollback failed:", {
          message: rollbackError.message,
          code: rollbackError.code
        });
      }
    }

    throw error;
  } finally {
    client.release();
  }
}

function assertRequiredString(value, fieldName, maxLength = 255) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ApiError(400, `${fieldName} is required`);
  }

  const trimmedValue = value.trim();

  if (trimmedValue.length > maxLength) {
    throw new ApiError(400, `${fieldName} is too long`);
  }

  return trimmedValue;
}

function normalizeOptionalString(value, fieldName, maxLength = 255) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  if (typeof value !== "string") {
    throw new ApiError(400, `${fieldName} must be a string`);
  }

  const trimmedValue = value.trim();

  if (trimmedValue.length > maxLength) {
    throw new ApiError(400, `${fieldName} is too long`);
  }

  return trimmedValue || null;
}

function normalizeEventType(value) {
  const eventType = assertRequiredString(value, "event_type", 100).toUpperCase();

  if (!/^[A-Z0-9_:-]{2,100}$/.test(eventType)) {
    throw new ApiError(400, "event_type may contain only letters, numbers, underscores, colons, and hyphens");
  }

  return eventType;
}

function normalizeNodeId(value) {
  const nodeId = assertRequiredString(value, "node_id", 120);

  if (!CLUSTER_NODE_IDS.includes(nodeId)) {
    throw new ApiError(404, "Coordinator node is not part of this cluster", {
      message: "Coordinator node is not part of this cluster",
      node_id: nodeId,
      cluster_node_ids: CLUSTER_NODE_IDS
    });
  }

  return nodeId;
}

function normalizeJsonObject(value, fieldName) {
  if (value === undefined || value === null) {
    return {};
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, `${fieldName} must be an object`);
  }

  return value;
}

function assertUuid(value, fieldName) {
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  if (typeof value !== "string" || !uuidPattern.test(value)) {
    throw new ApiError(400, `${fieldName} must be a valid UUID`);
  }

  return value;
}

function clusterMath(nodeCount) {
  const n = Number(nodeCount || CLUSTER_NODE_IDS.length);

  return {
    cluster_size: n,
    quorum: Math.floor(n / 2) + 1,
    tolerated_faults: Math.floor((n - 1) / 2)
  };
}

function isHealthyParticipant(node) {
  return Boolean(node && node.status === "healthy" && node.role !== "crashed");
}

function validateTransition(fromState, eventType) {
  const normalizedState = String(fromState || "INIT").trim().toUpperCase();
  const normalizedEventType = normalizeEventType(eventType);
  const nextState = allowedTransitions[normalizedState] && allowedTransitions[normalizedState][normalizedEventType];

  if (!nextState) {
    return {
      valid: false,
      from_state: normalizedState,
      to_state: normalizedState,
      event_type: normalizedEventType,
      rejection_reason: "CAUSAL_ORDER_VIOLATION"
    };
  }

  return {
    valid: true,
    from_state: normalizedState,
    to_state: nextState,
    event_type: normalizedEventType,
    rejection_reason: null
  };
}

function rsmStatusForState(state) {
  if (state === "COMPLETED") {
    return "completed";
  }

  if (state === "COMPENSATED") {
    return "compensated";
  }

  return "active";
}

function toNode(row) {
  return {
    node_id: row.node_id,
    role: row.role,
    status: row.status,
    current_term: Number(row.current_term || 0),
    voted_for: row.voted_for,
    last_heartbeat_at: row.last_heartbeat_at,
    last_seen_at: row.last_seen_at,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function toRsm(row) {
  return {
    rsm_id: row.rsm_id,
    booking_id: row.booking_id,
    current_state: row.current_state,
    version: Number(row.version || 0),
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function toTransition(row) {
  return {
    transition_id: row.transition_id,
    rsm_id: row.rsm_id,
    log_index: row.log_index,
    from_state: row.from_state,
    to_state: row.to_state,
    event_type: row.event_type,
    valid: row.valid,
    rejection_reason: row.rejection_reason,
    term: row.term === null || row.term === undefined ? null : Number(row.term),
    committed_by_leader: row.committed_by_leader,
    created_at: row.created_at
  };
}

function toLog(row) {
  return {
    log_index: row.log_index,
    term: Number(row.term || 0),
    leader_id: row.leader_id,
    rsm_id: row.rsm_id,
    booking_id: row.booking_id,
    event_type: row.event_type,
    payload: row.payload || {},
    ordering_type: row.ordering_type,
    status: row.status,
    commit_quorum: Number(row.commit_quorum || 0),
    ack_count: Number(row.ack_count || 0),
    created_at: row.created_at,
    committed_at: row.committed_at,
    acks: row.acks || []
  };
}

function toOutbox(row) {
  return {
    id: row.id,
    log_index: row.log_index,
    target_node_id: row.target_node_id,
    message_type: row.message_type,
    payload: row.payload || {},
    status: row.status,
    retry_count: Number(row.retry_count || 0),
    last_error: row.last_error,
    created_at: row.created_at,
    processed_at: row.processed_at
  };
}

async function ensureClusterRows() {
  for (const nodeId of CLUSTER_NODE_IDS) {
    await query(
      `insert into public.coordinator_nodes (
         node_id,
         role,
         status,
         current_term,
         last_seen_at
       )
       values ($1, 'follower', 'healthy', 0, now())
       on conflict (node_id)
       do update set
         last_seen_at = case
           when public.coordinator_nodes.node_id = $2
            and public.coordinator_nodes.status <> 'crashed'
           then now()
           else public.coordinator_nodes.last_seen_at
         end,
         updated_at = now()`,
      [nodeId, NODE_ID]
    );
  }
}

async function seedInfrastructureTopology() {
  await query(
    `insert into public.infrastructure_topology (
       service_name,
       service_type,
       replicas,
       database_name,
       region,
       availability_zone,
       estimated_rps,
       status
     )
     select
       seed.service_name,
       seed.service_type,
       seed.replicas,
       seed.database_name,
       seed.region,
       seed.availability_zone,
       seed.estimated_rps,
       seed.status
     from (
       values
         ('api-gateway', 'gateway', 1, null, 'primary-region', 'az-1', 600, 'active'),
         ('auth-service', 'backend-service', 1, 'auth-db', 'primary-region', 'az-1', 120, 'active'),
         ('events-service', 'backend-service', 1, 'events-db', 'primary-region', 'az-1', 220, 'active'),
         ('booking-service', 'backend-service', 1, 'booking-db', 'primary-region', 'az-1', 260, 'active'),
         ('payment-service', 'backend-service', 1, 'payment-db', 'primary-region', 'az-1', 180, 'active'),
         ('ticket-service', 'backend-service', 1, 'ticket-db', 'primary-region', 'az-1', 240, 'active'),
         ('notification-service', 'backend-service', 1, 'notification-db', 'primary-region', 'az-1', 160, 'active'),
         ('audit-service', 'backend-service', 1, 'audit-db', 'primary-region', 'az-1', 180, 'active'),
         ('saga-service', 'backend-service', 1, 'saga-db', 'primary-region', 'az-1', 140, 'active'),
         ('monitoring-service', 'backend-service', 1, 'monitoring-db', 'primary-region', 'az-1', 80, 'active'),
         ('coordinator-service', 'consensus-service', 3, 'coordinator-db', 'primary-region', 'az-1', 180, 'active')
     ) as seed(
       service_name,
       service_type,
       replicas,
       database_name,
       region,
       availability_zone,
       estimated_rps,
       status
     )
     where not exists (
       select 1
       from public.infrastructure_topology existing
       where existing.service_name = seed.service_name
     )`
  );
}

async function loadClusterNodes(client) {
  const result = await runQuery(
    client,
    `select
       node_id,
       role,
       status,
       current_term,
       voted_for,
       last_heartbeat_at,
       last_seen_at,
       created_at,
       updated_at
     from public.coordinator_nodes
     where node_id = any($1::text[])
     order by array_position($1::text[], node_id)`,
    [CLUSTER_NODE_IDS]
  );

  return result.rows.map(toNode);
}

async function loadNode(nodeId, client) {
  const result = await runQuery(
    client,
    `select
       node_id,
       role,
       status,
       current_term,
       voted_for,
       last_heartbeat_at,
       last_seen_at,
       created_at,
       updated_at
     from public.coordinator_nodes
     where node_id = $1
     limit 1`,
    [nodeId]
  );

  if (result.rowCount === 0) {
    throw new ApiError(404, "Coordinator node not found");
  }

  return toNode(result.rows[0]);
}

async function getHighestTerm(client) {
  const result = await runQuery(
    client,
    `select greatest(
       coalesce((select max(current_term) from public.coordinator_nodes), 0),
       coalesce((select max(term) from public.leader_terms), 0)
     )::int as term`
  );

  return Number(result.rows[0].term || 0);
}

async function getHealthyLeader(client) {
  const result = await runQuery(
    client,
    `select
       node_id,
       role,
       status,
       current_term,
       voted_for,
       last_heartbeat_at,
       last_seen_at,
       created_at,
       updated_at
     from public.coordinator_nodes
     where node_id = any($1::text[])
     and role = 'leader'
     and status = 'healthy'
     order by current_term desc, last_heartbeat_at desc nulls last, updated_at desc
     limit 1`,
    [CLUSTER_NODE_IDS]
  );

  return result.rowCount === 0 ? null : toNode(result.rows[0]);
}

async function getAppendAuthority(client, requireLeader) {
  const leader = await getHealthyLeader(client);

  if (leader) {
    return {
      leader_id: leader.node_id,
      term: Number(leader.current_term || 0),
      synthetic: false
    };
  }

  if (requireLeader) {
    throw new ApiError(409, "No healthy leader is available. Start an election first.", {
      message: "No healthy leader is available. Start an election first.",
      code: "NO_HEALTHY_LEADER"
    });
  }

  const nodes = await loadClusterNodes(client);
  const fallbackNode =
    nodes.find((node) => node.node_id === NODE_ID && isHealthyParticipant(node)) ||
    nodes.find((node) => isHealthyParticipant(node));

  if (!fallbackNode) {
    throw new ApiError(409, "No healthy coordinator node is available", {
      message: "No healthy coordinator node is available",
      code: "NO_HEALTHY_COORDINATOR_NODE"
    });
  }

  return {
    leader_id: fallbackNode.node_id,
    term: Math.max(Number(fallbackNode.current_term || 0), await getHighestTerm(client)),
    synthetic: true
  };
}

async function getFaultToleranceState(client) {
  const nodes = await loadClusterNodes(client);
  const math = clusterMath(nodes.length);
  const healthyNodes = nodes.filter((node) => node.status === "healthy" && node.role !== "crashed");
  const crashedNodes = nodes.filter((node) => node.status === "crashed" || node.role === "crashed");
  const quorumAvailable = healthyNodes.length >= math.quorum;

  return {
    failure_model: "crash-recovery",
    cluster_size: math.cluster_size,
    quorum: math.quorum,
    tolerated_faults: math.tolerated_faults,
    crashed_nodes: crashedNodes.map((node) => node.node_id),
    healthy_nodes: healthyNodes.map((node) => node.node_id),
    safety_status: "maintained",
    liveness_status: quorumAvailable ? "maintained" : "unavailable",
    explanation: quorumAvailable
      ? "A majority of coordinator nodes is healthy, so the cluster can commit new transitions."
      : "Safety is maintained, but the cluster cannot commit new transitions without a majority.",
    nodes
  };
}

async function getInfrastructureTopology() {
  const result = await query(
    `select
       id,
       service_name,
       service_type,
       replicas,
       database_name,
       region,
       availability_zone,
       estimated_rps,
       status,
       created_at
     from public.infrastructure_topology
     order by service_name asc`
  );

  return result.rows;
}

function buildCapacitySummary(topology) {
  const math = clusterMath(CLUSTER_NODE_IDS.length);
  const databases = new Set(
    topology
      .map((service) => service.database_name)
      .filter(Boolean)
  );

  return {
    total_services: topology.length,
    total_databases: databases.size,
    coordinator_cluster_size: math.cluster_size,
    quorum_size: math.quorum,
    tolerated_crash_failures: math.tolerated_faults,
    estimated_users: ESTIMATED_USERS,
    peak_concurrent_users: PEAK_CONCURRENT_USERS,
    estimated_qr_validations_per_min: ESTIMATED_QR_VALIDATIONS_PER_MINUTE,
    estimated_booking_requests_per_min: ESTIMATED_BOOKING_REQUESTS_PER_MINUTE,
    total_estimated_rps: topology.reduce((sum, service) => sum + Number(service.estimated_rps || 0), 0)
  };
}

async function getClusterPayload(client) {
  const nodes = await loadClusterNodes(client);
  const leader = await getHealthyLeader(client);
  const latestTerm = await getHighestTerm(client);
  const math = clusterMath(nodes.length);

  return {
    local_node_id: NODE_ID,
    configured_node_ids: CLUSTER_NODE_IDS,
    cluster_size: math.cluster_size,
    quorum: math.quorum,
    tolerated_faults: math.tolerated_faults,
    current_term: latestTerm,
    leader: leader
      ? {
          node_id: leader.node_id,
          term: leader.current_term,
          last_heartbeat_at: leader.last_heartbeat_at
        }
      : null,
    nodes
  };
}

async function createSyncBroadcastInTransaction(client, options) {
  const eventType = normalizeEventType(options.eventType);
  const payload = normalizeJsonObject(options.payload || {}, "payload");
  const bookingId = normalizeOptionalString(options.bookingId, "booking_id", 255);
  const orderingType = options.orderingType || "total";
  const authority = await getAppendAuthority(client, true);
  const nodes = await loadClusterNodes(client);
  const math = clusterMath(nodes.length);
  const broadcastPayload = {
    booking_id: bookingId,
    rsm_id: options.rsmId || null,
    payload
  };
  const broadcastResult = await runClientQuery(
    client,
    `insert into public.broadcast_messages (
       mode,
       leader_id,
       term,
       event_type,
       payload,
       required_acks,
       result
     )
     values ('synchronous', $1, $2, $3, $4::jsonb, $5, 'pending')
     returning id, mode, leader_id, term, event_type, payload, required_acks, received_acks, result, created_at, completed_at`,
    [
      authority.leader_id,
      authority.term,
      eventType,
      JSON.stringify(broadcastPayload),
      math.quorum
    ]
  );
  const broadcast = broadcastResult.rows[0];
  const logResult = await runClientQuery(
    client,
    `insert into public.replicated_log (
       term,
       leader_id,
       rsm_id,
       booking_id,
       event_type,
       payload,
       ordering_type,
       status,
       commit_quorum
     )
     values ($1, $2, $3, $4, $5, $6::jsonb, $7, 'pending', $8)
     returning
       log_index,
       term,
       leader_id,
       rsm_id,
       booking_id,
       event_type,
       payload,
       ordering_type,
       status,
       commit_quorum,
       ack_count,
       created_at,
       committed_at`,
    [
      authority.term,
      authority.leader_id,
      options.rsmId || null,
      bookingId,
      eventType,
      JSON.stringify(payload),
      orderingType,
      math.quorum
    ]
  );
  const log = logResult.rows[0];
  const ackMatrix = [];

  for (const node of nodes) {
    const healthy = isHealthyParticipant(node);
    const ackStatus = healthy ? "acked" : "timeout";
    const reason = healthy ? "Node acknowledged log index" : `Node is ${node.status}`;

    await runClientQuery(
      client,
      `insert into public.log_replication_acks (
         log_index,
         node_id,
         ack_status,
         reason
       )
       values ($1, $2, $3, $4)`,
      [log.log_index, node.node_id, ackStatus, reason]
    );

    await runClientQuery(
      client,
      `insert into public.broadcast_acks (
         broadcast_id,
         node_id,
         ack_status,
         reason
       )
       values ($1, $2, $3, $4)`,
      [broadcast.id, node.node_id, ackStatus, reason]
    );

    ackMatrix.push({
      node_id: node.node_id,
      role: node.role,
      node_status: node.status,
      ack_status: ackStatus,
      log_index: log.log_index,
      reason
    });
  }

  const receivedAcks = ackMatrix.filter((ack) => ack.ack_status === "acked").length;
  const resultStatus = receivedAcks >= math.quorum ? "committed" : "rejected";
  const updatedLogResult = await runClientQuery(
    client,
    `update public.replicated_log
     set status = $1,
         ack_count = $2,
         committed_at = case when $1 = 'committed' then now() else committed_at end
     where log_index = $3
     returning
       log_index,
       term,
       leader_id,
       rsm_id,
       booking_id,
       event_type,
       payload,
       ordering_type,
       status,
       commit_quorum,
       ack_count,
       created_at,
       committed_at`,
    [resultStatus, receivedAcks, log.log_index]
  );

  await runClientQuery(
    client,
    `update public.broadcast_messages
     set result = $1,
         received_acks = $2,
         completed_at = now()
     where id = $3`,
    [resultStatus, receivedAcks, broadcast.id]
  );

  return {
    mode: "synchronous",
    broadcast_id: broadcast.id,
    log_index: log.log_index,
    leader_id: authority.leader_id,
    term: authority.term,
    quorum: math.quorum,
    received_acks: receivedAcks,
    ack_matrix: ackMatrix,
    result: resultStatus,
    log: toLog(updatedLogResult.rows[0])
  };
}

async function appendRejectedCausalLogInTransaction(client, options) {
  const eventType = normalizeEventType(options.eventType);
  const payload = normalizeJsonObject(options.payload || {}, "payload");
  const authority = await getAppendAuthority(client, false);
  const math = clusterMath(CLUSTER_NODE_IDS.length);
  const result = await runClientQuery(
    client,
    `insert into public.replicated_log (
       term,
       leader_id,
       rsm_id,
       booking_id,
       event_type,
       payload,
       ordering_type,
       status,
       commit_quorum,
       ack_count
     )
     values ($1, $2, $3, $4, $5, $6::jsonb, 'causal', 'rejected', $7, 0)
     returning
       log_index,
       term,
       leader_id,
       rsm_id,
       booking_id,
       event_type,
       payload,
       ordering_type,
       status,
       commit_quorum,
       ack_count,
       created_at,
       committed_at`,
    [
      authority.term,
      authority.leader_id,
      options.rsmId || null,
      options.bookingId || null,
      eventType,
      JSON.stringify({
        ...payload,
        error_code: "CAUSAL_ORDER_VIOLATION",
        rejection_reason: options.reason || "CAUSAL_ORDER_VIOLATION"
      }),
      math.quorum
    ]
  );

  return toLog(result.rows[0]);
}

async function refreshReplicationCommit(client, logIndex) {
  const ackResult = await runClientQuery(
    client,
    `select count(*)::int as ack_count
     from public.log_replication_acks
     where log_index = $1
     and ack_status = 'acked'`,
    [logIndex]
  );
  const ackCount = Number(ackResult.rows[0].ack_count || 0);
  const updatedResult = await runClientQuery(
    client,
    `update public.replicated_log
     set ack_count = $1,
         status = case
           when status = 'pending' and $1 >= commit_quorum then 'committed'
           else status
         end,
         committed_at = case
           when status = 'pending' and $1 >= commit_quorum then now()
           else committed_at
         end
     where log_index = $2
     returning
       log_index,
       term,
       leader_id,
       rsm_id,
       booking_id,
       event_type,
       payload,
       ordering_type,
       status,
       commit_quorum,
       ack_count,
       created_at,
       committed_at`,
    [ackCount, logIndex]
  );

  return updatedResult.rowCount === 0 ? null : toLog(updatedResult.rows[0]);
}

async function refreshBroadcastCommit(client, broadcastId) {
  if (!broadcastId) {
    return null;
  }

  const ackResult = await runClientQuery(
    client,
    `select count(*)::int as ack_count
     from public.broadcast_acks
     where broadcast_id = $1
     and ack_status = 'acked'`,
    [broadcastId]
  );
  const ackCount = Number(ackResult.rows[0].ack_count || 0);
  const updatedResult = await runClientQuery(
    client,
    `update public.broadcast_messages
     set received_acks = $1,
         result = case
           when result = 'pending' and $1 >= required_acks then 'committed'
           else result
         end,
         completed_at = case
           when result = 'pending' and $1 >= required_acks then now()
           else completed_at
         end
     where id = $2
     returning
       id,
       mode,
       leader_id,
       term,
       event_type,
       payload,
       required_acks,
       received_acks,
       result,
       created_at,
       completed_at`,
    [ackCount, broadcastId]
  );

  return updatedResult.rowCount === 0 ? null : updatedResult.rows[0];
}

async function getOutboxCounts(client) {
  const result = await runQuery(
    client,
    `select status, count(*)::int as count
     from public.consensus_outbox
     group by status`
  );
  const counts = {
    pending: 0,
    delivered: 0,
    retrying: 0,
    failed: 0
  };

  for (const row of result.rows) {
    counts[row.status] = Number(row.count || 0);
  }

  return counts;
}

app.get("/health", (req, res) => {
  res.json({
    service: "coordinator-service",
    status: "healthy",
    node_id: NODE_ID,
    cluster_node_ids: CLUSTER_NODE_IDS,
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime())
  });
});

app.get(
  "/health/deep",
  asyncHandler(async (req, res) => {
    let database;

    try {
      const connection = await checkDatabaseConnection();
      const schema = await checkRequiredSchema();

      database = {
        ...connection,
        schema
      };
    } catch {
      database = {
        status: "down",
        latencyMs: 0,
        schema: {
          status: "unknown"
        },
        error: "Coordinator database is unavailable"
      };
    }

    const isHealthy =
      database.status === "up" &&
      database.schema &&
      database.schema.status === "ready";

    return res.status(isHealthy ? 200 : 503).json({
      service: "coordinator-service",
      node_id: NODE_ID,
      status: isHealthy ? "healthy" : "degraded",
      database,
      cluster: {
        node_ids: CLUSTER_NODE_IDS,
        quorum: clusterMath(CLUSTER_NODE_IDS.length).quorum
      },
      timestamp: new Date().toISOString()
    });
  })
);

app.get(
  "/infrastructure/topology",
  asyncHandler(async (req, res) => {
    const topology = await getInfrastructureTopology();

    return res.json({
      data: topology
    });
  })
);

app.get(
  "/infrastructure/capacity",
  asyncHandler(async (req, res) => {
    const topology = await getInfrastructureTopology();

    return res.json({
      data: buildCapacitySummary(topology)
    });
  })
);

app.get(
  "/infrastructure/summary",
  asyncHandler(async (req, res) => {
    const topology = await getInfrastructureTopology();
    const capacity = buildCapacitySummary(topology);

    return res.json({
      data: {
        ...capacity,
        topology
      }
    });
  })
);

app.get(
  "/fault-tolerance",
  asyncHandler(async (req, res) => {
    return res.json({
      data: await getFaultToleranceState()
    });
  })
);

app.post(
  "/nodes/:nodeId/crash",
  asyncHandler(async (req, res) => {
    const nodeId = normalizeNodeId(req.params.nodeId);
    const reason = normalizeOptionalString(req.body.reason, "reason", 500) || "manual fault injection";
    const result = await withTransaction(async (client) => {
      const before = await loadNode(nodeId, client);

      await runClientQuery(
        client,
        `update public.coordinator_nodes
         set role = 'crashed',
             status = 'crashed',
             last_seen_at = now(),
             voted_for = null
         where node_id = $1`,
        [nodeId]
      );

      const faultState = await getFaultToleranceState(client);

      await runClientQuery(
        client,
        `insert into public.fault_injection_events (
           node_id,
           event_type,
           reason,
           system_safety,
           system_liveness
         )
         values ($1, 'crash', $2, $3, $4)`,
        [nodeId, reason, faultState.safety_status, faultState.liveness_status]
      );

      return {
        crashed_node_id: nodeId,
        was_leader: before.role === "leader",
        election_required: before.role === "leader",
        fault_tolerance: faultState
      };
    });

    return res.json({
      message: "Coordinator node marked as crashed",
      data: result
    });
  })
);

app.post(
  "/nodes/:nodeId/recover",
  asyncHandler(async (req, res) => {
    const nodeId = normalizeNodeId(req.params.nodeId);
    const reason = normalizeOptionalString(req.body.reason, "reason", 500) || "manual recovery";
    const result = await withTransaction(async (client) => {
      await runClientQuery(
        client,
        `update public.coordinator_nodes
         set role = 'recovering',
             status = 'recovering',
             voted_for = null,
             last_seen_at = now()
         where node_id = $1`,
        [nodeId]
      );

      await runClientQuery(
        client,
        `update public.coordinator_nodes
         set role = 'follower',
             status = 'healthy',
             voted_for = null,
             last_seen_at = now()
         where node_id = $1`,
        [nodeId]
      );

      const faultState = await getFaultToleranceState(client);

      await runClientQuery(
        client,
        `insert into public.fault_injection_events (
           node_id,
           event_type,
           reason,
           system_safety,
           system_liveness
         )
         values ($1, 'recover', $2, $3, $4)`,
        [nodeId, reason, faultState.safety_status, faultState.liveness_status]
      );

      return {
        recovered_node_id: nodeId,
        recovery_steps: ["recovering", "follower"],
        catch_up_available: true,
        fault_tolerance: faultState
      };
    });

    return res.json({
      message: "Coordinator node recovered as follower",
      data: result
    });
  })
);

app.get(
  "/cluster",
  asyncHandler(async (req, res) => {
    return res.json({
      data: await getClusterPayload()
    });
  })
);

app.get(
  "/leader",
  asyncHandler(async (req, res) => {
    const leader = await getHealthyLeader();
    const term = await getHighestTerm();

    return res.json({
      data: {
        healthy_leader: Boolean(leader),
        leader: leader
          ? {
              node_id: leader.node_id,
              term: leader.current_term,
              last_heartbeat_at: leader.last_heartbeat_at
            }
          : null,
        term,
        explanation: leader
          ? "A healthy leader is available for consensus writes."
          : "No healthy leader is available. Start an election to restore liveness."
      }
    });
  })
);

app.post(
  "/election/start",
  asyncHandler(async (req, res) => {
    const result = await withTransaction(async (client) => {
      const nodes = await loadClusterNodes(client);
      const requestedCandidateId = req.body.candidate_id ? normalizeNodeId(req.body.candidate_id) : null;
      
      // Check if current leader is crashed/unhealthy and clear if so
      const currentLeader = await getHealthyLeader(client);
      if (!currentLeader) {
        // No healthy leader; check if there's a stale leader record that should be cleared
        const staleLeaderResult = await runClientQuery(
          client,
          `select node_id, role, status from public.coordinator_nodes
           where role = 'leader' and (status != 'healthy' or status = 'crashed')
           limit 1`,
          []
        );
        if (staleLeaderResult.rowCount > 0) {
          const staleLeader = staleLeaderResult.rows[0];
          // Clear stale leader by demoting to follower
          await runClientQuery(
            client,
            `update public.coordinator_nodes
             set role = 'follower'
             where node_id = $1 and status != 'healthy'`,
            [staleLeader.node_id]
          );
        }
      }

      // Select candidate: use requested, fallback to NODE_ID if healthy, or first healthy node
      let candidateId = requestedCandidateId;
      if (!candidateId) {
        const candidate = nodes.find((node) => node.node_id === NODE_ID && isHealthyParticipant(node));
        if (candidate) {
          candidateId = NODE_ID;
        } else {
          // Auto-select first healthy node
          const healthyNode = nodes.find(isHealthyParticipant);
          if (!healthyNode) {
            throw new ApiError(409, "No healthy coordinator nodes are available for election", {
              message: "No healthy coordinator nodes are available for election",
              available_nodes: nodes.map((n) => ({
                node_id: n.node_id,
                status: n.status,
                role: n.role
              }))
            });
          }
          candidateId = healthyNode.node_id;
        }
      }

      const candidate = nodes.find((node) => node.node_id === candidateId);
      if (!candidate || !isHealthyParticipant(candidate)) {
        throw new ApiError(409, "Candidate must be a healthy non-crashed node", {
          message: "Candidate must be a healthy non-crashed node",
          candidate_id: candidateId,
          requested_candidate: requestedCandidateId || NODE_ID,
          available_healthy_nodes: nodes.filter(isHealthyParticipant).map((n) => n.node_id),
          all_nodes: nodes.map((n) => ({
            node_id: n.node_id,
            status: n.status,
            role: n.role
          }))
        });
      }

      const math = clusterMath(nodes.length);
      const term = (await getHighestTerm(client)) + 1;
      const participatingNodes = nodes.filter(isHealthyParticipant);
      const nonParticipatingNodes = nodes
        .filter((node) => !isHealthyParticipant(node))
        .map((node) => ({
          node_id: node.node_id,
          status: node.status,
          role: node.role,
          reason: "Node is not healthy"
        }));
      const votes = [];

      for (const node of participatingNodes) {
        const vote = {
          term,
          candidate_id: candidateId,
          voter_id: node.node_id,
          granted: true,
          reason: node.node_id === candidateId ? "self vote" : "healthy follower grants vote"
        };

        await runClientQuery(
          client,
          `insert into public.leader_votes (
             term,
             candidate_id,
             voter_id,
             granted,
             reason
           )
           values ($1, $2, $3, $4, $5)
           on conflict (term, voter_id)
           do update set
             candidate_id = excluded.candidate_id,
             granted = excluded.granted,
             reason = excluded.reason`,
          [vote.term, vote.candidate_id, vote.voter_id, vote.granted, vote.reason]
        );

        votes.push(vote);
      }

      const grantedVotes = votes.filter((vote) => vote.granted).length;
      const won = grantedVotes >= math.quorum;

      if (won) {
        await runClientQuery(
          client,
          `update public.coordinator_nodes
           set current_term = $1,
               voted_for = case when status = 'healthy' then $2 else voted_for end,
               role = case
                 when node_id = $2 then 'leader'
                 when status = 'healthy' then 'follower'
                 else role
               end,
               last_seen_at = case when status = 'healthy' then now() else last_seen_at end
           where node_id = any($3::text[])`,
          [term, candidateId, CLUSTER_NODE_IDS]
        );

        await runClientQuery(
          client,
          `insert into public.leader_terms (
             term,
             leader_id,
             reason
           )
           values ($1, $2, $3)`,
          [term, candidateId, "majority vote"]
        );
      } else {
        await runClientQuery(
          client,
          `update public.coordinator_nodes
           set current_term = $1,
               voted_for = case when status = 'healthy' then $2 else voted_for end,
               role = case
                 when node_id = $2 then 'candidate'
                 when status = 'healthy' and role = 'leader' then 'follower'
                 else role
               end,
               last_seen_at = case when status = 'healthy' then now() else last_seen_at end
           where node_id = any($3::text[])`,
          [term, candidateId, CLUSTER_NODE_IDS]
        );
      }

      return {
        term,
        candidate: candidateId,
        votes,
        non_participating_nodes: nonParticipatingNodes,
        granted_votes: grantedVotes,
        quorum: math.quorum,
        result: won ? "leader_elected" : "election_failed",
        new_leader: won ? candidateId : null,
        election_reason: requestedCandidateId ? "manual" : "auto-selected",
        candidate_auto_selected: !requestedCandidateId
      };
    });

    return res.status(result.new_leader ? 201 : 409).json({
      message: result.new_leader 
        ? `Leader elected: ${result.candidate} (term ${result.term})` 
        : "Election failed: insufficient quorum",
      data: result
    });
  })
);

app.post(
  "/election/heartbeat",
  asyncHandler(async (req, res) => {
    const requestedLeaderId = normalizeOptionalString(req.body.leader_id, "leader_id", 120);
    const result = await withTransaction(async (client) => {
      const leader = requestedLeaderId
        ? await loadNode(normalizeNodeId(requestedLeaderId), client)
        : await getHealthyLeader(client);

      if (!leader || leader.role !== "leader" || leader.status !== "healthy") {
        throw new ApiError(409, "Heartbeat requires a healthy leader", {
          message: "Heartbeat requires a healthy leader",
          code: "NO_HEALTHY_LEADER"
        });
      }

      const nodes = await loadClusterNodes(client);
      const heartbeats = [];

      await runClientQuery(
        client,
        `update public.coordinator_nodes
         set last_heartbeat_at = now(),
             last_seen_at = now()
         where node_id = $1`,
        [leader.node_id]
      );

      for (const node of nodes.filter((item) => item.node_id !== leader.node_id)) {
        const status = isHealthyParticipant(node) ? "received" : "timeout";

        await runClientQuery(
          client,
          `insert into public.heartbeats (
             term,
             leader_id,
             follower_id,
             status
           )
           values ($1, $2, $3, $4)`,
          [leader.current_term, leader.node_id, node.node_id, status]
        );

        if (status === "received") {
          await runClientQuery(
            client,
            `update public.coordinator_nodes
             set last_heartbeat_at = now(),
                 last_seen_at = now()
             where node_id = $1`,
            [node.node_id]
          );
        }

        heartbeats.push({
          follower_id: node.node_id,
          status
        });
      }

      return {
        leader_id: leader.node_id,
        term: leader.current_term,
        heartbeats
      };
    });

    return res.json({
      message: "Heartbeat recorded",
      data: result
    });
  })
);

app.post(
  "/election/step-down",
  asyncHandler(async (req, res) => {
    const result = await withTransaction(async (client) => {
      const requestedLeaderId = normalizeOptionalString(req.body.leader_id, "leader_id", 120);
      const leader = requestedLeaderId
        ? await loadNode(normalizeNodeId(requestedLeaderId), client)
        : await getHealthyLeader(client);

      if (!leader || leader.role !== "leader") {
        throw new ApiError(409, "No leader can step down", {
          message: "No leader can step down",
          code: "NO_LEADER"
        });
      }

      await runClientQuery(
        client,
        `update public.coordinator_nodes
         set role = 'follower',
             voted_for = null,
             last_seen_at = now()
         where node_id = $1
         and status = 'healthy'`,
        [leader.node_id]
      );

      return {
        stepped_down: leader.node_id,
        term: leader.current_term,
        next_action: "POST /election/start"
      };
    });

    return res.json({
      message: "Leader stepped down",
      data: result
    });
  })
);

app.get(
  "/ordering/model",
  asyncHandler(async (req, res) => {
    const latestLogResult = await query("select coalesce(max(log_index), 0) as latest_log_index from public.replicated_log");

    return res.json({
      data: {
        fifo: {
          description: "Per-booking messages carry monotonically increasing sequence_number values.",
          proof_endpoint: "POST /ordering/fifo/demo"
        },
        causal: {
          description: "RSM transitions are accepted only when they follow the allowed transition map.",
          violation_code: "CAUSAL_ORDER_VIOLATION",
          allowed_transitions: allowedTransitions,
          proof_endpoint: "POST /ordering/causal/validate"
        },
        total: {
          description: "Committed events are ordered by replicated_log.log_index and acknowledged by the coordinator nodes.",
          latest_log_index: latestLogResult.rows[0].latest_log_index,
          proof_endpoint: "GET /ordering/total/log"
        }
      }
    });
  })
);

app.post(
  "/ordering/fifo/demo",
  asyncHandler(async (req, res) => {
    const bookingId =
      normalizeOptionalString(req.body.booking_id, "booking_id", 255) ||
      `booking-fifo-${Date.now()}`;
    const eventTypes = Array.isArray(req.body.event_types) && req.body.event_types.length > 0
      ? req.body.event_types.map(normalizeEventType)
      : ["NOTIFICATION_PENDING", "NOTIFICATION_SENT", "COMPLETED"];
    const payload = normalizeJsonObject(req.body.payload || {}, "payload");
    const result = await withTransaction(async (client) => {
      const authority = await getAppendAuthority(client, false);
      const nodes = await loadClusterNodes(client);
      const healthyNodes = nodes.filter(isHealthyParticipant);
      const math = clusterMath(nodes.length);
      const status = healthyNodes.length >= math.quorum ? "committed" : "rejected";
      const entries = [];

      for (let index = 0; index < eventTypes.length; index += 1) {
        const sequenceNumber = index + 1;
        const logResult = await runClientQuery(
          client,
          `insert into public.replicated_log (
             term,
             leader_id,
             booking_id,
             event_type,
             payload,
             ordering_type,
             status,
             commit_quorum,
             ack_count,
             committed_at
           )
           values ($1, $2, $3, $4, $5::jsonb, 'fifo', $6, $7, $8, case when $6 = 'committed' then now() else null end)
           returning
             log_index,
             term,
             leader_id,
             rsm_id,
             booking_id,
             event_type,
             payload,
             ordering_type,
             status,
             commit_quorum,
             ack_count,
             created_at,
             committed_at`,
          [
            authority.term,
            authority.leader_id,
            bookingId,
            eventTypes[index],
            JSON.stringify({
              ...payload,
              booking_id: bookingId,
              sequence_number: sequenceNumber
            }),
            status,
            math.quorum,
            healthyNodes.length
          ]
        );

        for (const node of nodes) {
          await runClientQuery(
            client,
            `insert into public.log_replication_acks (
               log_index,
               node_id,
               ack_status,
               reason
             )
             values ($1, $2, $3, $4)`,
            [
              logResult.rows[0].log_index,
              node.node_id,
              isHealthyParticipant(node) ? "acked" : "timeout",
              isHealthyParticipant(node) ? "FIFO demo ack" : `Node is ${node.status}`
            ]
          );
        }

        entries.push(toLog(logResult.rows[0]));
      }

      return {
        booking_id: bookingId,
        ordering_type: "fifo",
        expected_sequence: eventTypes.map((eventType, index) => ({
          sequence_number: index + 1,
          event_type: eventType
        })),
        committed: status === "committed",
        entries
      };
    });

    return res.status(201).json({
      message: "FIFO ordering demo appended",
      data: result
    });
  })
);

app.post(
  "/ordering/causal/validate",
  asyncHandler(async (req, res) => {
    const eventType = normalizeEventType(req.body.event_type);
    const rsmId = req.body.rsm_id ? assertUuid(req.body.rsm_id, "rsm_id") : null;
    const payload = normalizeJsonObject(req.body.payload || {}, "payload");
    const result = await withTransaction(async (client) => {
      let rsm = null;
      let currentState = String(req.body.current_state || "INIT").trim().toUpperCase();
      let bookingId = normalizeOptionalString(req.body.booking_id, "booking_id", 255);

      if (rsmId) {
        const rsmResult = await runClientQuery(
          client,
          `select rsm_id, booking_id, current_state, version, status, created_at, updated_at
           from public.rsm_instances
           where rsm_id = $1
           limit 1`,
          [rsmId]
        );

        if (rsmResult.rowCount === 0) {
          throw new ApiError(404, "RSM instance not found");
        }

        rsm = toRsm(rsmResult.rows[0]);
        currentState = rsm.current_state;
        bookingId = rsm.booking_id;
      }

      const validation = validateTransition(currentState, eventType);

      if (!validation.valid) {
        const rejectedLog = await appendRejectedCausalLogInTransaction(client, {
          rsmId,
          bookingId,
          eventType,
          payload,
          reason: "CAUSAL_ORDER_VIOLATION"
        });

        if (rsmId) {
          await runClientQuery(
            client,
            `insert into public.rsm_transitions (
               rsm_id,
               log_index,
               from_state,
               to_state,
               event_type,
               valid,
               rejection_reason,
               term,
               committed_by_leader
             )
             values ($1, $2, $3, $4, $5, false, 'CAUSAL_ORDER_VIOLATION', $6, $7)`,
            [
              rsmId,
              rejectedLog.log_index,
              validation.from_state,
              validation.to_state,
              eventType,
              rejectedLog.term,
              rejectedLog.leader_id
            ]
          );
        }

        return {
          valid: false,
          code: "CAUSAL_ORDER_VIOLATION",
          validation,
          log: rejectedLog
        };
      }

      return {
        valid: true,
        validation,
        rsm
      };
    });

    if (!result.valid) {
      return res.status(409).json({
        message: "CAUSAL_ORDER_VIOLATION",
        error_code: "CAUSAL_ORDER_VIOLATION",
        data: result
      });
    }

    return res.json({
      data: result
    });
  })
);

app.get(
  "/ordering/total/log",
  asyncHandler(async (req, res) => {
    const limit = parseIntegerQuery(req.query.limit, "limit", 100, { min: 1, max: 500 });
    const result = await query(
      `select
         l.log_index,
         l.term,
         l.leader_id,
         l.rsm_id,
         l.booking_id,
         l.event_type,
         l.payload,
         l.ordering_type,
         l.status,
         l.commit_quorum,
         l.ack_count,
         l.created_at,
         l.committed_at,
         coalesce(
           jsonb_agg(
             jsonb_build_object(
               'node_id', a.node_id,
               'ack_status', a.ack_status,
               'reason', a.reason,
               'created_at', a.created_at
             )
             order by a.node_id
           ) filter (where a.id is not null),
           '[]'::jsonb
         ) as acks
       from public.replicated_log l
       left join public.log_replication_acks a on a.log_index = l.log_index
       group by l.log_index
       order by l.log_index asc
       limit $1`,
      [limit]
    );

    return res.json({
      data: result.rows.map(toLog)
    });
  })
);

app.post(
  "/broadcast/sync",
  asyncHandler(async (req, res) => {
    const result = await withTransaction((client) => createSyncBroadcastInTransaction(client, {
      eventType: req.body.event_type,
      bookingId: req.body.booking_id,
      payload: req.body.payload || {},
      orderingType: "total"
    }));

    return res.status(201).json({
      message: "Synchronous broadcast completed",
      data: result
    });
  })
);

app.post(
  "/broadcast/async",
  asyncHandler(async (req, res) => {
    const eventType = normalizeEventType(req.body.event_type);
    const bookingId = normalizeOptionalString(req.body.booking_id, "booking_id", 255);
    const payload = normalizeJsonObject(req.body.payload || {}, "payload");
    const result = await withTransaction(async (client) => {
      const authority = await getAppendAuthority(client, true);
      const nodes = await loadClusterNodes(client);
      const math = clusterMath(nodes.length);
      const broadcastPayload = {
        booking_id: bookingId,
        payload
      };
      const broadcastResult = await runClientQuery(
        client,
        `insert into public.broadcast_messages (
           mode,
           leader_id,
           term,
           event_type,
           payload,
           required_acks,
           received_acks,
           result
         )
         values ('asynchronous', $1, $2, $3, $4::jsonb, $5, 1, case when 1 >= $5 then 'committed' else 'pending' end)
         returning id, mode, leader_id, term, event_type, payload, required_acks, received_acks, result, created_at, completed_at`,
        [
          authority.leader_id,
          authority.term,
          eventType,
          JSON.stringify(broadcastPayload),
          math.quorum
        ]
      );
      const broadcast = broadcastResult.rows[0];
      const logResult = await runClientQuery(
        client,
        `insert into public.replicated_log (
           term,
           leader_id,
           booking_id,
           event_type,
           payload,
           ordering_type,
           status,
           commit_quorum,
           ack_count,
           committed_at
         )
         values ($1, $2, $3, $4, $5::jsonb, 'total', case when 1 >= $6 then 'committed' else 'pending' end, $6, 1, case when 1 >= $6 then now() else null end)
         returning
           log_index,
           term,
           leader_id,
           rsm_id,
           booking_id,
           event_type,
           payload,
           ordering_type,
           status,
           commit_quorum,
           ack_count,
           created_at,
           committed_at`,
        [
          authority.term,
          authority.leader_id,
          bookingId,
          eventType,
          JSON.stringify(payload),
          math.quorum
        ]
      );
      const log = logResult.rows[0];

      await runClientQuery(
        client,
        `insert into public.log_replication_acks (
           log_index,
           node_id,
           ack_status,
           reason
         )
         values ($1, $2, 'acked', 'Leader append')`,
        [log.log_index, authority.leader_id]
      );

      await runClientQuery(
        client,
        `insert into public.broadcast_acks (
           broadcast_id,
           node_id,
           ack_status,
           reason
         )
         values ($1, $2, 'acked', 'Leader append')`,
        [broadcast.id, authority.leader_id]
      );

      for (const node of nodes.filter((item) => item.node_id !== authority.leader_id)) {
        await runClientQuery(
          client,
          `insert into public.consensus_outbox (
             log_index,
             target_node_id,
             message_type,
             payload,
             status
           )
           values ($1, $2, 'APPEND_ENTRIES', $3::jsonb, 'pending')`,
          [
            log.log_index,
            node.node_id,
            JSON.stringify({
              broadcast_id: broadcast.id,
              log_index: log.log_index,
              term: authority.term,
              leader_id: authority.leader_id,
              event_type: eventType,
              booking_id: bookingId,
              payload
            })
          ]
        );
      }

      return {
        mode: "asynchronous",
        broadcast_id: broadcast.id,
        log_index: log.log_index,
        leader_id: authority.leader_id,
        term: authority.term,
        quorum: math.quorum,
        received_acks: 1,
        result: log.status,
        outbox: await getOutboxCounts(client)
      };
    });

    return res.status(202).json({
      message: "Asynchronous broadcast queued",
      data: result
    });
  })
);

app.get(
  "/outbox",
  asyncHandler(async (req, res) => {
    const limit = parseIntegerQuery(req.query.limit, "limit", 100, { min: 1, max: 500 });
    const result = await query(
      `select
         id,
         log_index,
         target_node_id,
         message_type,
         payload,
         status,
         retry_count,
         last_error,
         created_at,
         processed_at
       from public.consensus_outbox
       order by created_at desc
       limit $1`,
      [limit]
    );

    return res.json({
      data: {
        counts: await getOutboxCounts(),
        items: result.rows.map(toOutbox)
      }
    });
  })
);

app.post(
  "/outbox/process",
  asyncHandler(async (req, res) => {
    const limit = parseIntegerQuery(req.body.limit, "limit", 50, { min: 1, max: 500 });
    const result = await withTransaction(async (client) => {
      const itemsResult = await runClientQuery(
        client,
        `select
           id,
           log_index,
           target_node_id,
           message_type,
           payload,
           status,
           retry_count,
           last_error,
           created_at,
           processed_at
         from public.consensus_outbox
         where status in ('pending', 'retrying')
         order by created_at asc
         limit $1`,
        [limit]
      );
      const nodes = await loadClusterNodes(client);
      const nodesById = new Map(nodes.map((node) => [node.node_id, node]));
      const processed = [];
      const affectedLogIndexes = new Set();
      const affectedBroadcastIds = new Set();

      for (const item of itemsResult.rows.map(toOutbox)) {
        const targetNode = nodesById.get(item.target_node_id);
        const payload = item.payload || {};

        if (targetNode && isHealthyParticipant(targetNode)) {
          await runClientQuery(
            client,
            `update public.consensus_outbox
             set status = 'delivered',
                 last_error = null,
                 processed_at = now()
             where id = $1`,
            [item.id]
          );

          await runClientQuery(
            client,
            `insert into public.log_replication_acks (
               log_index,
               node_id,
               ack_status,
               reason
             )
             values ($1, $2, 'acked', 'Delivered from asynchronous outbox')
             on conflict (log_index, node_id)
             do update set
               ack_status = 'acked',
               reason = excluded.reason,
               created_at = now()`,
            [item.log_index, item.target_node_id]
          );

          if (payload.broadcast_id) {
            await runClientQuery(
              client,
              `insert into public.broadcast_acks (
                 broadcast_id,
                 node_id,
                 ack_status,
                 reason
               )
               values ($1, $2, 'acked', 'Delivered from asynchronous outbox')
               on conflict (broadcast_id, node_id)
               do update set
                 ack_status = 'acked',
                 reason = excluded.reason,
                 created_at = now()`,
              [payload.broadcast_id, item.target_node_id]
            );
            affectedBroadcastIds.add(payload.broadcast_id);
          }

          affectedLogIndexes.add(item.log_index);
          processed.push({
            id: item.id,
            target_node_id: item.target_node_id,
            status: "delivered"
          });
        } else {
          const lastError = targetNode
            ? `Target node is ${targetNode.status}`
            : "Target node is unknown";

          await runClientQuery(
            client,
            `update public.consensus_outbox
             set status = 'retrying',
                 retry_count = retry_count + 1,
                 last_error = $2
             where id = $1`,
            [item.id, lastError]
          );

          processed.push({
            id: item.id,
            target_node_id: item.target_node_id,
            status: "retrying",
            last_error: lastError
          });
        }
      }

      const committedLogs = [];
      const updatedBroadcasts = [];

      for (const logIndex of affectedLogIndexes) {
        const updatedLog = await refreshReplicationCommit(client, logIndex);

        if (updatedLog) {
          committedLogs.push(updatedLog);
        }
      }

      for (const broadcastId of affectedBroadcastIds) {
        const updatedBroadcast = await refreshBroadcastCommit(client, broadcastId);

        if (updatedBroadcast) {
          updatedBroadcasts.push(updatedBroadcast);
        }
      }

      return {
        processed,
        logs: committedLogs,
        broadcasts: updatedBroadcasts,
        counts: await getOutboxCounts(client)
      };
    });

    return res.json({
      message: "Outbox process cycle completed",
      data: result
    });
  })
);

app.post(
  "/rsm/start",
  asyncHandler(async (req, res) => {
    const bookingId = assertRequiredString(req.body.booking_id, "booking_id", 255);
    const result = await query(
      `insert into public.rsm_instances (
         booking_id,
         current_state,
         status
       )
       values ($1, 'INIT', 'active')
       returning rsm_id, booking_id, current_state, version, status, created_at, updated_at`,
      [bookingId]
    );

    return res.status(201).json({
      message: "RSM instance started",
      data: toRsm(result.rows[0])
    });
  })
);

app.get(
  "/rsm",
  asyncHandler(async (req, res) => {
    const limit = parseIntegerQuery(req.query.limit, "limit", 50, { min: 1, max: 500 });
    const result = await query(
      `select rsm_id, booking_id, current_state, version, status, created_at, updated_at
       from public.rsm_instances
       order by created_at desc
       limit $1`,
      [limit]
    );

    return res.json({
      data: result.rows.map(toRsm)
    });
  })
);

app.get(
  "/rsm/:rsmId/transitions",
  asyncHandler(async (req, res) => {
    const rsmId = assertUuid(req.params.rsmId, "rsmId");
    const result = await query(
      `select
         transition_id,
         rsm_id,
         log_index,
         from_state,
         to_state,
         event_type,
         valid,
         rejection_reason,
         term,
         committed_by_leader,
         created_at
       from public.rsm_transitions
       where rsm_id = $1
       order by created_at asc`,
      [rsmId]
    );

    return res.json({
      data: result.rows.map(toTransition)
    });
  })
);

app.get(
  "/rsm/:rsmId",
  asyncHandler(async (req, res) => {
    const rsmId = assertUuid(req.params.rsmId, "rsmId");
    const result = await query(
      `select rsm_id, booking_id, current_state, version, status, created_at, updated_at
       from public.rsm_instances
       where rsm_id = $1
       limit 1`,
      [rsmId]
    );

    if (result.rowCount === 0) {
      throw new ApiError(404, "RSM instance not found");
    }

    return res.json({
      data: toRsm(result.rows[0])
    });
  })
);

app.post(
  "/rsm/:rsmId/transition",
  asyncHandler(async (req, res) => {
    const rsmId = assertUuid(req.params.rsmId, "rsmId");
    const eventType = normalizeEventType(req.body.event_type);
    const payload = normalizeJsonObject(req.body.payload || {}, "payload");
    const result = await withTransaction(async (client) => {
      const rsmResult = await runClientQuery(
        client,
        `select rsm_id, booking_id, current_state, version, status, created_at, updated_at
         from public.rsm_instances
         where rsm_id = $1
         limit 1
         for update`,
        [rsmId]
      );

      if (rsmResult.rowCount === 0) {
        throw new ApiError(404, "RSM instance not found");
      }

      const rsm = toRsm(rsmResult.rows[0]);

      if (rsm.status !== "active") {
        throw new ApiError(409, "RSM instance is not active", {
          message: "RSM instance is not active",
          data: rsm
        });
      }

      const validation = validateTransition(rsm.current_state, eventType);

      if (!validation.valid) {
        const rejectedLog = await appendRejectedCausalLogInTransaction(client, {
          rsmId,
          bookingId: rsm.booking_id,
          eventType,
          payload,
          reason: "CAUSAL_ORDER_VIOLATION"
        });

        const transitionResult = await runClientQuery(
          client,
          `insert into public.rsm_transitions (
             rsm_id,
             log_index,
             from_state,
             to_state,
             event_type,
             valid,
             rejection_reason,
             term,
             committed_by_leader
           )
           values ($1, $2, $3, $4, $5, false, 'CAUSAL_ORDER_VIOLATION', $6, $7)
           returning
             transition_id,
             rsm_id,
             log_index,
             from_state,
             to_state,
             event_type,
             valid,
             rejection_reason,
             term,
             committed_by_leader,
             created_at`,
          [
            rsmId,
            rejectedLog.log_index,
            validation.from_state,
            validation.to_state,
            eventType,
            rejectedLog.term,
            rejectedLog.leader_id
          ]
        );

        return {
          accepted: false,
          code: "CAUSAL_ORDER_VIOLATION",
          validation,
          transition: toTransition(transitionResult.rows[0]),
          log: rejectedLog
        };
      }

      const broadcast = await createSyncBroadcastInTransaction(client, {
        eventType,
        bookingId: rsm.booking_id,
        payload,
        rsmId,
        orderingType: "total"
      });

      if (broadcast.result !== "committed") {
        const transitionResult = await runClientQuery(
          client,
          `insert into public.rsm_transitions (
             rsm_id,
             log_index,
             from_state,
             to_state,
             event_type,
             valid,
             rejection_reason,
             term,
             committed_by_leader
           )
           values ($1, $2, $3, $4, $5, false, 'QUORUM_NOT_REACHED', $6, $7)
           returning
             transition_id,
             rsm_id,
             log_index,
             from_state,
             to_state,
             event_type,
             valid,
             rejection_reason,
             term,
             committed_by_leader,
             created_at`,
          [
            rsmId,
            broadcast.log_index,
            validation.from_state,
            validation.to_state,
            eventType,
            broadcast.term,
            broadcast.leader_id
          ]
        );

        return {
          accepted: false,
          code: "QUORUM_NOT_REACHED",
          validation,
          transition: toTransition(transitionResult.rows[0]),
          broadcast
        };
      }

      const updatedRsmResult = await runClientQuery(
        client,
        `update public.rsm_instances
         set current_state = $2,
             version = version + 1,
             status = $3
         where rsm_id = $1
         returning rsm_id, booking_id, current_state, version, status, created_at, updated_at`,
        [rsmId, validation.to_state, rsmStatusForState(validation.to_state)]
      );
      const transitionResult = await runClientQuery(
        client,
        `insert into public.rsm_transitions (
           rsm_id,
           log_index,
           from_state,
           to_state,
           event_type,
           valid,
           term,
           committed_by_leader
         )
         values ($1, $2, $3, $4, $5, true, $6, $7)
         returning
           transition_id,
           rsm_id,
           log_index,
           from_state,
           to_state,
           event_type,
           valid,
           rejection_reason,
           term,
           committed_by_leader,
           created_at`,
        [
          rsmId,
          broadcast.log_index,
          validation.from_state,
          validation.to_state,
          eventType,
          broadcast.term,
          broadcast.leader_id
        ]
      );

      return {
        accepted: true,
        validation,
        rsm: toRsm(updatedRsmResult.rows[0]),
        transition: toTransition(transitionResult.rows[0]),
        broadcast
      };
    });

    if (!result.accepted) {
      return res.status(409).json({
        message: result.code,
        error_code: result.code,
        data: result
      });
    }

    return res.json({
      message: "RSM transition committed",
      data: result
    });
  })
);

app.post(
  "/nodes/:nodeId/catch-up",
  asyncHandler(async (req, res) => {
    const nodeId = normalizeNodeId(req.params.nodeId);
    const result = await withTransaction(async (client) => {
      const node = await loadNode(nodeId, client);

      if (!isHealthyParticipant(node)) {
        throw new ApiError(409, "Node must be recovered and healthy before catch-up", {
          message: "Node must be recovered and healthy before catch-up",
          node
        });
      }

      const missingResult = await runClientQuery(
        client,
        `select l.log_index
         from public.replicated_log l
         where l.status = 'committed'
         and not exists (
           select 1
           from public.log_replication_acks a
           where a.log_index = l.log_index
           and a.node_id = $1
           and a.ack_status = 'acked'
         )
         order by l.log_index asc`,
        [nodeId]
      );
      const logIndexes = missingResult.rows.map((row) => row.log_index);

      for (const logIndex of logIndexes) {
        await runClientQuery(
          client,
          `insert into public.log_replication_acks (
             log_index,
             node_id,
             ack_status,
             reason
           )
           values ($1, $2, 'acked', 'Catch-up after crash recovery')
           on conflict (log_index, node_id)
           do update set
             ack_status = 'acked',
             reason = excluded.reason,
             created_at = now()`,
          [logIndex, nodeId]
        );
      }

      let deliveredOutbox = [];

      if (logIndexes.length > 0) {
        const outboxResult = await runClientQuery(
          client,
          `select
             id,
             log_index,
             target_node_id,
             message_type,
             payload,
             status,
             retry_count,
             last_error,
             created_at,
             processed_at
           from public.consensus_outbox
           where target_node_id = $1
           and log_index = any($2::bigint[])`,
          [nodeId, logIndexes]
        );
        deliveredOutbox = outboxResult.rows.map(toOutbox);

        await runClientQuery(
          client,
          `update public.consensus_outbox
           set status = 'delivered',
               last_error = null,
               processed_at = now()
           where target_node_id = $1
           and log_index = any($2::bigint[])`,
          [nodeId, logIndexes]
        );

        const affectedBroadcastIds = new Set();

        for (const item of deliveredOutbox) {
          const broadcastId = item.payload && item.payload.broadcast_id;

          if (broadcastId) {
            await runClientQuery(
              client,
              `insert into public.broadcast_acks (
                 broadcast_id,
                 node_id,
                 ack_status,
                 reason
               )
               values ($1, $2, 'acked', 'Catch-up after crash recovery')
               on conflict (broadcast_id, node_id)
               do update set
                 ack_status = 'acked',
                 reason = excluded.reason,
                 created_at = now()`,
              [broadcastId, nodeId]
            );
            affectedBroadcastIds.add(broadcastId);
          }
        }

        for (const logIndex of logIndexes) {
          await refreshReplicationCommit(client, logIndex);
        }

        for (const broadcastId of affectedBroadcastIds) {
          await refreshBroadcastCommit(client, broadcastId);
        }
      }

      return {
        node_id: nodeId,
        caught_up_entries: logIndexes.length,
        delivered_outbox_messages: deliveredOutbox.length,
        log_indexes: logIndexes,
        outbox: await getOutboxCounts(client)
      };
    });

    return res.json({
      message: "Node catch-up completed",
      data: result
    });
  })
);

app.use((req, res) => {
  res.status(404).json({
    message: "Route not found"
  });
});

app.use((error, req, res, _next) => {
  void _next;

  if (error instanceof ApiError) {
    return res.status(error.statusCode).json(error.responseBody);
  }

  if (error.type === "entity.parse.failed") {
    return res.status(400).json({
      message: "Invalid JSON payload"
    });
  }

  console.error("Coordinator-service internal error:", {
    method: req.method,
    path: req.originalUrl,
    message: error.message,
    name: error.name,
    code: error.code,
    severity: error.severity,
    schema: error.schema,
    table: error.table,
    column: error.column,
    constraint: error.constraint,
    detail: error.detail,
    hint: error.hint,
    sql: error.sql,
    stack: error.stack
  });

  if (isDatabaseConnectivityError(error) || isDatabaseSchemaError(error)) {
    return res.status(503).json({
      message: "Coordinator database is temporarily unavailable",
      service: "coordinator-service"
    });
  }

  if (error.code === "23505") {
    return res.status(409).json({
      message: "Record already exists",
      service: "coordinator-service"
    });
  }

  if (error.code === "23514" || error.code === "22P02") {
    return res.status(400).json({
      message: "Request violates a database constraint",
      service: "coordinator-service"
    });
  }

  return res.status(500).json({
    message: "Internal server error",
    service: "coordinator-service"
  });
});

function isDatabaseConnectivityError(error) {
  return [
    "ECONNREFUSED",
    "ENOTFOUND",
    "ETIMEDOUT",
    "ECONNRESET",
    "EAI_AGAIN",
    "28000",
    "28P01",
    "3D000",
    "53300",
    "53400",
    "57P01",
    "57P02",
    "57P03",
    "08000",
    "08003",
    "08006"
  ].includes(error.code);
}

function isDatabaseSchemaError(error) {
  return error.code === "42P01" || error.code === "42703";
}

process.on("SIGINT", async () => {
  await closePool();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await closePool();
  process.exit(0);
});

async function start() {
  try {
    await ensureClusterRows();
    await seedInfrastructureTopology();
  } catch (error) {
    console.error("Coordinator Service startup failed:", {
      message: error.message,
      code: error.code,
      sql: error.sql
    });
    process.exit(1);
  }

  app.listen(PORT, () => {
    console.log(`Coordinator Service node ${NODE_ID} running on port ${PORT}`);
  });
}

start();
