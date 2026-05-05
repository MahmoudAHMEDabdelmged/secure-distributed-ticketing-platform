const express = require("express");
const cors = require("cors");
require("dotenv").config();

const { pool, query, checkDatabaseConnection, checkDatabaseSchema } = require("./db");

const app = express();
const PORT = process.env.PORT || 5002;
const EVENTS_SERVICE_URL = (process.env.EVENTS_SERVICE_URL || "http://localhost:5001").replace(/\/+$/, "");

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const activeBookingStatuses = ["pending", "confirmed"];

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

function logInternalError(error, req) {
  console.error("Booking-service internal error:", {
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

function assertPositiveInteger(value, fieldName) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ApiError(400, `${fieldName} must be a positive integer`);
  }
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

function createEventsServiceUnavailableError() {
  return new ApiError(503, "Events Service unavailable, booking cannot be created now", {
    message: "Events Service unavailable, booking cannot be created now",
    service: "booking-service"
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

async function checkEventsServiceHealth() {
  const startedAt = Date.now();

  try {
    const response = await fetchWithTimeout(`${EVENTS_SERVICE_URL}/health`, {
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
    logDependencyError("Events Service", error);

    return {
      status: "down",
      latencyMs: Date.now() - startedAt,
      error: error.name === "AbortError" ? "Events Service health check timed out" : error.message
    };
  }
}

async function fetchEventFromEventsService(eventId) {
  let response;

  try {
    response = await fetchWithTimeout(`${EVENTS_SERVICE_URL}/events/${encodeURIComponent(eventId)}`, {
      headers: {
        accept: "application/json"
      },
      timeoutMs: 5000
    });
  } catch (error) {
    logDependencyError("Events Service", error);
    throw createEventsServiceUnavailableError();
  }

  if (response.status === 404) {
    throw new ApiError(404, "Event not found");
  }

  if (!response.ok) {
    throw createEventsServiceUnavailableError();
  }

  try {
    const payload = await response.json();

    if (!payload || !payload.data) {
      throw new Error("Events Service response did not include event data");
    }

    return payload.data;
  } catch (error) {
    logDependencyError("Events Service response parsing", error);
    throw createEventsServiceUnavailableError();
  }
}

function findSection(event, sectionId) {
  if (!Array.isArray(event.sections)) {
    return null;
  }

  return event.sections.find((section) => section && section.id === sectionId) || null;
}

function advisoryLockKeysFromUuid(uuid) {
  const hex = uuid.replace(/-/g, "");
  const buffer = Buffer.from(hex.slice(0, 16), "hex");

  return [buffer.readInt32BE(0), buffer.readInt32BE(4)];
}

function toBooking(row) {
  return {
    id: row.id,
    user_id: row.user_id,
    user_email: row.user_email,
    event_id: row.event_id,
    section_id: row.section_id,
    event_title: row.event_title,
    section_name: row.section_name,
    quantity: row.quantity,
    unit_price_cents: row.unit_price_cents,
    total_price_cents: row.total_price_cents,
    currency: row.currency,
    status: row.status,
    expires_at: row.expires_at,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

const bookingSelectSql = `
  select
    id,
    user_id,
    user_email,
    event_id,
    section_id,
    event_title,
    section_name,
    quantity,
    unit_price_cents,
    total_price_cents,
    currency,
    status,
    expires_at,
    created_at,
    updated_at
  from public.bookings
`;

app.get("/health", (req, res) => {
  res.json({
    service: "booking-service",
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
      logDependencyError("Booking database", error);

      database = {
        status: "down",
        latencyMs: 0,
        schema: {
          status: "unknown"
        },
        error: "Booking database is unavailable"
      };
    }

    const eventsService = await checkEventsServiceHealth();
    const isHealthy =
      database.status === "up" &&
      database.schema &&
      database.schema.status === "ready" &&
      eventsService.status === "up";

    return res.status(isHealthy ? 200 : 503).json({
      service: "booking-service",
      status: isHealthy ? "healthy" : "degraded",
      database,
      eventsService,
      timestamp: new Date().toISOString()
    });
  })
);

app.post(
  "/bookings",
  asyncHandler(async (req, res) => {
    const { user_id, event_id, section_id, quantity } = req.body;
    const userEmail = normalizeOptionalString(req.body.user_email, "user_email");

    assertUuid(user_id, "user_id");
    assertUuid(event_id, "event_id");
    assertUuid(section_id, "section_id");
    assertPositiveInteger(quantity, "quantity");

    const event = await fetchEventFromEventsService(event_id);
    const section = findSection(event, section_id);

    if (!section) {
      throw new ApiError(404, "Event section not found");
    }

    if (event.status !== "published") {
      throw new ApiError(409, "Event is not available for booking");
    }

    const capacity = Number(section.total_capacity);
    const unitPriceCents = Number(section.price_cents);

    if (!Number.isInteger(capacity) || capacity <= 0 || !Number.isInteger(unitPriceCents) || unitPriceCents < 0) {
      throw createEventsServiceUnavailableError();
    }

    const totalPriceCents = quantity * unitPriceCents;

    if (!Number.isSafeInteger(totalPriceCents) || totalPriceCents > 2147483647) {
      throw new ApiError(400, "total_price_cents is too large");
    }

    const [lockKeyOne, lockKeyTwo] = advisoryLockKeysFromUuid(section_id);
    const client = await pool.connect();
    let transactionStarted = false;

    try {
      await runClientQuery(client, "begin");
      transactionStarted = true;

      await runClientQuery(client, "select pg_advisory_xact_lock($1, $2)", [lockKeyOne, lockKeyTwo]);

      const reservedResult = await runClientQuery(
        client,
        `select coalesce(sum(quantity), 0)::int as reserved_quantity
         from public.bookings
         where section_id = $1
         and status = any($2::text[])`,
        [section_id, activeBookingStatuses]
      );

      const alreadyReserved = reservedResult.rows[0].reserved_quantity;
      const available = Math.max(capacity - alreadyReserved, 0);

      if (alreadyReserved + quantity > capacity) {
        throw new ApiError(409, "Not enough seats available", {
          message: "Not enough seats available",
          available
        });
      }

      const bookingResult = await runClientQuery(
        client,
        `insert into public.bookings (
          user_id,
          user_email,
          event_id,
          section_id,
          event_title,
          section_name,
          quantity,
          unit_price_cents,
          total_price_cents,
          currency,
          status,
          expires_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', now() + interval '15 minutes')
        returning
          id,
          user_id,
          user_email,
          event_id,
          section_id,
          event_title,
          section_name,
          quantity,
          unit_price_cents,
          total_price_cents,
          currency,
          status,
          expires_at,
          created_at,
          updated_at`,
        [
          user_id,
          userEmail,
          event_id,
          section_id,
          event.title,
          section.name,
          quantity,
          unitPriceCents,
          totalPriceCents,
          section.currency || "EGP"
        ]
      );

      await runClientQuery(client, "commit");

      return res.status(201).json({
        message: "Booking created successfully",
        data: toBooking(bookingResult.rows[0])
      });
    } catch (error) {
      if (transactionStarted) {
        try {
          await runClientQuery(client, "rollback");
        } catch (rollbackError) {
          logDependencyError("Booking rollback", rollbackError);
        }
      }

      throw error;
    } finally {
      client.release();
    }
  })
);

app.get(
  "/bookings/:id",
  asyncHandler(async (req, res) => {
    assertUuid(req.params.id, "id");

    const result = await query(
      `${bookingSelectSql}
       where id = $1
       limit 1`,
      [req.params.id]
    );

    if (result.rowCount === 0) {
      throw new ApiError(404, "Booking not found");
    }

    return res.json({
      data: toBooking(result.rows[0])
    });
  })
);

app.get(
  "/users/:userId/bookings",
  asyncHandler(async (req, res) => {
    assertUuid(req.params.userId, "userId");

    const result = await query(
      `${bookingSelectSql}
       where user_id = $1
       order by created_at desc`,
      [req.params.userId]
    );

    return res.json({
      data: result.rows.map(toBooking)
    });
  })
);

app.post(
  "/bookings/:id/cancel",
  asyncHandler(async (req, res) => {
    assertUuid(req.params.id, "id");

    const existingResult = await query(
      `${bookingSelectSql}
       where id = $1
       limit 1`,
      [req.params.id]
    );

    if (existingResult.rowCount === 0) {
      throw new ApiError(404, "Booking not found");
    }

    const existingBooking = existingResult.rows[0];

    if (existingBooking.status === "cancelled") {
      return res.json({
        message: "Booking already cancelled",
        data: toBooking(existingBooking)
      });
    }

    if (!activeBookingStatuses.includes(existingBooking.status)) {
      return res.json({
        message: "Booking cannot be cancelled",
        data: toBooking(existingBooking)
      });
    }

    const updatedResult = await query(
      `with updated_booking as (
         update public.bookings
         set status = 'cancelled'
         where id = $1
         returning id
       )
       ${bookingSelectSql}
       where id = (select id from updated_booking)
       limit 1`,
      [req.params.id]
    );

    return res.json({
      message: "Booking cancelled successfully",
      data: toBooking(updatedResult.rows[0])
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
      message: "Booking is temporarily unavailable",
      service: "booking-service"
    });
  }

  if (error.code === "23514" || error.code === "22P02") {
    return res.status(400).json({
      message: "Request violates a database constraint"
    });
  }

  return res.status(500).json({
    message: "Internal server error",
    service: "booking-service"
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
  console.log(`Booking Service running on port ${PORT}`);
});
