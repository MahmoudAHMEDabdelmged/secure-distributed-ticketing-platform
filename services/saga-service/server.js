const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const QRCode = require("qrcode");
require("dotenv").config();

const { query, checkDatabaseConnection, checkDatabaseSchema, closePool } = require("./db");

const app = express();
const PORT = process.env.PORT || 5007;

const BOOKING_SERVICE_URL = process.env.BOOKING_SERVICE_URL || "http://localhost:5002";
const PAYMENT_SERVICE_URL = process.env.PAYMENT_SERVICE_URL || "http://localhost:5004";
const TICKET_SERVICE_URL = process.env.TICKET_SERVICE_URL || "http://localhost:5003";
const NOTIFICATION_SERVICE_URL = process.env.NOTIFICATION_SERVICE_URL || "http://localhost:5005";
const AUDIT_SERVICE_URL = process.env.AUDIT_SERVICE_URL || "http://localhost:5006";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const retryableStatuses = ["pending_ticket", "pending_notification", "completed_with_notification_failed"];
const completedStatuses = ["completed", "notification_sent", "completed_with_notification_failed"];
const sensitiveKeys = [
  "password",
  "token",
  "authorization",
  "card_number",
  "cardnumber",
  "cvv",
  "card_cvv",
  "smtp_pass",
  "smtppass",
  "secret",
  "private_key",
  "privatekey",
  "api_key",
  "apikey",
  "jwt",
  "verification_url",
  "qr_code_data_url",
  "verification_token",
  "raw_qr_token"
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
  console.error("Saga-service internal error:", {
    method: req.method,
    path: sanitizePath(req.originalUrl),
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
  console.error(`${label} dependency error:`, {
    message: error.message,
    name: error.name,
    code: error.code
  });
}

function sanitizePath(path) {
  return String(path)
    .replace(/\/sagas\/idempotency\/[^/?#]+/g, "/sagas/idempotency/[idempotencyKey]")
    .replace(/\/sagas\/[^/?#]+/g, "/sagas/[id]");
}

function isDatabaseConnectivityError(error) {
  return [
    "MISSING_SAGA_DATABASE_URL",
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

function assertUuid(value, fieldName) {
  if (typeof value !== "string" || !uuidPattern.test(value)) {
    throw new ApiError(400, `${fieldName} must be a valid UUID`);
  }

  return value;
}

function normalizeUuid(value, fieldName) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  return assertUuid(value, fieldName);
}

function assertPositiveInteger(value, fieldName) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ApiError(400, `${fieldName} must be a positive integer`);
  }

  return value;
}

function assertNonNegativeInteger(value, fieldName) {
  if (!Number.isInteger(value) || value < 0) {
    throw new ApiError(400, `${fieldName} must be a non-negative integer`);
  }

  return value;
}

function normalizeCurrency(value) {
  const currency = assertRequiredString(value, "currency", 10).toUpperCase();

  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new ApiError(400, "currency must be a 3-letter string");
  }

  return currency;
}

function normalizeEmail(value, fieldName) {
  const email = assertRequiredString(value, fieldName, 320).toLowerCase();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ApiError(400, `${fieldName} must be a valid email address`);
  }

  return email;
}

function normalizeCardNumber(value) {
  if (typeof value !== "string") {
    throw new ApiError(400, "payment.card_number must be a string");
  }

  const cardNumber = value.replace(/\s+/g, "");

  if (!/^\d+$/.test(cardNumber) || cardNumber.length < 12) {
    throw new ApiError(400, "payment.card_number must contain at least 12 digits");
  }

  return cardNumber;
}

function parseIntegerQuery(value, fieldName, defaultValue, options = {}) {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }

  const parsedValue = Number.parseInt(value, 10);

  if (!Number.isInteger(parsedValue)) {
    throw new ApiError(400, `${fieldName} must be an integer`);
  }

  if (options.min !== undefined && parsedValue < options.min) {
    throw new ApiError(400, `${fieldName} is too small`);
  }

  if (options.max !== undefined && parsedValue > options.max) {
    throw new ApiError(400, `${fieldName} is too large`);
  }

  return parsedValue;
}

function normalizeDateQuery(value, fieldName) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new ApiError(400, `${fieldName} must be a valid date`);
  }

  return date.toISOString();
}

function redactSensitiveValues(value) {
  if (Array.isArray(value)) {
    return value.map(redactSensitiveValues);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const redacted = {};

  for (const [key, childValue] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase().replace(/[-\s]/g, "_");

    if (sensitiveKeys.includes(normalizedKey)) {
      redacted[key] = "[redacted]";
      continue;
    }

    redacted[key] = redactSensitiveValues(childValue);
  }

  return redacted;
}

function normalizeMetadata(value) {
  if (value === undefined || value === null) {
    return {};
  }

  if (Array.isArray(value) || typeof value !== "object") {
    throw new ApiError(400, "metadata must be an object");
  }

  return redactSensitiveValues(value);
}

function sanitizePayload(value) {
  const redacted = redactSensitiveValues(value || {});

  if (redacted && typeof redacted === "object" && !Array.isArray(redacted)) {
    return JSON.parse(JSON.stringify(redacted, (key, childValue) => {
      if (typeof childValue === "string" && childValue.length > 1000) {
        return `${childValue.slice(0, 200)}...[truncated]`;
      }

      return childValue;
    }));
  }

  return redacted;
}

function extractCardLast4(cardNumber) {
  return cardNumber.slice(-4);
}

async function fetchWithTimeout(url, options = {}) {
  if (typeof fetch !== "function") {
    throw new Error("Global fetch is not available in this Node.js runtime");
  }

  const timeoutMs = options.timeoutMs || 8000;
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

async function requestJson(serviceName, url, options = {}) {
  try {
    const headers = {
      accept: "application/json",
      ...(options.headers || {})
    };

    let body;

    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(options.body);
    }

    const response = await fetchWithTimeout(url, {
      method: options.method || "GET",
      headers,
      body,
      timeoutMs: options.timeoutMs || 8000
    });

    const responseText = await response.text();
    let payload = {};

    if (responseText) {
      try {
        payload = JSON.parse(responseText);
      } catch (error) {
        payload = {
          message: "Dependency returned non-JSON response"
        };
      }
    }

    return {
      ok: response.ok,
      statusCode: response.status,
      payload
    };
  } catch (error) {
    logDependencyError(serviceName, error);

    return {
      ok: false,
      statusCode: 0,
      payload: {
        message: `${serviceName} unavailable`
      },
      networkError: true,
      errorMessage: error.name === "AbortError" ? `${serviceName} request timed out` : error.message
    };
  }
}

async function checkDependencyHealth(name, url) {
  const startedAt = Date.now();
  const result = await requestJson(name, `${url}/health`, {
    timeoutMs: 3000
  });

  return {
    status: result.ok ? "up" : "down",
    statusCode: result.statusCode || null,
    latencyMs: Date.now() - startedAt,
    error: result.ok ? undefined : result.payload.message || result.errorMessage || `${name} health check failed`
  };
}

const sagaSelectSql = `
  select
    id,
    idempotency_key,
    saga_type,
    status,
    user_id,
    booking_id,
    payment_id,
    ticket_ids,
    notification_ids,
    event_id,
    section_id,
    quantity,
    amount_cents,
    currency,
    current_step,
    failure_reason,
    retry_count,
    max_retries,
    is_retryable,
    metadata,
    created_at,
    updated_at,
    completed_at
  from public.saga_flows
`;

const stepSelectSql = `
  select
    id,
    saga_id,
    step_name,
    status,
    attempt_count,
    request_payload,
    response_payload,
    error_message,
    started_at,
    completed_at
  from public.saga_steps
`;

function toSaga(row) {
  return {
    id: row.id,
    idempotency_key: row.idempotency_key,
    saga_type: row.saga_type,
    status: row.status,
    user_id: row.user_id,
    booking_id: row.booking_id,
    payment_id: row.payment_id,
    ticket_ids: Array.isArray(row.ticket_ids) ? row.ticket_ids : [],
    notification_ids: Array.isArray(row.notification_ids) ? row.notification_ids : [],
    event_id: row.event_id,
    section_id: row.section_id,
    quantity: row.quantity,
    amount_cents: row.amount_cents,
    currency: row.currency,
    current_step: row.current_step,
    failure_reason: row.failure_reason,
    retry_count: row.retry_count,
    max_retries: row.max_retries,
    is_retryable: row.is_retryable,
    metadata: row.metadata || {},
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at
  };
}

function toStep(row) {
  return {
    id: row.id,
    saga_id: row.saga_id,
    step_name: row.step_name,
    status: row.status,
    attempt_count: row.attempt_count,
    request_payload: row.request_payload || {},
    response_payload: row.response_payload || {},
    error_message: row.error_message,
    started_at: row.started_at,
    completed_at: row.completed_at
  };
}

async function getSagaById(id) {
  const result = await runQuery(`${sagaSelectSql} where id = $1 limit 1`, [id]);
  return result.rows[0] ? toSaga(result.rows[0]) : null;
}

async function getSagaByIdempotencyKey(idempotencyKey) {
  const result = await runQuery(`${sagaSelectSql} where idempotency_key = $1 limit 1`, [idempotencyKey]);
  return result.rows[0] ? toSaga(result.rows[0]) : null;
}

async function getSagaSteps(sagaId) {
  const result = await runQuery(
    `${stepSelectSql}
     where saga_id = $1
     order by started_at asc`,
    [sagaId]
  );

  return result.rows.map(toStep);
}

async function getSagaWithSteps(saga) {
  return {
    saga,
    steps: await getSagaSteps(saga.id)
  };
}

async function updateSagaFields(sagaId, fields) {
  const allowedColumns = new Set([
    "status",
    "booking_id",
    "payment_id",
    "ticket_ids",
    "notification_ids",
    "current_step",
    "failure_reason",
    "retry_count",
    "max_retries",
    "is_retryable",
    "metadata",
    "completed_at"
  ]);
  const entries = Object.entries(fields).filter(([column]) => allowedColumns.has(column));

  if (entries.length === 0) {
    return getSagaById(sagaId);
  }

  const params = [];
  const assignments = entries.map(([column, value]) => {
    params.push(column === "metadata" ? JSON.stringify(value || {}) : value);
    const placeholder = `$${params.length}`;

    if (column === "metadata") {
      return `${column} = ${placeholder}::jsonb`;
    }

    if (column === "ticket_ids" || column === "notification_ids") {
      return `${column} = ${placeholder}::uuid[]`;
    }

    return `${column} = ${placeholder}`;
  });

  params.push(sagaId);
  const result = await runQuery(
    `update public.saga_flows
     set ${assignments.join(", ")}
     where id = $${params.length}
     returning
       id,
       idempotency_key,
       saga_type,
       status,
       user_id,
       booking_id,
       payment_id,
       ticket_ids,
       notification_ids,
       event_id,
       section_id,
       quantity,
       amount_cents,
       currency,
       current_step,
       failure_reason,
       retry_count,
       max_retries,
       is_retryable,
       metadata,
       created_at,
       updated_at,
       completed_at`,
    params
  );

  return toSaga(result.rows[0]);
}

async function recordStep(sagaId, stepName, status, requestPayload, responsePayload, errorMessage, attemptCount = 1) {
  const result = await runQuery(
    `insert into public.saga_steps (
      saga_id,
      step_name,
      status,
      attempt_count,
      request_payload,
      response_payload,
      error_message,
      completed_at
    )
    values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, now())
    returning
      id,
      saga_id,
      step_name,
      status,
      attempt_count,
      request_payload,
      response_payload,
      error_message,
      started_at,
      completed_at`,
    [
      sagaId,
      stepName,
      status,
      attemptCount,
      JSON.stringify(sanitizePayload(requestPayload)),
      JSON.stringify(sanitizePayload(responsePayload)),
      errorMessage || null
    ]
  );

  return toStep(result.rows[0]);
}

async function logAuditEvent(saga, eventType, severity, action, metadata = {}) {
  const payload = {
    event_type: eventType,
    service_name: "saga-service",
    severity,
    actor_user_id: saga.user_id,
    action,
    resource_type: "saga",
    resource_id: saga.id,
    endpoint: "/sagas/ticket-purchase",
    method: "POST",
    status: saga.status,
    is_suspicious: eventType.includes("SUSPICIOUS") || metadata.is_suspicious === true,
    suspicious_reason: metadata.suspicious_reason || null,
    metadata: {
      saga_id: saga.id,
      booking_id: saga.booking_id,
      payment_id: saga.payment_id,
      ...redactSensitiveValues(metadata)
    }
  };
  const result = await requestJson("Audit Service", `${AUDIT_SERVICE_URL}/audit/logs`, {
    method: "POST",
    body: payload,
    timeoutMs: 4000
  });

  if (!result.ok) {
    await recordStep(
      saga.id,
      "audit_log",
      "failed",
      {
        event_type: eventType
      },
      result.payload,
      result.payload.message || result.errorMessage || "Audit Service unavailable"
    );
  }

  return result;
}

function dependencyStatusCode(result, fallback = 502) {
  if (!result.statusCode) {
    return 503;
  }

  if (result.statusCode >= 500) {
    return 502;
  }

  return fallback;
}

function createTicketPurchaseInput(body) {
  const payment = body.payment && typeof body.payment === "object" && !Array.isArray(body.payment)
    ? body.payment
    : null;
  const notification = body.notification && typeof body.notification === "object" && !Array.isArray(body.notification)
    ? body.notification
    : null;

  if (!payment) {
    throw new ApiError(400, "payment is required");
  }

  if (!notification) {
    throw new ApiError(400, "notification is required");
  }

  const cardNumber = normalizeCardNumber(payment.card_number);
  const cardLast4 = extractCardLast4(cardNumber);
  const recipientEmail = normalizeEmail(notification.recipient_email, "notification.recipient_email");

  return {
    idempotencyKey: assertRequiredString(body.idempotency_key, "idempotency_key", 150),
    userId: assertUuid(body.user_id, "user_id"),
    eventId: assertUuid(body.event_id, "event_id"),
    sectionId: assertUuid(body.section_id, "section_id"),
    quantity: assertPositiveInteger(body.quantity, "quantity"),
    amountCents: assertNonNegativeInteger(body.amount_cents, "amount_cents"),
    currency: normalizeCurrency(body.currency || "EGP"),
    cardNumber,
    cardLast4,
    notification: {
      recipient_email: recipientEmail,
      event_name: normalizeOptionalString(notification.event_name, "notification.event_name", 255),
      section_name: normalizeOptionalString(notification.section_name, "notification.section_name", 255)
    },
    metadata: {
      ...normalizeMetadata(body.metadata),
      card_last4: cardLast4,
      notification_recipient_email: recipientEmail
    }
  };
}

async function createSagaFlow(input) {
  try {
    const result = await runQuery(
      `insert into public.saga_flows (
        idempotency_key,
        saga_type,
        status,
        user_id,
        event_id,
        section_id,
        quantity,
        amount_cents,
        currency,
        current_step,
        metadata
      )
      values ($1, 'ticket_purchase', 'started', $2, $3, $4, $5, $6, $7, 'booking', $8::jsonb)
      returning
        id,
        idempotency_key,
        saga_type,
        status,
        user_id,
        booking_id,
        payment_id,
        ticket_ids,
        notification_ids,
        event_id,
        section_id,
        quantity,
        amount_cents,
        currency,
        current_step,
        failure_reason,
        retry_count,
        max_retries,
        is_retryable,
        metadata,
        created_at,
        updated_at,
        completed_at`,
      [
        input.idempotencyKey,
        input.userId,
        input.eventId,
        input.sectionId,
        input.quantity,
        input.amountCents,
        input.currency,
        JSON.stringify(input.metadata)
      ]
    );

    return toSaga(result.rows[0]);
  } catch (error) {
    if (error.code === "23505") {
      return getSagaByIdempotencyKey(input.idempotencyKey);
    }

    throw error;
  }
}

async function cancelBookingForSaga(saga, reason) {
  if (!saga.booking_id) {
    return {
      attempted: false,
      ok: false,
      reason: "No booking to compensate"
    };
  }

  const result = await requestJson(
    "Booking Service",
    `${BOOKING_SERVICE_URL}/bookings/${encodeURIComponent(saga.booking_id)}/cancel`,
    {
      method: "POST"
    }
  );

  await recordStep(
    saga.id,
    "compensate_booking_cancel",
    result.ok ? "succeeded" : "failed",
    {
      booking_id: saga.booking_id,
      reason
    },
    result.payload,
    result.ok ? null : result.payload.message || result.errorMessage || "Booking compensation failed"
  );

  return {
    attempted: true,
    ok: result.ok,
    statusCode: result.statusCode,
    data: result.payload.data || null,
    message: result.payload.message || null
  };
}

async function refundPaymentForSaga(saga, reason) {
  if (!saga.payment_id) {
    return {
      attempted: false,
      ok: false,
      reason: "No payment to refund"
    };
  }

  const result = await requestJson(
    "Payment Service",
    `${PAYMENT_SERVICE_URL}/payments/${encodeURIComponent(saga.payment_id)}/refund`,
    {
      method: "POST"
    }
  );

  await recordStep(
    saga.id,
    "compensate_payment_refund",
    result.ok ? "succeeded" : "failed",
    {
      payment_id: saga.payment_id,
      reason
    },
    result.payload,
    result.ok ? null : result.payload.message || result.errorMessage || "Payment refund failed"
  );

  return {
    attempted: true,
    ok: result.ok,
    statusCode: result.statusCode,
    data: result.payload.data || null,
    message: result.payload.message || null
  };
}

async function issueTicketsForSaga(saga) {
  const result = await requestJson("Ticket Service", `${TICKET_SERVICE_URL}/tickets/issue`, {
    method: "POST",
    body: {
      booking_id: saga.booking_id
    }
  });
  const tickets = result.payload && result.payload.data && Array.isArray(result.payload.data.tickets)
    ? result.payload.data.tickets
    : [];

  await recordStep(
    saga.id,
    "ticket_issue",
    result.ok && tickets.length > 0 ? "succeeded" : "failed",
    {
      booking_id: saga.booking_id
    },
    {
      statusCode: result.statusCode,
      message: result.payload.message,
      ticket_ids: tickets.map((ticket) => ticket.id),
      ticket_count: tickets.length
    },
    result.ok && tickets.length > 0 ? null : result.payload.message || result.errorMessage || "Ticket issuing failed",
    saga.retry_count + 1
  );

  if (!result.ok || tickets.length === 0) {
    return {
      ok: false,
      result,
      tickets
    };
  }

  return {
    ok: true,
    result,
    tickets
  };
}

async function fetchTicketsForSaga(saga) {
  const result = await requestJson(
    "Ticket Service",
    `${TICKET_SERVICE_URL}/bookings/${encodeURIComponent(saga.booking_id)}/tickets`
  );
  const tickets = result.payload && Array.isArray(result.payload.data) ? result.payload.data : [];

  await recordStep(
    saga.id,
    "ticket_fetch_for_notification",
    result.ok ? "succeeded" : "failed",
    {
      booking_id: saga.booking_id
    },
    {
      statusCode: result.statusCode,
      ticket_ids: tickets.map((ticket) => ticket.id),
      ticket_count: tickets.length
    },
    result.ok ? null : result.payload.message || result.errorMessage || "Ticket lookup failed",
    saga.retry_count + 1
  );

  return {
    ok: result.ok,
    tickets
  };
}

async function sendTicketNotifications(saga, tickets, notification) {
  const notificationIds = [];
  const failures = [];

  for (const ticket of tickets) {
    const recipientEmail = notification.recipient_email || ticket.user_email;
    const eventName = notification.event_name || ticket.event_title || "Ticketed event";
    const sectionName = notification.section_name || ticket.section_name || "Ticket section";
    let qrCodeDataUrl = ticket.qr_code_data_url;

    if (!qrCodeDataUrl && ticket.verification_url) {
      qrCodeDataUrl = await QRCode.toDataURL(ticket.verification_url);
    }

    const requestPayload = {
      recipient_email: recipientEmail,
      booking_id: saga.booking_id,
      ticket_id: ticket.id,
      ticket_number: ticket.ticket_number,
      event_name: eventName,
      section_name: sectionName,
      qr_code_data_url: qrCodeDataUrl,
      verification_url: ticket.verification_url
    };
    const result = await requestJson("Notification Service", `${NOTIFICATION_SERVICE_URL}/notifications/ticket-email`, {
      method: "POST",
      body: requestPayload,
      timeoutMs: 8000
    });
    const delivery = result.payload.data || null;

    if (delivery && delivery.id) {
      notificationIds.push(delivery.id);
    }

    const sent = result.ok && delivery && delivery.status === "sent";

    await recordStep(
      saga.id,
      "notification_ticket_email",
      sent ? "succeeded" : "failed",
      {
        ...requestPayload,
        qr_code_data_url: qrCodeDataUrl ? "[generated]" : null,
        verification_url: ticket.verification_url ? "[present]" : null
      },
      {
        statusCode: result.statusCode,
        notification_id: delivery ? delivery.id : null,
        delivery_status: delivery ? delivery.status : null,
        message: result.payload.message
      },
      sent ? null : result.payload.message || result.errorMessage || "Ticket email notification failed",
      saga.retry_count + 1
    );

    if (!sent) {
      failures.push({
        ticket_id: ticket.id,
        statusCode: result.statusCode,
        message: result.payload.message || result.errorMessage || "Ticket email notification failed"
      });
    }
  }

  return {
    allSent: failures.length === 0,
    notificationIds,
    failures
  };
}

async function completeNotificationStep(saga, tickets, notification) {
  const notificationResult = await sendTicketNotifications(saga, tickets, notification);

  if (notificationResult.allSent) {
    const updatedSaga = await updateSagaFields(saga.id, {
      status: "completed",
      notification_ids: notificationResult.notificationIds,
      current_step: "completed",
      is_retryable: false,
      failure_reason: null,
      completed_at: new Date()
    });

    await logAuditEvent(updatedSaga, "NOTIFICATION_SENT", "info", "ticket_email_sent", {
      notification_ids: notificationResult.notificationIds,
      ticket_count: tickets.length
    });
    await logAuditEvent(updatedSaga, "SAGA_COMPLETED", "info", "ticket_purchase_saga_completed", {
      ticket_count: tickets.length
    });

    return {
      saga: updatedSaga,
      message: "Ticket purchase saga completed",
      statusCode: 201
    };
  }

  const updatedSaga = await updateSagaFields(saga.id, {
    status: "completed_with_notification_failed",
    notification_ids: notificationResult.notificationIds,
    current_step: "notification",
    is_retryable: saga.retry_count < saga.max_retries,
    failure_reason: "Ticket notification failed; tickets remain valid",
    completed_at: new Date()
  });

  await logAuditEvent(updatedSaga, "NOTIFICATION_FAILED", "low", "ticket_email_notification_failed", {
    failures: notificationResult.failures,
    ticket_count: tickets.length
  });

  return {
    saga: updatedSaga,
    message: "Ticket purchase completed, but notification failed",
    statusCode: 202
  };
}

app.get("/health", (req, res) => {
  res.json({
    service: "saga-service",
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
      logDependencyError("Saga database", error);

      database = {
        status: "down",
        latencyMs: 0,
        schema: {
          status: "unknown",
          tables: {
            saga_flows: false,
            saga_steps: false
          },
          missingTables: ["saga_flows", "saga_steps"],
          missingColumns: {}
        },
        error: "Saga database is unavailable"
      };
    }

    const dependencies = {
      bookingService: await checkDependencyHealth("Booking Service", BOOKING_SERVICE_URL),
      paymentService: await checkDependencyHealth("Payment Service", PAYMENT_SERVICE_URL),
      ticketService: await checkDependencyHealth("Ticket Service", TICKET_SERVICE_URL),
      notificationService: await checkDependencyHealth("Notification Service", NOTIFICATION_SERVICE_URL),
      auditService: await checkDependencyHealth("Audit Service", AUDIT_SERVICE_URL)
    };
    const dependenciesHealthy = Object.values(dependencies).every((dependency) => dependency.status === "up");
    const isHealthy =
      database.status === "up" &&
      database.schema &&
      database.schema.status === "ready" &&
      dependenciesHealthy;

    return res.status(isHealthy ? 200 : 503).json({
      service: "saga-service",
      status: isHealthy ? "healthy" : "degraded",
      database,
      dependencies,
      timestamp: new Date().toISOString()
    });
  })
);

app.post(
  "/sagas/ticket-purchase",
  asyncHandler(async (req, res) => {
    const input = createTicketPurchaseInput(req.body);
    const existingSaga = await getSagaByIdempotencyKey(input.idempotencyKey);

    if (existingSaga) {
      return res.json({
        message: "Saga already exists",
        data: await getSagaWithSteps(existingSaga)
      });
    }

    let saga = await createSagaFlow(input);

    await recordStep(saga.id, "saga_started", "succeeded", {
      idempotency_key: input.idempotencyKey,
      user_id: input.userId,
      event_id: input.eventId,
      section_id: input.sectionId,
      quantity: input.quantity,
      amount_cents: input.amountCents,
      currency: input.currency,
      card_last4: input.cardLast4,
      notification: input.notification,
      metadata: input.metadata
    }, {
      saga_id: saga.id
    });
    await logAuditEvent(saga, "SAGA_STARTED", "info", "ticket_purchase_saga_started", {
      event_id: input.eventId,
      section_id: input.sectionId,
      quantity: input.quantity
    });

    const bookingRequest = {
      user_id: input.userId,
      user_email: input.notification.recipient_email,
      event_id: input.eventId,
      section_id: input.sectionId,
      quantity: input.quantity
    };
    const bookingResponse = await requestJson("Booking Service", `${BOOKING_SERVICE_URL}/bookings`, {
      method: "POST",
      body: bookingRequest
    });
    const booking = bookingResponse.payload.data || null;

    if (!bookingResponse.ok || !booking) {
      saga = await updateSagaFields(saga.id, {
        status: "failed",
        current_step: "booking",
        failure_reason: bookingResponse.payload.message || bookingResponse.errorMessage || "Booking creation failed",
        is_retryable: false,
        completed_at: new Date()
      });
      await recordStep(saga.id, "booking_create", "failed", bookingRequest, bookingResponse.payload, saga.failure_reason);
      await logAuditEvent(saga, "SAGA_FAILED", "medium", "booking_creation_failed", {
        statusCode: bookingResponse.statusCode,
        message: saga.failure_reason
      });

      return res.status(dependencyStatusCode(bookingResponse)).json({
        message: "Saga failed during booking creation",
        data: await getSagaWithSteps(saga)
      });
    }

    await recordStep(saga.id, "booking_create", "succeeded", bookingRequest, {
      booking_id: booking.id,
      status: booking.status,
      total_price_cents: booking.total_price_cents,
      currency: booking.currency
    });
    saga = await updateSagaFields(saga.id, {
      status: "booking_created",
      booking_id: booking.id,
      current_step: "payment"
    });
    await logAuditEvent(saga, "BOOKING_CREATED", "info", "booking_created_by_saga", {
      booking_id: booking.id
    });

    const paymentRequest = {
      booking_id: booking.id,
      user_id: input.userId,
      user_email: input.notification.recipient_email,
      amount_cents: input.amountCents,
      currency: input.currency,
      payment_method: "test_card",
      card_number: input.cardNumber
    };
    const paymentResponse = await requestJson("Payment Service", `${PAYMENT_SERVICE_URL}/payments`, {
      method: "POST",
      body: paymentRequest
    });
    const payment = paymentResponse.payload.data || null;

    if (!payment) {
      saga = await updateSagaFields(saga.id, {
        status: "failed",
        current_step: "payment",
        failure_reason: paymentResponse.payload.message || paymentResponse.errorMessage || "Payment Service unavailable",
        is_retryable: false,
        completed_at: new Date()
      });
      await recordStep(saga.id, "payment_process", "failed", {
        ...paymentRequest,
        card_number: "[redacted]",
        card_last4: input.cardLast4
      }, paymentResponse.payload, saga.failure_reason);
      await cancelBookingForSaga(saga, "payment_service_unavailable");
      await logAuditEvent(saga, "SERVICE_UNAVAILABLE", "high", "payment_service_unavailable_during_saga", {
        statusCode: paymentResponse.statusCode,
        message: saga.failure_reason
      });

      return res.status(503).json({
        message: "Saga failed because payment could not be processed",
        data: await getSagaWithSteps(saga)
      });
    }

    await recordStep(saga.id, "payment_process", payment.status, {
      ...paymentRequest,
      card_number: "[redacted]",
      card_last4: input.cardLast4
    }, {
      payment_id: payment.id,
      status: payment.status,
      card_last4: payment.card_last4,
      risk_score: payment.risk_score,
      is_suspicious: payment.is_suspicious,
      failure_reason: payment.failure_reason,
      suspicious_reason: payment.suspicious_reason
    }, payment.status === "succeeded" ? null : payment.failure_reason || payment.suspicious_reason || null);

    if (payment.status === "failed" || payment.status === "suspicious") {
      const status = payment.status === "suspicious" ? "payment_suspicious" : "payment_failed";
      saga = await updateSagaFields(saga.id, {
        status,
        payment_id: payment.id,
        current_step: "payment",
        failure_reason: payment.failure_reason || payment.suspicious_reason || `Payment ${payment.status}`,
        is_retryable: false,
        completed_at: new Date()
      });
      const compensation = await cancelBookingForSaga(saga, status);
      const auditEvent = payment.status === "suspicious" ? "PAYMENT_SUSPICIOUS" : "PAYMENT_FAILED";

      await logAuditEvent(saga, auditEvent, payment.status === "suspicious" ? "high" : "medium", `${status}_by_saga`, {
        payment_id: payment.id,
        booking_id: booking.id,
        risk_score: payment.risk_score,
        card_last4: payment.card_last4,
        is_suspicious: payment.is_suspicious,
        suspicious_reason: payment.suspicious_reason,
        compensation
      });

      return res.json({
        message: payment.status === "suspicious" ? "Saga stopped because payment was suspicious" : "Saga stopped because payment failed",
        data: await getSagaWithSteps(saga)
      });
    }

    if (payment.status !== "succeeded") {
      saga = await updateSagaFields(saga.id, {
        status: "failed",
        payment_id: payment.id,
        current_step: "payment",
        failure_reason: `Unexpected payment status: ${payment.status}`,
        is_retryable: false,
        completed_at: new Date()
      });
      await cancelBookingForSaga(saga, "unexpected_payment_status");
      await logAuditEvent(saga, "SAGA_FAILED", "medium", "unexpected_payment_status", {
        payment_id: payment.id,
        payment_status: payment.status
      });

      return res.status(409).json({
        message: "Saga failed because payment returned an unexpected status",
        data: await getSagaWithSteps(saga)
      });
    }

    saga = await updateSagaFields(saga.id, {
      status: "payment_succeeded",
      payment_id: payment.id,
      current_step: "ticket"
    });
    await logAuditEvent(saga, "PAYMENT_SUCCEEDED", "info", "payment_succeeded_by_saga", {
      payment_id: payment.id,
      booking_id: booking.id,
      amount_cents: payment.amount_cents,
      currency: payment.currency,
      card_last4: payment.card_last4
    });

    const ticketResult = await issueTicketsForSaga(saga);

    if (!ticketResult.ok) {
      saga = await updateSagaFields(saga.id, {
        status: "pending_ticket",
        current_step: "ticket",
        failure_reason: ticketResult.result.payload.message || ticketResult.result.errorMessage || "Ticket issuing is pending",
        is_retryable: true
      });
      await logAuditEvent(saga, ticketResult.result.statusCode >= 500 || ticketResult.result.statusCode === 0 ? "SERVICE_UNAVAILABLE" : "TICKET_ISSUE_FAILED", "high", "ticket_issue_pending_by_saga", {
        booking_id: booking.id,
        payment_id: payment.id,
        statusCode: ticketResult.result.statusCode,
        message: saga.failure_reason
      });

      return res.status(202).json({
        message: "Payment succeeded, but ticket issuing is pending retry",
        data: await getSagaWithSteps(saga)
      });
    }

    const ticketIds = ticketResult.tickets.map((ticket) => ticket.id);
    saga = await updateSagaFields(saga.id, {
      status: "ticket_issued",
      ticket_ids: ticketIds,
      current_step: "notification"
    });
    await logAuditEvent(saga, "TICKET_ISSUED", "info", "tickets_issued_by_saga", {
      booking_id: booking.id,
      payment_id: payment.id,
      ticket_ids: ticketIds,
      ticket_count: ticketIds.length
    });

    const notificationOutcome = await completeNotificationStep(saga, ticketResult.tickets, input.notification);

    return res.status(notificationOutcome.statusCode).json({
      message: notificationOutcome.message,
      data: await getSagaWithSteps(notificationOutcome.saga)
    });
  })
);

app.post(
  "/sagas/:id/retry",
  asyncHandler(async (req, res) => {
    const sagaId = assertUuid(req.params.id, "id");
    let saga = await getSagaById(sagaId);

    if (!saga) {
      throw new ApiError(404, "Saga not found");
    }

    if (!retryableStatuses.includes(saga.status)) {
      throw new ApiError(409, "Saga is not in a retryable status");
    }

    if (saga.retry_count >= saga.max_retries) {
      saga = await updateSagaFields(saga.id, {
        is_retryable: false
      });

      throw new ApiError(409, "Saga retry limit has been reached", {
        message: "Saga retry limit has been reached",
        data: await getSagaWithSteps(saga)
      });
    }

    saga = await updateSagaFields(saga.id, {
      retry_count: saga.retry_count + 1,
      is_retryable: true
    });

    if (saga.status === "pending_ticket") {
      const ticketResult = await issueTicketsForSaga(saga);

      if (!ticketResult.ok) {
        saga = await updateSagaFields(saga.id, {
          status: "pending_ticket",
          current_step: "ticket",
          failure_reason: ticketResult.result.payload.message || ticketResult.result.errorMessage || "Ticket issuing is still pending",
          is_retryable: saga.retry_count < saga.max_retries
        });

        return res.status(202).json({
          message: "Ticket issuing is still pending",
          data: await getSagaWithSteps(saga)
        });
      }

      saga = await updateSagaFields(saga.id, {
        status: "ticket_issued",
        ticket_ids: ticketResult.tickets.map((ticket) => ticket.id),
        current_step: "notification"
      });

      const notification = {
        recipient_email: saga.metadata.notification_recipient_email,
        event_name: saga.metadata.event_name,
        section_name: saga.metadata.section_name
      };
      const notificationOutcome = await completeNotificationStep(saga, ticketResult.tickets, notification);

      return res.status(notificationOutcome.statusCode).json({
        message: `Retry completed: ${notificationOutcome.message}`,
        data: await getSagaWithSteps(notificationOutcome.saga)
      });
    }

    const fetchedTickets = await fetchTicketsForSaga(saga);

    if (!fetchedTickets.ok || fetchedTickets.tickets.length === 0) {
      saga = await updateSagaFields(saga.id, {
        status: "pending_notification",
        current_step: "notification",
        failure_reason: "Could not load tickets for notification retry",
        is_retryable: saga.retry_count < saga.max_retries
      });

      return res.status(202).json({
        message: "Notification retry is pending because tickets could not be loaded",
        data: await getSagaWithSteps(saga)
      });
    }

    const notification = {
      recipient_email: saga.metadata.notification_recipient_email || fetchedTickets.tickets[0].user_email,
      event_name: saga.metadata.event_name || fetchedTickets.tickets[0].event_title,
      section_name: saga.metadata.section_name || fetchedTickets.tickets[0].section_name
    };
    const notificationOutcome = await completeNotificationStep(saga, fetchedTickets.tickets, notification);

    return res.status(notificationOutcome.statusCode).json({
      message: `Retry completed: ${notificationOutcome.message}`,
      data: await getSagaWithSteps(notificationOutcome.saga)
    });
  })
);

app.post(
  "/sagas/:id/compensate",
  asyncHandler(async (req, res) => {
    const sagaId = assertUuid(req.params.id, "id");
    let saga = await getSagaById(sagaId);

    if (!saga) {
      throw new ApiError(404, "Saga not found");
    }

    if (completedStatuses.includes(saga.status)) {
      throw new ApiError(409, "Completed saga cannot be compensated automatically");
    }

    const compensation = {
      booking: null,
      payment: null
    };

    if (saga.booking_id && !["ticket_issued", "pending_notification", "completed_with_notification_failed"].includes(saga.status)) {
      compensation.booking = await cancelBookingForSaga(saga, "manual_compensation");
    }

    if (saga.payment_id && !["payment_failed", "payment_suspicious"].includes(saga.status)) {
      compensation.payment = await refundPaymentForSaga(saga, "manual_compensation");
    }

    const anySucceeded = Object.values(compensation).some((result) => result && result.ok);
    saga = await updateSagaFields(saga.id, {
      status: anySucceeded ? "compensated" : saga.status,
      current_step: "compensation",
      failure_reason: anySucceeded ? null : "Compensation did not complete",
      is_retryable: !anySucceeded && saga.retry_count < saga.max_retries,
      completed_at: anySucceeded ? new Date() : saga.completed_at
    });
    await logAuditEvent(saga, anySucceeded ? "SAGA_COMPENSATED" : "SAGA_FAILED", anySucceeded ? "medium" : "high", "manual_saga_compensation", {
      compensation
    });

    return res.json({
      message: anySucceeded ? "Saga compensation completed" : "Saga compensation did not complete",
      data: {
        ...(await getSagaWithSteps(saga)),
        compensation
      }
    });
  })
);

app.get(
  "/sagas/pending/retryable",
  asyncHandler(async (req, res) => {
    const limit = parseIntegerQuery(req.query.limit, "limit", 50, { min: 1, max: 200 });
    const offset = parseIntegerQuery(req.query.offset, "offset", 0, { min: 0 });
    const result = await runQuery(
      `${sagaSelectSql}
       where status = any($1::text[])
       and retry_count < max_retries
       and is_retryable = true
       order by created_at desc
       limit $2
       offset $3`,
      [retryableStatuses, limit, offset]
    );

    return res.json({
      data: result.rows.map(toSaga),
      pagination: {
        limit,
        offset,
        count: result.rowCount
      }
    });
  })
);

app.get(
  "/sagas/idempotency/:idempotencyKey",
  asyncHandler(async (req, res) => {
    const idempotencyKey = assertRequiredString(req.params.idempotencyKey, "idempotencyKey", 150);
    const saga = await getSagaByIdempotencyKey(idempotencyKey);

    if (!saga) {
      throw new ApiError(404, "Saga not found");
    }

    return res.json({
      data: await getSagaWithSteps(saga)
    });
  })
);

app.get(
  "/sagas/:id",
  asyncHandler(async (req, res) => {
    const sagaId = assertUuid(req.params.id, "id");
    const saga = await getSagaById(sagaId);

    if (!saga) {
      throw new ApiError(404, "Saga not found");
    }

    return res.json({
      data: await getSagaWithSteps(saga)
    });
  })
);

app.get(
  "/sagas",
  asyncHandler(async (req, res) => {
    const filters = [];
    const params = [];
    const addParam = (value) => {
      params.push(value);
      return `$${params.length}`;
    };

    if (req.query.status !== undefined && req.query.status !== "") {
      filters.push(`status = ${addParam(assertRequiredString(req.query.status, "status", 50))}`);
    }

    if (req.query.user_id !== undefined && req.query.user_id !== "") {
      filters.push(`user_id = ${addParam(assertUuid(req.query.user_id, "user_id"))}`);
    }

    if (req.query.booking_id !== undefined && req.query.booking_id !== "") {
      filters.push(`booking_id = ${addParam(assertUuid(req.query.booking_id, "booking_id"))}`);
    }

    if (req.query.payment_id !== undefined && req.query.payment_id !== "") {
      filters.push(`payment_id = ${addParam(assertUuid(req.query.payment_id, "payment_id"))}`);
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
      `${sagaSelectSql}
       ${whereSql}
       order by created_at desc
       limit ${limitPlaceholder}
       offset ${offsetPlaceholder}`,
      params
    );

    return res.json({
      data: result.rows.map(toSaga),
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
      message: "Saga service is temporarily unavailable",
      service: "saga-service"
    });
  }

  if (error.code === "23514" || error.code === "22P02") {
    return res.status(400).json({
      message: "Request violates a database constraint"
    });
  }

  return res.status(500).json({
    message: "Internal server error",
    service: "saga-service"
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
  console.log(`Saga Service running on port ${PORT}`);
});
