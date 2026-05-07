const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
require("dotenv").config();

const { pool, query, checkDatabaseConnection, checkDatabaseSchema } = require("./db");

const app = express();
const PORT = process.env.PORT || 5004;
const BOOKING_SERVICE_URL = (process.env.BOOKING_SERVICE_URL || "http://localhost:5002").replace(/\/+$/, "");

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

function logInternalError(error, req) {
  console.error("Payment-service internal error:", {
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

function assertUuid(value, fieldName) {
  if (typeof value !== "string" || !uuidPattern.test(value)) {
    throw new ApiError(400, `${fieldName} must be a valid UUID`);
  }
}

function assertNonNegativeInteger(value, fieldName) {
  if (!Number.isInteger(value) || value < 0) {
    throw new ApiError(400, `${fieldName} must be a non-negative integer`);
  }

  if (value > 2147483647) {
    throw new ApiError(400, `${fieldName} is too large`);
  }
}

function normalizeRequiredString(value, fieldName) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ApiError(400, `${fieldName} must be a non-empty string`);
  }

  return value.trim();
}

function normalizeOptionalString(value, fieldName) {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== "string") {
    throw new ApiError(400, `${fieldName} must be a string`);
  }

  const trimmedValue = value.trim();

  return trimmedValue.length > 0 ? trimmedValue : null;
}

function normalizeCurrency(value) {
  const currency = normalizeRequiredString(value, "currency").toUpperCase();

  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new ApiError(400, "currency must be a 3-letter string");
  }

  return currency;
}

function normalizeCardNumber(value) {
  if (typeof value !== "string") {
    throw new ApiError(400, "card_number must be a string");
  }

  const cardNumber = value.replace(/\s+/g, "");

  if (!/^\d+$/.test(cardNumber) || cardNumber.length < 12) {
    throw new ApiError(400, "card_number must contain at least 12 digits");
  }

  return cardNumber;
}

function createBookingServiceUnavailableError() {
  return new ApiError(503, "Booking Service unavailable, payment cannot be processed now", {
    message: "Booking Service unavailable, payment cannot be processed now",
    service: "payment-service"
  });
}

async function fetchWithTimeout(url, options = {}) {
  if (typeof fetch !== "function") {
    throw new Error("Global fetch is not available in this Node.js runtime");
  }

  const timeoutMs = options.timeoutMs || 5000;
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

async function checkBookingServiceHealth() {
  const startedAt = Date.now();

  try {
    const response = await fetchWithTimeout(`${BOOKING_SERVICE_URL}/health`, {
      headers: {
        accept: "application/json"
      },
      timeoutMs: 3000
    });

    return {
      status: response.ok ? "up" : "down",
      statusCode: response.status,
      latencyMs: Date.now() - startedAt
    };
  } catch (error) {
    logDependencyError("Booking Service", error);

    return {
      status: "down",
      latencyMs: Date.now() - startedAt,
      error: error.name === "AbortError" ? "Booking Service health check timed out" : error.message
    };
  }
}

async function fetchBooking(bookingId) {
  let response;

  try {
    response = await fetchWithTimeout(`${BOOKING_SERVICE_URL}/bookings/${encodeURIComponent(bookingId)}`, {
      headers: {
        accept: "application/json"
      },
      timeoutMs: 5000
    });
  } catch (error) {
    logDependencyError("Booking Service", error);
    throw createBookingServiceUnavailableError();
  }

  if (response.status === 404) {
    throw new ApiError(404, "Booking not found");
  }

  if (!response.ok) {
    throw createBookingServiceUnavailableError();
  }

  try {
    const payload = await response.json();

    if (!payload || !payload.data) {
      throw new Error("Booking Service response did not include booking data");
    }

    return payload.data;
  } catch (error) {
    logDependencyError("Booking Service response parsing", error);
    throw createBookingServiceUnavailableError();
  }
}

function createBookingSnapshot(booking) {
  return {
    booking_id: booking.id,
    event_id: booking.event_id,
    section_id: booking.section_id,
    event_title: booking.event_title,
    section_name: booking.section_name,
    quantity: booking.quantity,
    total_price_cents: booking.total_price_cents,
    currency: booking.currency
  };
}

function createProviderPaymentRef() {
  return `simulated_${crypto.randomUUID()}`;
}

function simulatePayment(cardNumber) {
  if (cardNumber.endsWith("4242")) {
    return {
      status: "succeeded",
      failureReason: null,
      riskScore: 5,
      isSuspicious: false,
      suspiciousReason: null,
      httpStatus: 201,
      message: "Payment processed successfully"
    };
  }

  if (cardNumber.endsWith("4000")) {
    return {
      status: "failed",
      failureReason: "Simulated card decline",
      riskScore: 30,
      isSuspicious: false,
      suspiciousReason: null,
      httpStatus: 402,
      message: "Payment failed"
    };
  }

  if (cardNumber.endsWith("9999")) {
    return {
      status: "suspicious",
      failureReason: null,
      riskScore: 95,
      isSuspicious: true,
      suspiciousReason: "Simulated suspicious payment card",
      httpStatus: 202,
      message: "Payment marked as suspicious"
    };
  }

  return {
    status: "failed",
    failureReason: "Unsupported simulated test card number",
    riskScore: 25,
    isSuspicious: false,
    suspiciousReason: null,
    httpStatus: 402,
    message: "Payment failed"
  };
}

function toPayment(row) {
  return {
    id: row.id,
    booking_id: row.booking_id,
    user_id: row.user_id,
    user_email: row.user_email,
    amount_cents: row.amount_cents,
    currency: row.currency,
    payment_method: row.payment_method,
    provider: row.provider,
    provider_payment_ref: row.provider_payment_ref,
    card_last4: row.card_last4,
    status: row.status,
    failure_reason: row.failure_reason,
    risk_score: row.risk_score,
    is_suspicious: row.is_suspicious,
    suspicious_reason: row.suspicious_reason,
    booking_snapshot: row.booking_snapshot,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

const paymentSelectSql = `
  select
    id,
    booking_id,
    user_id,
    user_email,
    amount_cents,
    currency,
    payment_method,
    provider,
    provider_payment_ref,
    card_last4,
    status,
    failure_reason,
    risk_score,
    is_suspicious,
    suspicious_reason,
    booking_snapshot,
    created_at,
    updated_at
  from public.payments
`;

async function getSucceededPaymentForBooking(bookingId) {
  const result = await query(
    `${paymentSelectSql}
     where booking_id = $1
     and status = 'succeeded'
     order by created_at desc
     limit 1`,
    [bookingId]
  );

  return result.rows[0] || null;
}

async function getPaymentById(paymentId) {
  const result = await query(
    `${paymentSelectSql}
     where id = $1
     limit 1`,
    [paymentId]
  );

  return result.rows[0] || null;
}

app.get("/health", (req, res) => {
  res.json({
    service: "payment-service",
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
      logDependencyError("Payment database", error);

      database = {
        status: "down",
        latencyMs: 0,
        schema: {
          status: "unknown"
        },
        error: "Payment database is unavailable"
      };
    }

    const bookingService = await checkBookingServiceHealth();
    const isHealthy =
      database.status === "up" &&
      database.schema &&
      database.schema.status === "ready" &&
      bookingService.status === "up";

    return res.status(isHealthy ? 200 : 503).json({
      service: "payment-service",
      status: isHealthy ? "healthy" : "degraded",
      database,
      bookingService,
      timestamp: new Date().toISOString()
    });
  })
);

app.post(
  "/payments",
  asyncHandler(async (req, res) => {
    const bookingId = req.body.booking_id;
    const userId = req.body.user_id;
    const userEmail = normalizeOptionalString(req.body.user_email, "user_email");
    const amountCents = req.body.amount_cents;
    const currency = normalizeCurrency(req.body.currency);
    const paymentMethod = normalizeRequiredString(req.body.payment_method, "payment_method");
    const cardNumber = normalizeCardNumber(req.body.card_number);
    const cardLast4 = cardNumber.slice(-4);

    assertUuid(bookingId, "booking_id");
    assertUuid(userId, "user_id");
    assertNonNegativeInteger(amountCents, "amount_cents");

    const booking = await fetchBooking(bookingId);

    if (booking.user_id !== userId) {
      throw new ApiError(403, "Payment user does not match booking user");
    }

    const bookingTotalPriceCents = Number(booking.total_price_cents);

    if (!Number.isInteger(bookingTotalPriceCents)) {
      throw createBookingServiceUnavailableError();
    }

    if (amountCents !== bookingTotalPriceCents) {
      throw new ApiError(409, "Payment amount does not match booking total", {
        message: "Payment amount does not match booking total"
      });
    }

    if (booking.currency && currency !== String(booking.currency).toUpperCase()) {
      throw new ApiError(409, "Payment currency does not match booking currency");
    }

    const existingSucceededPayment = await getSucceededPaymentForBooking(bookingId);

    if (existingSucceededPayment) {
      return res.json({
        message: "Payment already completed",
        data: toPayment(existingSucceededPayment)
      });
    }

    const simulation = simulatePayment(cardNumber);
    const insertResult = await query(
      `insert into public.payments (
        booking_id,
        user_id,
        user_email,
        amount_cents,
        currency,
        payment_method,
        provider,
        provider_payment_ref,
        card_last4,
        status,
        failure_reason,
        risk_score,
        is_suspicious,
        suspicious_reason,
        booking_snapshot
      )
      values ($1, $2, $3, $4, $5, $6, 'simulated_gateway', $7, $8, $9, $10, $11, $12, $13, $14)
      returning
        id,
        booking_id,
        user_id,
        user_email,
        amount_cents,
        currency,
        payment_method,
        provider,
        provider_payment_ref,
        card_last4,
        status,
        failure_reason,
        risk_score,
        is_suspicious,
        suspicious_reason,
        booking_snapshot,
        created_at,
        updated_at`,
      [
        bookingId,
        userId,
        userEmail,
        amountCents,
        currency,
        paymentMethod,
        createProviderPaymentRef(),
        cardLast4,
        simulation.status,
        simulation.failureReason,
        simulation.riskScore,
        simulation.isSuspicious,
        simulation.suspiciousReason,
        createBookingSnapshot(booking)
      ]
    );

    return res.status(simulation.httpStatus).json({
      message: simulation.message,
      data: toPayment(insertResult.rows[0])
    });
  })
);

app.get(
  "/payments/booking/:bookingId/status",
  asyncHandler(async (req, res) => {
    assertUuid(req.params.bookingId, "bookingId");

    const succeededPayment = await getSucceededPaymentForBooking(req.params.bookingId);

    if (succeededPayment) {
      return res.json({
        booking_id: req.params.bookingId,
        is_paid: true,
        status: "succeeded",
        payment_id: succeededPayment.id,
        amount_cents: succeededPayment.amount_cents,
        currency: succeededPayment.currency
      });
    }

    const latestResult = await query(
      `${paymentSelectSql}
       where booking_id = $1
       order by created_at desc
       limit 1`,
      [req.params.bookingId]
    );

    if (latestResult.rowCount === 0) {
      return res.json({
        booking_id: req.params.bookingId,
        is_paid: false,
        status: "unpaid"
      });
    }

    const latestPayment = latestResult.rows[0];

    if (latestPayment.status === "suspicious" || latestPayment.is_suspicious) {
      return res.json({
        booking_id: req.params.bookingId,
        is_paid: false,
        status: "suspicious",
        is_suspicious: true,
        payment_id: latestPayment.id,
        amount_cents: latestPayment.amount_cents,
        currency: latestPayment.currency
      });
    }

    return res.json({
      booking_id: req.params.bookingId,
      is_paid: false,
      status: latestPayment.status || "unpaid",
      is_suspicious: latestPayment.is_suspicious,
      payment_id: latestPayment.id,
      amount_cents: latestPayment.amount_cents,
      currency: latestPayment.currency,
      failure_reason: latestPayment.failure_reason
    });
  })
);

app.get(
  "/bookings/:bookingId/payments",
  asyncHandler(async (req, res) => {
    assertUuid(req.params.bookingId, "bookingId");

    const result = await query(
      `${paymentSelectSql}
       where booking_id = $1
       order by created_at desc`,
      [req.params.bookingId]
    );

    return res.json({
      data: result.rows.map(toPayment)
    });
  })
);

app.get(
  "/payments/:id",
  asyncHandler(async (req, res) => {
    assertUuid(req.params.id, "id");

    const payment = await getPaymentById(req.params.id);

    if (!payment) {
      throw new ApiError(404, "Payment not found");
    }

    return res.json({
      data: toPayment(payment)
    });
  })
);

app.post(
  "/payments/:id/refund",
  asyncHandler(async (req, res) => {
    assertUuid(req.params.id, "id");

    const payment = await getPaymentById(req.params.id);

    if (!payment) {
      throw new ApiError(404, "Payment not found");
    }

    if (payment.status === "refunded") {
      return res.json({
        message: "Payment already refunded",
        data: toPayment(payment)
      });
    }

    if (payment.status !== "succeeded") {
      throw new ApiError(409, "Only succeeded payments can be refunded");
    }

    const result = await query(
      `update public.payments
       set status = 'refunded'
       where id = $1
       returning
         id,
         booking_id,
         user_id,
         user_email,
         amount_cents,
         currency,
         payment_method,
         provider,
         provider_payment_ref,
         card_last4,
         status,
         failure_reason,
         risk_score,
         is_suspicious,
         suspicious_reason,
         booking_snapshot,
         created_at,
         updated_at`,
      [req.params.id]
    );

    return res.json({
      message: "Payment refunded successfully",
      data: toPayment(result.rows[0])
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
      message: "Payments are temporarily unavailable",
      service: "payment-service"
    });
  }

  if (error.code === "23505") {
    return res.status(409).json({
      message: "Payment reference already exists"
    });
  }

  if (error.code === "23514" || error.code === "22P02") {
    return res.status(400).json({
      message: "Request violates a database constraint"
    });
  }

  return res.status(500).json({
    message: "Internal server error",
    service: "payment-service"
  });
});

process.on("SIGINT", async () => {
  await pool.end();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await pool.end();
  process.exit(0);
});

app.listen(PORT, () => {
  console.log(`Payment Service running on port ${PORT}`);
});
