const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
require("dotenv").config();

const { query, checkDatabaseConnection, checkDatabaseSchema, closePool } = require("./db");

const app = express();
const PORT = process.env.PORT || 5006;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const allowedSeverities = ["info", "low", "medium", "high", "critical"];
const sensitiveMetadataKeys = [
  "password",
  "token",
  "authorization",
  "card_number",
  "cardnumber",
  "cvv",
  "smtp_pass",
  "smtppass",
  "secret",
  "private_key",
  "privatekey",
  "api_key",
  "apikey",
  "jwt"
];

class ApiError extends Error {
  constructor(statusCode, message, responseBody) {
    super(message);
    this.statusCode = statusCode;
    this.responseBody = responseBody || {
      message
    };
  }
}

function parseAllowedOrigins() {
  const origins = process.env.ALLOWED_ORIGINS || "http://localhost:3000,http://localhost:4000";

  return origins
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

const allowedOrigins = parseAllowedOrigins();

app.use(helmet());
app.use(
  cors({
    origin(origin, callback) {
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

function compactSql(text) {
  return String(text).replace(/\s+/g, " ").trim();
}

async function runQuery(text, params) {
  try {
    return await query(text, params);
  } catch (error) {
    error.sql = compactSql(text);
    throw error;
  }
}

function logInternalError(error, req) {
  console.error("Audit-service internal error:", {
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
    sql: error.sql
  });
}

function logDependencyError(label, error) {
  console.error(`${label} dependency check failed:`, {
    message: error.message,
    name: error.name,
    code: error.code,
    sql: error.sql
  });
}

function isDatabaseConnectivityError(error) {
  return [
    "MISSING_AUDIT_DATABASE_URL",
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

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function assertRequiredString(value, fieldName, maxLength = 255) {
  if (!isNonEmptyString(value)) {
    throw new ApiError(400, `${fieldName} is required`);
  }

  const trimmedValue = value.trim();

  if (trimmedValue.length > maxLength) {
    throw new ApiError(400, `${fieldName} is too long`);
  }

  return trimmedValue;
}

function normalizeOptionalString(value, fieldName, maxLength = 500) {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== "string") {
    throw new ApiError(400, `${fieldName} must be a string`);
  }

  const trimmedValue = value.trim();

  if (trimmedValue.length === 0) {
    return null;
  }

  if (trimmedValue.length > maxLength) {
    throw new ApiError(400, `${fieldName} is too long`);
  }

  return trimmedValue;
}

function normalizeUuid(value, fieldName) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  if (typeof value !== "string" || !uuidPattern.test(value)) {
    throw new ApiError(400, `${fieldName} must be a valid UUID`);
  }

  return value;
}

function assertUuid(value, fieldName) {
  if (typeof value !== "string" || !uuidPattern.test(value)) {
    throw new ApiError(400, `${fieldName} must be a valid UUID`);
  }

  return value;
}

function normalizeSeverity(value) {
  const severity = value === undefined || value === null || value === ""
    ? "info"
    : String(value).trim().toLowerCase();

  if (!allowedSeverities.includes(severity)) {
    throw new ApiError(400, `severity must be one of: ${allowedSeverities.join(", ")}`);
  }

  return severity;
}

function normalizeOptionalBoolean(value, fieldName) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalizedValue = value.trim().toLowerCase();

    if (normalizedValue === "true") {
      return true;
    }

    if (normalizedValue === "false") {
      return false;
    }
  }

  throw new ApiError(400, `${fieldName} must be true or false`);
}

function normalizeStatusCode(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  if (!Number.isInteger(value) || value < 100 || value > 599) {
    throw new ApiError(400, "status_code must be an integer HTTP status code");
  }

  return value;
}

function normalizeMethod(value) {
  const method = normalizeOptionalString(value, "method", 20);

  return method ? method.toUpperCase() : null;
}

function normalizeDateQuery(value, fieldName) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const parsedDate = new Date(value);

  if (Number.isNaN(parsedDate.getTime())) {
    throw new ApiError(400, `${fieldName} must be a valid date`);
  }

  return parsedDate.toISOString();
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

function normalizeMetadata(value) {
  if (value === undefined || value === null) {
    return {};
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "metadata must be an object");
  }

  return sanitizeMetadata(value);
}

function sanitizeMetadata(value, depth = 0) {
  if (depth > 5) {
    return "[truncated]";
  }

  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitizeMetadata(item, depth + 1));
  }

  if (value && typeof value === "object") {
    return Object.entries(value).reduce((safe, [key, item]) => {
      const normalizedKey = key.toLowerCase().replace(/[^a-z0-9_]/g, "");

      if (sensitiveMetadataKeys.some((sensitiveKey) => normalizedKey.includes(sensitiveKey))) {
        safe[key] = "[redacted]";
      } else {
        safe[key] = sanitizeMetadata(item, depth + 1);
      }

      return safe;
    }, {});
  }

  if (typeof value === "string") {
    return value.length > 1000 ? `${value.slice(0, 1000)}...[truncated]` : value;
  }

  return value;
}

function toAuditLog(row) {
  return {
    id: row.id,
    event_type: row.event_type,
    service_name: row.service_name,
    severity: row.severity,
    actor_user_id: row.actor_user_id,
    actor_role: row.actor_role,
    action: row.action,
    resource_type: row.resource_type,
    resource_id: row.resource_id,
    endpoint: row.endpoint,
    method: row.method,
    status: row.status,
    status_code: row.status_code,
    ip_address: row.ip_address,
    user_agent: row.user_agent,
    is_suspicious: row.is_suspicious,
    suspicious_reason: row.suspicious_reason,
    correlation_id: row.correlation_id,
    metadata: row.metadata,
    created_at: row.created_at
  };
}

const auditSelectSql = `
  select
    id,
    event_type,
    service_name,
    severity,
    actor_user_id,
    actor_role,
    action,
    resource_type,
    resource_id,
    endpoint,
    method,
    status,
    status_code,
    ip_address,
    user_agent,
    is_suspicious,
    suspicious_reason,
    correlation_id,
    metadata,
    created_at
  from public.security_audit_logs
`;

async function getAuditLogById(id) {
  const result = await runQuery(
    `${auditSelectSql}
     where id = $1
     limit 1`,
    [id]
  );

  return result.rows[0] || null;
}

app.get("/health", (req, res) => {
  res.json({
    service: "audit-service",
    status: "up",
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
      const schema = await checkDatabaseSchema();

      database = {
        ...connection,
        schema
      };
    } catch (error) {
      logDependencyError("Audit database", error);

      database = {
        status: "down",
        latencyMs: 0,
        schema: {
          status: "unknown",
          missingTables: [],
          missingColumns: []
        },
        error: error.code === "MISSING_AUDIT_DATABASE_URL"
          ? "Audit database is not configured"
          : "Audit database is unavailable"
      };
    }

    const isHealthy =
      database.status === "up" &&
      database.schema &&
      database.schema.status === "ready";

    return res.status(isHealthy ? 200 : 503).json({
      service: "audit-service",
      status: isHealthy ? "healthy" : "degraded",
      database,
      timestamp: new Date().toISOString()
    });
  })
);

app.post(
  "/audit/logs",
  asyncHandler(async (req, res) => {
    const eventType = assertRequiredString(req.body.event_type, "event_type", 100).toUpperCase();
    const serviceName = assertRequiredString(req.body.service_name, "service_name", 100);
    const action = assertRequiredString(req.body.action, "action", 150);
    const severity = normalizeSeverity(req.body.severity);
    const isSuspicious = req.body.is_suspicious === undefined || req.body.is_suspicious === null
      ? false
      : normalizeOptionalBoolean(req.body.is_suspicious, "is_suspicious");
    const metadata = normalizeMetadata(req.body.metadata);

    const result = await runQuery(
      `insert into public.security_audit_logs (
        event_type,
        service_name,
        severity,
        actor_user_id,
        actor_role,
        action,
        resource_type,
        resource_id,
        endpoint,
        method,
        status,
        status_code,
        ip_address,
        user_agent,
        is_suspicious,
        suspicious_reason,
        correlation_id,
        metadata
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18::jsonb)
      returning
        id,
        event_type,
        service_name,
        severity,
        actor_user_id,
        actor_role,
        action,
        resource_type,
        resource_id,
        endpoint,
        method,
        status,
        status_code,
        ip_address,
        user_agent,
        is_suspicious,
        suspicious_reason,
        correlation_id,
        metadata,
        created_at`,
      [
        eventType,
        serviceName,
        severity,
        normalizeUuid(req.body.actor_user_id, "actor_user_id"),
        normalizeOptionalString(req.body.actor_role, "actor_role", 50),
        action,
        normalizeOptionalString(req.body.resource_type, "resource_type", 100),
        normalizeUuid(req.body.resource_id, "resource_id"),
        normalizeOptionalString(req.body.endpoint, "endpoint", 500),
        normalizeMethod(req.body.method),
        normalizeOptionalString(req.body.status, "status", 50),
        normalizeStatusCode(req.body.status_code),
        normalizeOptionalString(req.body.ip_address, "ip_address", 100),
        normalizeOptionalString(req.body.user_agent, "user_agent", 500),
        isSuspicious,
        normalizeOptionalString(req.body.suspicious_reason, "suspicious_reason", 1000),
        normalizeUuid(req.body.correlation_id, "correlation_id"),
        JSON.stringify(metadata)
      ]
    );

    return res.status(201).json({
      message: "Audit log created",
      data: toAuditLog(result.rows[0])
    });
  })
);

app.get(
  "/audit/logs",
  asyncHandler(async (req, res) => {
    const filters = [];
    const params = [];
    const addParam = (value) => {
      params.push(value);
      return `$${params.length}`;
    };

    if (req.query.service_name !== undefined && req.query.service_name !== "") {
      filters.push(`service_name = ${addParam(assertRequiredString(req.query.service_name, "service_name", 100))}`);
    }

    if (req.query.event_type !== undefined && req.query.event_type !== "") {
      filters.push(`event_type = ${addParam(assertRequiredString(req.query.event_type, "event_type", 100).toUpperCase())}`);
    }

    if (req.query.severity !== undefined && req.query.severity !== "") {
      filters.push(`severity = ${addParam(normalizeSeverity(req.query.severity))}`);
    }

    if (req.query.is_suspicious !== undefined && req.query.is_suspicious !== "") {
      filters.push(`is_suspicious = ${addParam(normalizeOptionalBoolean(req.query.is_suspicious, "is_suspicious"))}`);
    }

    if (req.query.actor_user_id !== undefined && req.query.actor_user_id !== "") {
      filters.push(`actor_user_id = ${addParam(assertUuid(req.query.actor_user_id, "actor_user_id"))}`);
    }

    if (req.query.resource_type !== undefined && req.query.resource_type !== "") {
      filters.push(`resource_type = ${addParam(assertRequiredString(req.query.resource_type, "resource_type", 100))}`);
    }

    if (req.query.resource_id !== undefined && req.query.resource_id !== "") {
      filters.push(`resource_id = ${addParam(assertUuid(req.query.resource_id, "resource_id"))}`);
    }

    if (req.query.correlation_id !== undefined && req.query.correlation_id !== "") {
      filters.push(`correlation_id = ${addParam(assertUuid(req.query.correlation_id, "correlation_id"))}`);
    }

    const startDate = normalizeDateQuery(req.query.start_date, "start_date");
    const endDate = normalizeDateQuery(req.query.end_date, "end_date");

    if (startDate) {
      filters.push(`created_at >= ${addParam(startDate)}`);
    }

    if (endDate) {
      filters.push(`created_at <= ${addParam(endDate)}`);
    }

    const limit = parseIntegerQuery(req.query.limit, "limit", 50, { min: 1, max: 200 });
    const offset = parseIntegerQuery(req.query.offset, "offset", 0, { min: 0 });
    const whereSql = filters.length > 0 ? `where ${filters.join(" and ")}` : "";

    params.push(limit);
    const limitPlaceholder = `$${params.length}`;
    params.push(offset);
    const offsetPlaceholder = `$${params.length}`;

    const result = await runQuery(
      `${auditSelectSql}
       ${whereSql}
       order by created_at desc
       limit ${limitPlaceholder}
       offset ${offsetPlaceholder}`,
      params
    );

    return res.json({
      data: result.rows.map(toAuditLog),
      pagination: {
        limit,
        offset,
        count: result.rowCount
      }
    });
  })
);

app.get(
  "/audit/logs/suspicious/recent",
  asyncHandler(async (req, res) => {
    const limit = parseIntegerQuery(req.query.limit, "limit", 20, { min: 1, max: 100 });
    const result = await runQuery(
      `${auditSelectSql}
       where is_suspicious = true
       order by created_at desc
       limit $1`,
      [limit]
    );

    return res.json({
      data: result.rows.map(toAuditLog),
      pagination: {
        limit,
        offset: 0,
        count: result.rowCount
      }
    });
  })
);

app.get(
  "/audit/logs/service/:serviceName",
  asyncHandler(async (req, res) => {
    const serviceName = assertRequiredString(req.params.serviceName, "serviceName", 100);
    const limit = parseIntegerQuery(req.query.limit, "limit", 50, { min: 1, max: 200 });
    const offset = parseIntegerQuery(req.query.offset, "offset", 0, { min: 0 });

    const result = await runQuery(
      `${auditSelectSql}
       where service_name = $1
       order by created_at desc
       limit $2
       offset $3`,
      [serviceName, limit, offset]
    );

    return res.json({
      data: result.rows.map(toAuditLog),
      pagination: {
        limit,
        offset,
        count: result.rowCount
      }
    });
  })
);

app.get(
  "/audit/summary/security",
  asyncHandler(async (req, res) => {
    const summaryResult = await runQuery(
      `select
        count(*)::int as total_logs,
        count(*) filter (where is_suspicious = true)::int as suspicious_logs,
        count(*) filter (where severity = 'critical')::int as critical_logs,
        count(*) filter (where severity = 'high')::int as high_logs,
        count(*) filter (
          where event_type in ('AUTH_LOGIN_FAILED', 'PAYMENT_FAILED', 'NOTIFICATION_FAILED')
          or status in ('failed', 'error')
        )::int as failed_operations,
        count(*) filter (where event_type = 'SERVICE_UNAVAILABLE')::int as service_unavailable_events,
        count(*) filter (where event_type = 'DATABASE_DEGRADED')::int as database_degraded_events
       from public.security_audit_logs`
    );

    const latestSuspiciousResult = await runQuery(
      `${auditSelectSql}
       where is_suspicious = true
       order by created_at desc
       limit 10`
    );

    return res.json({
      data: {
        ...summaryResult.rows[0],
        latest_suspicious_events: latestSuspiciousResult.rows.map(toAuditLog)
      }
    });
  })
);

app.get(
  "/audit/logs/:id",
  asyncHandler(async (req, res) => {
    const id = assertUuid(req.params.id, "id");
    const auditLog = await getAuditLogById(id);

    if (!auditLog) {
      throw new ApiError(404, "Audit log not found");
    }

    return res.json({
      data: toAuditLog(auditLog)
    });
  })
);

app.use((req, res) => {
  res.status(404).json({
    message: "Route not found"
  });
});

app.use((error, req, res, next) => {
  if (error instanceof ApiError) {
    return res.status(error.statusCode).json(error.responseBody);
  }

  if (error.type === "entity.parse.failed") {
    return res.status(400).json({
      message: "Invalid JSON payload"
    });
  }

  logInternalError(error, req);

  if (isDatabaseConnectivityError(error) || isDatabaseSchemaError(error)) {
    return res.status(503).json({
      message: "Audit logging is temporarily unavailable",
      service: "audit-service"
    });
  }

  if (error.code === "23514" || error.code === "22P02") {
    return res.status(400).json({
      message: "Request violates a database constraint"
    });
  }

  return res.status(500).json({
    message: "Internal server error",
    service: "audit-service"
  });
});

process.on("SIGINT", async () => {
  await closePool();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await closePool();
  process.exit(0);
});

app.listen(PORT, () => {
  console.log(`Audit Service running on port ${PORT}`);
});
