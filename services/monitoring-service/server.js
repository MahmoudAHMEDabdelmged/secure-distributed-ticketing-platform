const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
require("dotenv").config();

const {
  query,
  checkDatabaseConnection,
  checkRequiredSchema,
  closePool,
  isDatabaseConfigured
} = require("./db");

const app = express();
const PORT = process.env.PORT || 5008;

const AUTH_SERVICE_URL = (process.env.AUTH_SERVICE_URL || "http://localhost:5000").replace(/\/+$/, "");
const EVENTS_SERVICE_URL = (process.env.EVENTS_SERVICE_URL || "http://localhost:5001").replace(/\/+$/, "");
const BOOKING_SERVICE_URL = (process.env.BOOKING_SERVICE_URL || "http://localhost:5002").replace(/\/+$/, "");
const TICKET_SERVICE_URL = (process.env.TICKET_SERVICE_URL || "http://localhost:5003").replace(/\/+$/, "");
const PAYMENT_SERVICE_URL = (process.env.PAYMENT_SERVICE_URL || "http://localhost:5004").replace(/\/+$/, "");
const NOTIFICATION_SERVICE_URL = (process.env.NOTIFICATION_SERVICE_URL || "http://localhost:5005").replace(/\/+$/, "");
const AUDIT_SERVICE_URL = (process.env.AUDIT_SERVICE_URL || "http://localhost:5006").replace(/\/+$/, "");
const SAGA_SERVICE_URL = (process.env.SAGA_SERVICE_URL || "http://localhost:5007").replace(/\/+$/, "");
const API_GATEWAY_URL = (process.env.API_GATEWAY_URL || "http://localhost:4000").replace(/\/+$/, "");
const CHECK_INTERVAL_SECONDS = parseIntegerEnv(process.env.CHECK_INTERVAL_SECONDS, 60, { min: 10, max: 86400 });
const ALERT_ON_DEGRADED = !["false", "0", "no"].includes(
  String(process.env.ALERT_ON_DEGRADED || "true").trim().toLowerCase()
);
const ENABLE_MONITORING_SCHEDULER = false;
const REQUEST_TIMEOUT_MS = 5000;
const HIGH_LATENCY_MS = 2000;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const allowedHealthStatuses = ["healthy", "degraded", "down"];
const allowedCheckTypes = ["health", "deep_health"];
const allowedIncidentStatuses = ["open", "acknowledged", "resolved"];
const allowedSeverities = ["low", "medium", "high", "critical"];
const allowedIncidentTypes = [
  "SERVICE_DOWN",
  "SERVICE_DEGRADED",
  "DATABASE_DOWN",
  "SCHEMA_NOT_READY",
  "DEPENDENCY_DOWN",
  "HIGH_LATENCY"
];
const allowedRsmStatuses = ["pending", "committed", "rejected"];
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
  "jwt",
  "database_url",
  "db_url",
  "connection_string"
];

const monitoredServices = [
  {
    service_name: "auth-service",
    service_url: AUTH_SERVICE_URL,
    health_path: "/health",
    deep_health_path: null
  },
  {
    service_name: "events-service",
    service_url: EVENTS_SERVICE_URL,
    health_path: "/health",
    deep_health_path: "/health/deep"
  },
  {
    service_name: "booking-service",
    service_url: BOOKING_SERVICE_URL,
    health_path: "/health",
    deep_health_path: "/health/deep"
  },
  {
    service_name: "ticket-service",
    service_url: TICKET_SERVICE_URL,
    health_path: "/health",
    deep_health_path: "/health/deep"
  },
  {
    service_name: "payment-service",
    service_url: PAYMENT_SERVICE_URL,
    health_path: "/health",
    deep_health_path: "/health/deep"
  },
  {
    service_name: "notification-service",
    service_url: NOTIFICATION_SERVICE_URL,
    health_path: "/health",
    deep_health_path: "/health/deep"
  },
  {
    service_name: "audit-service",
    service_url: AUDIT_SERVICE_URL,
    health_path: "/health",
    deep_health_path: "/health/deep"
  },
  {
    service_name: "saga-service",
    service_url: SAGA_SERVICE_URL,
    health_path: "/health",
    deep_health_path: "/health/deep"
  },
  {
    service_name: "api-gateway",
    service_url: API_GATEWAY_URL,
    health_path: "/health",
    deep_health_path: null
  }
];

const severityRank = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4
};

class ApiError extends Error {
  constructor(statusCode, message, responseBody) {
    super(message);
    this.statusCode = statusCode;
    this.responseBody = responseBody || {
      message
    };
  }
}

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: "1mb" }));

function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
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

function assertUuid(value, fieldName) {
  if (typeof value !== "string" || !uuidPattern.test(value)) {
    throw new ApiError(400, `${fieldName} must be a valid UUID`);
  }

  return value;
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

function normalizeOptionalEnum(value, fieldName, allowedValues) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const normalizedValue = String(value).trim();

  if (!allowedValues.includes(normalizedValue)) {
    throw new ApiError(400, `${fieldName} must be one of: ${allowedValues.join(", ")}`);
  }

  return normalizedValue;
}

function normalizeRsmEventType(value) {
  const eventType = assertRequiredString(value, "event_type", 100).toUpperCase();

  if (!/^[A-Z0-9_:-]{3,100}$/.test(eventType)) {
    throw new ApiError(400, "event_type may contain only letters, numbers, underscores, colons, and hyphens");
  }

  return eventType;
}

function normalizePositiveInteger(value, fieldName, defaultValue) {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }

  if (!Number.isInteger(value) || value <= 0) {
    throw new ApiError(400, `${fieldName} must be a positive integer`);
  }

  return value;
}

function normalizeJsonObject(value, fieldName) {
  if (value === undefined || value === null) {
    return {};
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, `${fieldName} must be an object`);
  }

  return redactSensitiveValues(value);
}

function redactSensitiveValues(value, depth = 0) {
  if (depth > 5) {
    return "[truncated]";
  }

  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => redactSensitiveValues(item, depth + 1));
  }

  if (value && typeof value === "object") {
    return Object.entries(value).reduce((safe, [key, childValue]) => {
      const normalizedKey = key.toLowerCase().replace(/[^a-z0-9_]/g, "");

      if (sensitiveMetadataKeys.some((sensitiveKey) => normalizedKey.includes(sensitiveKey))) {
        safe[key] = "[redacted]";
      } else {
        safe[key] = redactSensitiveValues(childValue, depth + 1);
      }

      return safe;
    }, {});
  }

  if (typeof value === "string") {
    return value.length > 1000 ? `${value.slice(0, 1000)}...[truncated]` : value;
  }

  return value;
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
  console.error("Monitoring-service internal error:", {
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

function isDatabaseConnectivityError(error) {
  return [
    "MISSING_MONITORING_DATABASE_URL",
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

async function fetchWithTimeout(url, options = {}) {
  if (typeof fetch !== "function") {
    throw new Error("Global fetch is not available in this Node.js runtime");
  }

  const timeoutMs = options.timeoutMs || REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

function buildServiceUrl(service, path) {
  return `${service.service_url}${path}`;
}

function toMonitoredService(service) {
  return {
    service_name: service.service_name,
    service_url: service.service_url,
    health_url: buildServiceUrl(service, service.health_path),
    deep_health_url: service.deep_health_path ? buildServiceUrl(service, service.deep_health_path) : null
  };
}

function normalizeHealthStatus(payload, responseOk, httpStatus) {
  const rawStatus = payload && typeof payload.status === "string"
    ? payload.status.trim().toLowerCase()
    : "";

  if (rawStatus === "healthy" || rawStatus === "up" || rawStatus === "ready") {
    return "healthy";
  }

  if (rawStatus === "degraded" || rawStatus === "not_ready" || rawStatus === "unknown") {
    return "degraded";
  }

  if (rawStatus === "down" || rawStatus === "failed" || rawStatus === "error") {
    return "down";
  }

  if (!responseOk) {
    return httpStatus >= 500 ? "degraded" : "down";
  }

  return "healthy";
}

function safeResponseSummary(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {};
  }

  const summary = {};
  const allowedKeys = [
    "service",
    "status",
    "timestamp",
    "database",
    "schema",
    "dependencies",
    "smtp",
    "bookingService",
    "paymentService",
    "eventsService",
    "ticketService",
    "notificationService",
    "auditService",
    "requirePaymentForTickets",
    "error",
    "message"
  ];

  for (const key of allowedKeys) {
    if (payload[key] !== undefined) {
      summary[key] = payload[key];
    }
  }

  return redactSensitiveValues(summary);
}

async function executeDependencyCheck(service, checkType, path) {
  const url = buildServiceUrl(service, path);
  const startedAt = Date.now();
  let response;

  try {
    response = await fetchWithTimeout(url, {
      headers: {
        accept: "application/json"
      },
      timeoutMs: REQUEST_TIMEOUT_MS
    });
  } catch (error) {
    return {
      service_name: service.service_name,
      service_url: service.service_url,
      check_type: checkType,
      status: "down",
      http_status: null,
      latency_ms: Date.now() - startedAt,
      response_summary: {},
      error_message: error.name === "AbortError" ? "Health check timed out" : error.message
    };
  }

  const latencyMs = Date.now() - startedAt;
  let payload = {};

  try {
    const text = await response.text();

    if (text) {
      payload = JSON.parse(text);
    }
  } catch (error) {
    payload = {
      message: "Dependency returned a non-JSON response"
    };
  }

  return {
    service_name: service.service_name,
    service_url: service.service_url,
    check_type: checkType,
    status: normalizeHealthStatus(payload, response.ok, response.status),
    http_status: response.status,
    latency_ms: latencyMs,
    response_summary: safeResponseSummary(payload),
    error_message: response.ok ? null : payload.message || payload.error || `HTTP ${response.status}`
  };
}

async function storeHealthCheck(check) {
  const result = await runQuery(
    `insert into public.service_health_checks (
       service_name,
       service_url,
       check_type,
       status,
       http_status,
       latency_ms,
       response_summary,
       error_message
     )
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
     returning
       id,
       service_name,
       service_url,
       check_type,
       status,
       http_status,
       latency_ms,
       response_summary,
       error_message,
       checked_at`,
    [
      check.service_name,
      check.service_url,
      check.check_type,
      check.status,
      check.http_status,
      check.latency_ms,
      JSON.stringify(check.response_summary || {}),
      check.error_message || null
    ]
  );

  return result.rows[0];
}

async function updateMonitoringNode(serviceName, status, metadata) {
  await runQuery(
    `insert into public.monitoring_nodes (
       node_name,
       service_name,
       node_role,
       status,
       last_heartbeat_at,
       metadata
     )
     values ($1, $2, 'service', $3, now(), $4::jsonb)
     on conflict (node_name)
     do update set
       status = excluded.status,
       last_heartbeat_at = excluded.last_heartbeat_at,
       metadata = excluded.metadata`,
    [
      serviceName,
      serviceName,
      status,
      JSON.stringify(redactSensitiveValues(metadata || {}))
    ]
  );
}

function findDependencyDown(summary) {
  if (!summary || typeof summary !== "object") {
    return false;
  }

  const candidates = [
    summary.dependencies,
    summary.bookingService,
    summary.paymentService,
    summary.eventsService,
    summary.ticketService,
    summary.notificationService,
    summary.auditService,
    summary.smtp
  ];

  return candidates.some((candidate) => {
    if (!candidate) {
      return false;
    }

    if (Array.isArray(candidate)) {
      return candidate.some(findDependencyDown);
    }

    if (typeof candidate === "object") {
      if (candidate.status && candidate.status !== "up" && candidate.status !== "healthy" && candidate.status !== "ready") {
        return true;
      }

      return Object.values(candidate).some((value) => {
        if (!value || typeof value !== "object") {
          return false;
        }

        return Boolean(value.status && value.status !== "up" && value.status !== "healthy" && value.status !== "ready");
      });
    }

    return false;
  });
}

function classifyDeepHealthIncident(check) {
  const summary = check.response_summary || {};
  const database = summary.database || {};
  const schema = database.schema || summary.schema || {};

  if (database.status === "down") {
    return {
      incident_type: "DATABASE_DOWN",
      severity: "critical",
      summary: `${check.service_name} database is down`
    };
  }

  if (schema.status && schema.status !== "ready") {
    return {
      incident_type: "SCHEMA_NOT_READY",
      severity: "high",
      summary: `${check.service_name} schema is not ready`
    };
  }

  if (findDependencyDown(summary)) {
    return {
      incident_type: "DEPENDENCY_DOWN",
      severity: "high",
      summary: `${check.service_name} reports a degraded dependency`
    };
  }

  return {
    incident_type: "SERVICE_DEGRADED",
    severity: "medium",
    summary: `${check.service_name} reports degraded health`
  };
}

function classifyIncidentsForChecks(checks) {
  const incidents = [];

  for (const check of checks) {
    if (check.status === "down") {
      incidents.push({
        service_name: check.service_name,
        incident_type: "SERVICE_DOWN",
        severity: "critical",
        summary: `${check.service_name} ${check.check_type} check failed`,
        metadata: {
          check_type: check.check_type,
          http_status: check.http_status,
          latency_ms: check.latency_ms,
          error_message: check.error_message
        }
      });
    } else if (check.check_type === "deep_health" && check.status === "degraded") {
      const classifiedIncident = classifyDeepHealthIncident(check);

      incidents.push({
        service_name: check.service_name,
        ...classifiedIncident,
        metadata: {
          check_type: check.check_type,
          http_status: check.http_status,
          latency_ms: check.latency_ms,
          response_summary: check.response_summary
        }
      });
    } else if (check.status === "degraded") {
      incidents.push({
        service_name: check.service_name,
        incident_type: "SERVICE_DEGRADED",
        severity: "medium",
        summary: `${check.service_name} reports degraded health`,
        metadata: {
          check_type: check.check_type,
          http_status: check.http_status,
          latency_ms: check.latency_ms,
          response_summary: check.response_summary
        }
      });
    }

    if (Number.isInteger(check.latency_ms) && check.latency_ms >= HIGH_LATENCY_MS) {
      incidents.push({
        service_name: check.service_name,
        incident_type: "HIGH_LATENCY",
        severity: check.latency_ms >= HIGH_LATENCY_MS * 2 ? "high" : "medium",
        summary: `${check.service_name} latency is ${check.latency_ms}ms`,
        metadata: {
          check_type: check.check_type,
          latency_ms: check.latency_ms,
          threshold_ms: HIGH_LATENCY_MS
        }
      });
    }
  }

  return incidents;
}

function shouldAlertIncident(incident, action) {
  if (action !== "opened" && action !== "escalated") {
    return false;
  }

  if (ALERT_ON_DEGRADED) {
    return true;
  }

  return incident.incident_type === "SERVICE_DOWN" ||
    incident.incident_type === "DATABASE_DOWN" ||
    incident.severity === "critical";
}

async function createOrUpdateIncident(detectedIncident) {
  const activeResult = await runQuery(
    `select
       id,
       service_name,
       incident_type,
       severity,
       status,
       first_detected_at,
       last_detected_at,
       resolved_at,
       consecutive_failures,
       summary,
       metadata
     from public.monitoring_incidents
     where service_name = $1
     and incident_type = $2
     and status in ('open', 'acknowledged')
     order by last_detected_at desc
     limit 1`,
    [detectedIncident.service_name, detectedIncident.incident_type]
  );

  if (activeResult.rowCount === 0) {
    const createdResult = await runQuery(
      `insert into public.monitoring_incidents (
         service_name,
         incident_type,
         severity,
         status,
         summary,
         metadata
       )
       values ($1, $2, $3, 'open', $4, $5::jsonb)
       returning
         id,
         service_name,
         incident_type,
         severity,
         status,
         first_detected_at,
         last_detected_at,
         resolved_at,
         consecutive_failures,
         summary,
         metadata`,
      [
        detectedIncident.service_name,
        detectedIncident.incident_type,
        detectedIncident.severity,
        detectedIncident.summary,
        JSON.stringify(redactSensitiveValues(detectedIncident.metadata || {}))
      ]
    );

    return {
      action: "opened",
      incident: createdResult.rows[0]
    };
  }

  const existingIncident = activeResult.rows[0];
  const shouldEscalate = severityRank[detectedIncident.severity] > severityRank[existingIncident.severity];
  const nextSeverity = shouldEscalate ? detectedIncident.severity : existingIncident.severity;
  const nextMetadata = {
    ...(existingIncident.metadata || {}),
    latest_detection: redactSensitiveValues(detectedIncident.metadata || {})
  };
  const updatedResult = await runQuery(
    `update public.monitoring_incidents
     set severity = $1,
         last_detected_at = now(),
         consecutive_failures = consecutive_failures + 1,
         summary = $2,
         metadata = $3::jsonb
     where id = $4
     returning
       id,
       service_name,
       incident_type,
       severity,
       status,
       first_detected_at,
       last_detected_at,
       resolved_at,
       consecutive_failures,
       summary,
       metadata`,
    [
      nextSeverity,
      detectedIncident.summary,
      JSON.stringify(nextMetadata),
      existingIncident.id
    ]
  );

  return {
    action: shouldEscalate ? "escalated" : "updated",
    incident: updatedResult.rows[0]
  };
}

async function sendSecurityAlert(incident, action) {
  try {
    const response = await fetchWithTimeout(`${NOTIFICATION_SERVICE_URL}/notifications/security-alert`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json"
      },
      body: JSON.stringify({
        severity: incident.severity,
        title: `${incident.incident_type} ${action} for ${incident.service_name}`,
        message: incident.summary || `${incident.service_name} monitoring incident ${action}`,
        source_service: "monitoring-service",
        resource_type: "monitoring_incident",
        resource_id: incident.id,
        metadata: {
          incident_type: incident.incident_type,
          incident_status: incident.status,
          consecutive_failures: incident.consecutive_failures,
          action
        }
      }),
      timeoutMs: REQUEST_TIMEOUT_MS
    });

    if (!response.ok) {
      console.warn("Monitoring alert delivery failed:", {
        incident_id: incident.id,
        status_code: response.status
      });
    }

    return {
      ok: response.ok,
      status_code: response.status
    };
  } catch (error) {
    console.warn("Notification Service unavailable for monitoring alert:", {
      incident_id: incident.id,
      message: error.name === "AbortError" ? "Alert request timed out" : error.message
    });

    return {
      ok: false,
      error: error.name === "AbortError" ? "Alert request timed out" : error.message
    };
  }
}

async function logAuditEvent(eventType, options = {}) {
  try {
    const response = await fetchWithTimeout(`${AUDIT_SERVICE_URL}/audit/logs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json"
      },
      body: JSON.stringify({
        event_type: eventType,
        service_name: "monitoring-service",
        severity: options.severity || "info",
        action: options.action || eventType,
        resource_type: options.resource_type || null,
        resource_id: options.resource_id || null,
        endpoint: options.endpoint || null,
        method: options.method || null,
        status: options.status || null,
        status_code: options.status_code || null,
        is_suspicious: options.is_suspicious === true,
        suspicious_reason: options.suspicious_reason || null,
        metadata: redactSensitiveValues(options.metadata || {})
      }),
      timeoutMs: REQUEST_TIMEOUT_MS
    });

    if (!response.ok) {
      console.warn("Audit logging failed for monitoring-service event:", {
        event_type: eventType,
        status_code: response.status
      });
    }

    return {
      ok: response.ok,
      status_code: response.status
    };
  } catch (error) {
    console.warn("Audit Service unavailable for monitoring event:", {
      event_type: eventType,
      message: error.name === "AbortError" ? "Audit request timed out" : error.message
    });

    return {
      ok: false,
      error: error.name === "AbortError" ? "Audit request timed out" : error.message
    };
  }
}

async function runMonitoringCycle() {
  const cycleStartedAt = new Date();
  const serviceSummaries = [];
  const persistedChecks = [];
  const persistenceWarnings = [];
  const incidentActions = [];

  for (const service of monitoredServices) {
    const serviceChecks = [];
    const healthCheck = await executeDependencyCheck(service, "health", service.health_path);

    serviceChecks.push(healthCheck);

    if (healthCheck.status !== "down" && service.deep_health_path) {
      serviceChecks.push(await executeDependencyCheck(service, "deep_health", service.deep_health_path));
    }

    for (const check of serviceChecks) {
      try {
        persistedChecks.push(await storeHealthCheck(check));
      } catch (error) {
        persistenceWarnings.push({
          service_name: check.service_name,
          check_type: check.check_type,
          error: error.code === "MISSING_MONITORING_DATABASE_URL"
            ? "Monitoring database is not configured"
            : error.message
        });
      }
    }

    const worstStatus = serviceChecks.some((check) => check.status === "down")
      ? "down"
      : serviceChecks.some((check) => check.status === "degraded")
        ? "degraded"
        : "healthy";

    try {
      await updateMonitoringNode(service.service_name, worstStatus, {
        latest_checks: serviceChecks.map((check) => ({
          check_type: check.check_type,
          status: check.status,
          http_status: check.http_status,
          latency_ms: check.latency_ms
        }))
      });
    } catch (error) {
      persistenceWarnings.push({
        service_name: service.service_name,
        operation: "monitoring_node_update",
        error: error.code === "MISSING_MONITORING_DATABASE_URL"
          ? "Monitoring database is not configured"
          : error.message
      });
    }

    const detectedIncidents = classifyIncidentsForChecks(serviceChecks);

    for (const detectedIncident of detectedIncidents) {
      try {
        const incidentAction = await createOrUpdateIncident(detectedIncident);

        incidentActions.push(incidentAction);

        const auditEventType = incidentAction.action === "opened"
          ? "MONITORING_INCIDENT_OPENED"
          : "MONITORING_INCIDENT_UPDATED";

        await logAuditEvent(auditEventType, {
          severity: incidentAction.incident.severity,
          action: `monitoring_incident_${incidentAction.action}`,
          resource_type: "monitoring_incident",
          resource_id: incidentAction.incident.id,
          endpoint: "/monitoring/checks/run",
          method: "POST",
          status: incidentAction.incident.status,
          status_code: 200,
          metadata: {
            service_name: incidentAction.incident.service_name,
            incident_type: incidentAction.incident.incident_type,
            consecutive_failures: incidentAction.incident.consecutive_failures
          }
        });

        if (shouldAlertIncident(incidentAction.incident, incidentAction.action)) {
          await sendSecurityAlert(incidentAction.incident, incidentAction.action);
        }
      } catch (error) {
        persistenceWarnings.push({
          service_name: detectedIncident.service_name,
          incident_type: detectedIncident.incident_type,
          operation: "incident_upsert",
          error: error.code === "MISSING_MONITORING_DATABASE_URL"
            ? "Monitoring database is not configured"
            : error.message
        });
      }
    }

    serviceSummaries.push({
      service_name: service.service_name,
      status: worstStatus,
      checks: serviceChecks.map((check) => ({
        check_type: check.check_type,
        status: check.status,
        http_status: check.http_status,
        latency_ms: check.latency_ms,
        error_message: check.error_message
      })),
      incidents_detected: detectedIncidents.map((incident) => ({
        incident_type: incident.incident_type,
        severity: incident.severity,
        summary: incident.summary
      }))
    });
  }

  await logAuditEvent("MONITORING_CHECK_RUN", {
    action: "monitoring_check_cycle_completed",
    endpoint: "/monitoring/checks/run",
    method: "POST",
    status: persistenceWarnings.length === 0 ? "completed" : "completed_with_warnings",
    status_code: 200,
    metadata: {
      total_services: monitoredServices.length,
      persisted_checks: persistedChecks.length,
      incidents_processed: incidentActions.length,
      persistence_warning_count: persistenceWarnings.length
    }
  });

  return {
    started_at: cycleStartedAt.toISOString(),
    completed_at: new Date().toISOString(),
    total_services: monitoredServices.length,
    service_statuses: {
      healthy: serviceSummaries.filter((service) => service.status === "healthy").length,
      degraded: serviceSummaries.filter((service) => service.status === "degraded").length,
      down: serviceSummaries.filter((service) => service.status === "down").length
    },
    checks_recorded: persistedChecks.length,
    incidents: incidentActions.map(({ action, incident }) => ({
      action,
      id: incident.id,
      service_name: incident.service_name,
      incident_type: incident.incident_type,
      severity: incident.severity,
      status: incident.status,
      consecutive_failures: incident.consecutive_failures
    })),
    warnings: persistenceWarnings,
    services: serviceSummaries
  };
}

function toHealthCheck(row) {
  return {
    id: row.id,
    service_name: row.service_name,
    service_url: row.service_url,
    check_type: row.check_type,
    status: row.status,
    http_status: row.http_status,
    latency_ms: row.latency_ms,
    response_summary: row.response_summary || {},
    error_message: row.error_message,
    checked_at: row.checked_at
  };
}

function toIncident(row) {
  return {
    id: row.id,
    service_name: row.service_name,
    incident_type: row.incident_type,
    severity: row.severity,
    status: row.status,
    first_detected_at: row.first_detected_at,
    last_detected_at: row.last_detected_at,
    resolved_at: row.resolved_at,
    consecutive_failures: row.consecutive_failures,
    summary: row.summary,
    metadata: row.metadata || {}
  };
}

function toRsmEvent(row) {
  return {
    id: row.id,
    term: row.term,
    log_index: row.log_index,
    event_type: row.event_type,
    command: row.command || {},
    status: row.status,
    created_at: row.created_at
  };
}

app.get("/health", (req, res) => {
  res.json({
    service: "monitoring-service",
    status: "healthy",
    databaseConfigured: isDatabaseConfigured(),
    schedulerEnabled: ENABLE_MONITORING_SCHEDULER,
    timestamp: new Date().toISOString()
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
    } catch (error) {
      database = {
        status: "down",
        latencyMs: 0,
        schema: {
          status: "unknown",
          missingTables: [],
          missingColumns: []
        },
        error: error.code === "MISSING_MONITORING_DATABASE_URL"
          ? "Monitoring database is not configured"
          : "Monitoring database is unavailable"
      };
    }

    const isHealthy =
      database.status === "up" &&
      database.schema &&
      database.schema.status === "ready";

    return res.status(isHealthy ? 200 : 503).json({
      service: "monitoring-service",
      status: isHealthy ? "healthy" : "degraded",
      database,
      scheduler: {
        enabled: ENABLE_MONITORING_SCHEDULER,
        intervalSeconds: CHECK_INTERVAL_SECONDS
      },
      timestamp: new Date().toISOString()
    });
  })
);

app.get("/monitoring/services", (req, res) => {
  return res.json({
    data: monitoredServices.map(toMonitoredService)
  });
});

app.post(
  "/monitoring/checks/run",
  asyncHandler(async (req, res) => {
    const summary = await runMonitoringCycle();

    return res.json({
      message: "Monitoring check cycle completed",
      data: summary
    });
  })
);

app.get(
  "/monitoring/checks",
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

    const status = normalizeOptionalEnum(req.query.status, "status", allowedHealthStatuses);

    if (status) {
      filters.push(`status = ${addParam(status)}`);
    }

    const checkType = normalizeOptionalEnum(req.query.check_type, "check_type", allowedCheckTypes);

    if (checkType) {
      filters.push(`check_type = ${addParam(checkType)}`);
    }

    const startDate = normalizeDateQuery(req.query.start_date, "start_date");
    const endDate = normalizeDateQuery(req.query.end_date, "end_date");

    if (startDate) {
      filters.push(`checked_at >= ${addParam(startDate)}`);
    }

    if (endDate) {
      filters.push(`checked_at <= ${addParam(endDate)}`);
    }

    const limit = parseIntegerQuery(req.query.limit, "limit", 50, { min: 1, max: 500 });
    const offset = parseIntegerQuery(req.query.offset, "offset", 0, { min: 0 });
    const whereSql = filters.length > 0 ? `where ${filters.join(" and ")}` : "";

    params.push(limit);
    const limitPlaceholder = `$${params.length}`;
    params.push(offset);
    const offsetPlaceholder = `$${params.length}`;

    const result = await runQuery(
      `select
         id,
         service_name,
         service_url,
         check_type,
         status,
         http_status,
         latency_ms,
         response_summary,
         error_message,
         checked_at
       from public.service_health_checks
       ${whereSql}
       order by checked_at desc
       limit ${limitPlaceholder}
       offset ${offsetPlaceholder}`,
      params
    );

    return res.json({
      data: result.rows.map(toHealthCheck),
      pagination: {
        limit,
        offset,
        count: result.rowCount
      }
    });
  })
);

app.get(
  "/monitoring/incidents",
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

    const status = normalizeOptionalEnum(req.query.status, "status", allowedIncidentStatuses);

    if (status) {
      filters.push(`status = ${addParam(status)}`);
    }

    const severity = normalizeOptionalEnum(req.query.severity, "severity", allowedSeverities);

    if (severity) {
      filters.push(`severity = ${addParam(severity)}`);
    }

    const incidentType = normalizeOptionalEnum(req.query.incident_type, "incident_type", allowedIncidentTypes);

    if (incidentType) {
      filters.push(`incident_type = ${addParam(incidentType)}`);
    }

    const limit = parseIntegerQuery(req.query.limit, "limit", 50, { min: 1, max: 500 });
    const offset = parseIntegerQuery(req.query.offset, "offset", 0, { min: 0 });
    const whereSql = filters.length > 0 ? `where ${filters.join(" and ")}` : "";

    params.push(limit);
    const limitPlaceholder = `$${params.length}`;
    params.push(offset);
    const offsetPlaceholder = `$${params.length}`;

    const result = await runQuery(
      `select
         id,
         service_name,
         incident_type,
         severity,
         status,
         first_detected_at,
         last_detected_at,
         resolved_at,
         consecutive_failures,
         summary,
         metadata
       from public.monitoring_incidents
       ${whereSql}
       order by last_detected_at desc
       limit ${limitPlaceholder}
       offset ${offsetPlaceholder}`,
      params
    );

    return res.json({
      data: result.rows.map(toIncident),
      pagination: {
        limit,
        offset,
        count: result.rowCount
      }
    });
  })
);

app.get(
  "/monitoring/incidents/:id",
  asyncHandler(async (req, res) => {
    const incidentId = assertUuid(req.params.id, "id");
    const result = await runQuery(
      `select
         id,
         service_name,
         incident_type,
         severity,
         status,
         first_detected_at,
         last_detected_at,
         resolved_at,
         consecutive_failures,
         summary,
         metadata
       from public.monitoring_incidents
       where id = $1
       limit 1`,
      [incidentId]
    );

    if (result.rowCount === 0) {
      throw new ApiError(404, "Incident not found");
    }

    return res.json({
      data: toIncident(result.rows[0])
    });
  })
);

app.post(
  "/monitoring/incidents/:id/acknowledge",
  asyncHandler(async (req, res) => {
    const incidentId = assertUuid(req.params.id, "id");
    const result = await runQuery(
      `update public.monitoring_incidents
       set status = case when status = 'resolved' then status else 'acknowledged' end
       where id = $1
       returning
         id,
         service_name,
         incident_type,
         severity,
         status,
         first_detected_at,
         last_detected_at,
         resolved_at,
         consecutive_failures,
         summary,
         metadata`,
      [incidentId]
    );

    if (result.rowCount === 0) {
      throw new ApiError(404, "Incident not found");
    }

    const incident = toIncident(result.rows[0]);

    await logAuditEvent("MONITORING_INCIDENT_ACKNOWLEDGED", {
      severity: "medium",
      action: "monitoring_incident_acknowledged",
      resource_type: "monitoring_incident",
      resource_id: incident.id,
      endpoint: "/monitoring/incidents/:id/acknowledge",
      method: "POST",
      status: incident.status,
      status_code: 200,
      metadata: {
        service_name: incident.service_name,
        incident_type: incident.incident_type
      }
    });

    return res.json({
      message: "Incident acknowledged",
      data: incident
    });
  })
);

app.post(
  "/monitoring/incidents/:id/resolve",
  asyncHandler(async (req, res) => {
    const incidentId = assertUuid(req.params.id, "id");
    const result = await runQuery(
      `update public.monitoring_incidents
       set status = 'resolved',
           resolved_at = coalesce(resolved_at, now())
       where id = $1
       returning
         id,
         service_name,
         incident_type,
         severity,
         status,
         first_detected_at,
         last_detected_at,
         resolved_at,
         consecutive_failures,
         summary,
         metadata`,
      [incidentId]
    );

    if (result.rowCount === 0) {
      throw new ApiError(404, "Incident not found");
    }

    const incident = toIncident(result.rows[0]);

    await logAuditEvent("MONITORING_INCIDENT_RESOLVED", {
      severity: "info",
      action: "monitoring_incident_resolved",
      resource_type: "monitoring_incident",
      resource_id: incident.id,
      endpoint: "/monitoring/incidents/:id/resolve",
      method: "POST",
      status: incident.status,
      status_code: 200,
      metadata: {
        service_name: incident.service_name,
        incident_type: incident.incident_type
      }
    });

    return res.json({
      message: "Incident resolved",
      data: incident
    });
  })
);

app.get(
  "/monitoring/summary",
  asyncHandler(async (req, res) => {
    const latestChecksResult = await runQuery(
      `select distinct on (service_name)
         id,
         service_name,
         service_url,
         check_type,
         status,
         http_status,
         latency_ms,
         response_summary,
         error_message,
         checked_at
       from public.service_health_checks
       order by service_name, checked_at desc`
    );
    const latestChecks = latestChecksResult.rows.map(toHealthCheck);
    const openIncidentsResult = await runQuery(
      `select
         count(*)::int as open_incidents,
         count(*) filter (where severity = 'critical')::int as critical_incidents
       from public.monitoring_incidents
       where status in ('open', 'acknowledged')`
    );
    const latestIncidentsResult = await runQuery(
      `select
         id,
         service_name,
         incident_type,
         severity,
         status,
         first_detected_at,
         last_detected_at,
         resolved_at,
         consecutive_failures,
         summary,
         metadata
       from public.monitoring_incidents
       order by last_detected_at desc
       limit 10`
    );

    const latestStatusByService = new Map(latestChecks.map((check) => [check.service_name, check.status]));

    return res.json({
      data: {
        total_services: monitoredServices.length,
        healthy_services: monitoredServices.filter((service) => latestStatusByService.get(service.service_name) === "healthy").length,
        degraded_services: monitoredServices.filter((service) => latestStatusByService.get(service.service_name) === "degraded").length,
        down_services: monitoredServices.filter((service) => latestStatusByService.get(service.service_name) === "down").length,
        open_incidents: openIncidentsResult.rows[0].open_incidents,
        critical_incidents: openIncidentsResult.rows[0].critical_incidents,
        latest_checks: latestChecks,
        latest_incidents: latestIncidentsResult.rows.map(toIncident)
      }
    });
  })
);

app.get("/monitoring/topology", (req, res) => {
  return res.json({
    data: {
      nodes: [
        "api-gateway",
        "auth-service",
        "events-service",
        "booking-service",
        "ticket-service",
        "payment-service",
        "notification-service",
        "audit-service",
        "saga-service",
        "monitoring-service",
        "smtp-provider",
        "auth-db",
        "events-db",
        "booking-db",
        "ticket-db",
        "payment-db",
        "notification-db",
        "audit-db",
        "saga-db",
        "monitoring-db"
      ],
      dependencies: [
        { from: "api-gateway", to: "auth-service" },
        { from: "api-gateway", to: "events-service" },
        { from: "api-gateway", to: "booking-service" },
        { from: "api-gateway", to: "ticket-service" },
        { from: "api-gateway", to: "payment-service" },
        { from: "api-gateway", to: "notification-service" },
        { from: "api-gateway", to: "audit-service" },
        { from: "api-gateway", to: "saga-service" },
        { from: "saga-service", to: "booking-service" },
        { from: "saga-service", to: "payment-service" },
        { from: "saga-service", to: "ticket-service" },
        { from: "saga-service", to: "notification-service" },
        { from: "saga-service", to: "audit-service" },
        { from: "ticket-service", to: "booking-service" },
        { from: "ticket-service", to: "payment-service" },
        { from: "ticket-service", to: "events-service" },
        { from: "ticket-service", to: "auth-service" },
        { from: "booking-service", to: "events-service" },
        { from: "payment-service", to: "booking-service" },
        { from: "notification-service", to: "smtp-provider" },
        { from: "notification-service", to: "notification-db" },
        { from: "audit-service", to: "audit-db" },
        { from: "events-service", to: "auth-service" },
        { from: "events-service", to: "audit-service" },
        { from: "monitoring-service", to: "auth-service" },
        { from: "monitoring-service", to: "events-service" },
        { from: "monitoring-service", to: "booking-service" },
        { from: "monitoring-service", to: "ticket-service" },
        { from: "monitoring-service", to: "payment-service" },
        { from: "monitoring-service", to: "notification-service" },
        { from: "monitoring-service", to: "audit-service" },
        { from: "monitoring-service", to: "saga-service" },
        { from: "monitoring-service", to: "api-gateway" },
        { from: "monitoring-service", to: "monitoring-db" }
      ]
    }
  });
});

app.get("/monitoring/distributed-model", (req, res) => {
  return res.json({
    data: {
      estimated_number_of_servers: "At least 9 app services + 9 service-owned databases + frontend/deployment nodes.",
      fault_tolerance: "Services fail independently. The platform degrades gracefully by isolating failures behind HTTP service boundaries. The monitoring service detects down/degraded states, records incidents, sends alerts, and keeps audit evidence without blocking business services.",
      message_ordering: "saga_steps and rsm_events provide ordered logs. Per-saga order is total within each saga. Global monitoring ordering uses checked_at, created_at, and rsm_events.log_index.",
      broadcast_model: "Monitoring models health-check broadcast to all services. In a synchronous setting it waits for all replies or timeout. In an asynchronous setting it records late or missing replies as degraded/down observations.",
      leader_election_proposal: "If multiple monitoring-service instances run, use a database-backed leader lease. Only the instance holding the unexpired lease performs scheduled checks; followers can serve read APIs and take over when the lease expires.",
      replicated_state_machine_design: "The rsm_events table models committed monitoring, saga, and incident commands as an append-only ordered log. Each command has a term, log_index, event_type, command payload, status, and timestamp."
    }
  });
});

app.post(
  "/monitoring/rsm/events",
  asyncHandler(async (req, res) => {
    const eventType = normalizeRsmEventType(req.body.event_type);
    const command = normalizeJsonObject(req.body.command, "command");
    const term = normalizePositiveInteger(req.body.term, "term", 1);
    const status = normalizeOptionalEnum(req.body.status || "committed", "status", allowedRsmStatuses) || "committed";
    const result = await runQuery(
      `insert into public.rsm_events (
         term,
         event_type,
         command,
         status
       )
       values ($1, $2, $3::jsonb, $4)
       returning id, term, log_index, event_type, command, status, created_at`,
      [term, eventType, JSON.stringify(command), status]
    );
    const event = toRsmEvent(result.rows[0]);

    await logAuditEvent("RSM_EVENT_APPENDED", {
      severity: "info",
      action: "rsm_event_appended",
      resource_type: "rsm_event",
      resource_id: event.id,
      endpoint: "/monitoring/rsm/events",
      method: "POST",
      status: event.status,
      status_code: 201,
      metadata: {
        event_type: event.event_type,
        term: event.term,
        log_index: event.log_index
      }
    });

    return res.status(201).json({
      message: "RSM event appended",
      data: event
    });
  })
);

app.get(
  "/monitoring/rsm/events",
  asyncHandler(async (req, res) => {
    const limit = parseIntegerQuery(req.query.limit, "limit", 50, { min: 1, max: 500 });
    const offset = parseIntegerQuery(req.query.offset, "offset", 0, { min: 0 });
    const result = await runQuery(
      `select id, term, log_index, event_type, command, status, created_at
       from public.rsm_events
       order by log_index asc
       limit $1
       offset $2`,
      [limit, offset]
    );

    return res.json({
      data: result.rows.map(toRsmEvent),
      pagination: {
        limit,
        offset,
        count: result.rowCount
      }
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
      message: "Monitoring database is temporarily unavailable",
      service: "monitoring-service"
    });
  }

  if (error.code === "23514" || error.code === "22P02") {
    return res.status(400).json({
      message: "Request violates a database constraint"
    });
  }

  return res.status(500).json({
    message: "Internal server error",
    service: "monitoring-service"
  });
});

// Automatic monitoring scheduler disabled.
// Monitoring checks must be triggered manually from the System Admin dashboard via POST /monitoring/checks/run.

process.on("SIGINT", async () => {
  await closePool();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await closePool();
  process.exit(0);
});

app.listen(PORT, () => {
  console.log(`Monitoring Service running on port ${PORT}`);
});

