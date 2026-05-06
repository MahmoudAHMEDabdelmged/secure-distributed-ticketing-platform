const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const QRCode = require("qrcode");
require("dotenv").config();

const { pool, query, checkDatabaseConnection, checkDatabaseSchema } = require("./db");

const app = express();
const PORT = process.env.PORT || 5003;
const BOOKING_SERVICE_URL = (process.env.BOOKING_SERVICE_URL || "http://localhost:5002").replace(/\/+$/, "");
const PAYMENT_SERVICE_URL = (process.env.PAYMENT_SERVICE_URL || "http://localhost:5004").replace(/\/+$/, "");
const REQUIRE_PAYMENT_FOR_TICKETS = !["false", "0", "no"].includes(
  String(process.env.REQUIRE_PAYMENT_FOR_TICKETS || "true").trim().toLowerCase()
);
const VERIFY_BASE_URL = (process.env.VERIFY_BASE_URL || "http://localhost:4000/verify-ticket").replace(/\/+$/, "");
const TICKET_SIGNING_SECRET = process.env.TICKET_SIGNING_SECRET;

if (!TICKET_SIGNING_SECRET) {
  throw new Error("Missing required environment variable: TICKET_SIGNING_SECRET");
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const closedBookingStatuses = ["cancelled", "expired"];

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

function sanitizePath(path) {
  return String(path)
    .replace(/\/tickets\/verify\/[^/?#]+/g, "/tickets/verify/[token]")
    .replace(/\/verify-ticket\/[^/?#]+/g, "/verify-ticket/[token]");
}

function logInternalError(error, req) {
  console.error("Ticket-service internal error:", {
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

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function advisoryLockKeysFromUuid(uuid) {
  const hex = uuid.replace(/-/g, "");
  const buffer = Buffer.from(hex.slice(0, 16), "hex");

  return [buffer.readInt32BE(0), buffer.readInt32BE(4)];
}

function createTicketNumber(index) {
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = crypto.randomBytes(5).toString("hex").toUpperCase();
  const paddedIndex = String(index + 1).padStart(2, "0");

  return `TKT-${timestamp}-${paddedIndex}-${random}`;
}

function createTicketToken(ticketId) {
  return jwt.sign(
    {
      ticket_id: ticketId,
      jti: crypto.randomUUID(),
      purpose: "ticket_verification"
    },
    TICKET_SIGNING_SECRET,
    {
      algorithm: "HS256"
    }
  );
}

function toSafeTicket(row) {
  return {
    id: row.id,
    booking_id: row.booking_id,
    user_id: row.user_id,
    user_email: row.user_email,
    event_id: row.event_id,
    section_id: row.section_id,
    event_title: row.event_title,
    section_name: row.section_name,
    ticket_number: row.ticket_number,
    verification_url: row.verification_url,
    status: row.status,
    issued_at: row.issued_at,
    used_at: row.used_at,
    expires_at: row.expires_at,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function toPublicVerificationTicket(row) {
  return {
    id: row.id,
    ticket_number: row.ticket_number,
    event_title: row.event_title,
    section_name: row.section_name,
    status: row.status,
    issued_at: row.issued_at,
    used_at: row.used_at,
    expires_at: row.expires_at
  };
}

const ticketSelectSql = `
  select
    id,
    booking_id,
    user_id,
    user_email,
    event_id,
    section_id,
    event_title,
    section_name,
    ticket_number,
    verification_url,
    status,
    issued_at,
    used_at,
    expires_at,
    created_at,
    updated_at
  from public.issued_tickets
`;

function createBookingServiceUnavailableError() {
  return new ApiError(503, "Booking Service unavailable, tickets cannot be issued now", {
    message: "Booking Service unavailable, tickets cannot be issued now",
    service: "ticket-service"
  });
}

function createPaymentServiceUnavailableError() {
  return new ApiError(503, "Payment Service unavailable, tickets cannot be issued now", {
    message: "Payment Service unavailable, tickets cannot be issued now",
    service: "ticket-service"
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

async function checkPaymentServiceHealth() {
  const startedAt = Date.now();

  try {
    const response = await fetchWithTimeout(`${PAYMENT_SERVICE_URL}/health`, {
      headers: {
        accept: "application/json"
      },
      timeoutMs: 3000
    });

    return {
      status: response.ok ? "up" : "down",
      statusCode: response.status,
      latencyMs: Date.now() - startedAt,
      required: REQUIRE_PAYMENT_FOR_TICKETS
    };
  } catch (error) {
    logDependencyError("Payment Service", error);

    return {
      status: "down",
      latencyMs: Date.now() - startedAt,
      required: REQUIRE_PAYMENT_FOR_TICKETS,
      error: error.name === "AbortError" ? "Payment Service health check timed out" : error.message
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

async function fetchPaymentStatus(bookingId) {
  let response;

  try {
    response = await fetchWithTimeout(`${PAYMENT_SERVICE_URL}/payments/booking/${encodeURIComponent(bookingId)}/status`, {
      headers: {
        accept: "application/json"
      },
      timeoutMs: 5000
    });
  } catch (error) {
    logDependencyError("Payment Service", error);
    throw createPaymentServiceUnavailableError();
  }

  if (!response.ok) {
    throw createPaymentServiceUnavailableError();
  }

  try {
    const payload = await response.json();

    if (!payload || typeof payload.is_paid !== "boolean" || typeof payload.status !== "string") {
      throw new Error("Payment Service response did not include payment status data");
    }

    return payload;
  } catch (error) {
    logDependencyError("Payment Service response parsing", error);
    throw createPaymentServiceUnavailableError();
  }
}

async function createTicketPayload(ticket) {
  return {
    ...toSafeTicket(ticket),
    qr_code_data_url: await QRCode.toDataURL(ticket.verification_url)
  };
}

async function getTicketById(ticketId) {
  const result = await query(
    `${ticketSelectSql}
     where id = $1
     limit 1`,
    [ticketId]
  );

  return result.rows[0] || null;
}

app.get("/health", (req, res) => {
  res.json({
    service: "ticket-service",
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
      logDependencyError("Ticket database", error);

      database = {
        status: "down",
        latencyMs: 0,
        schema: {
          status: "unknown"
        },
        error: "Ticket database is unavailable"
      };
    }

    const bookingService = await checkBookingServiceHealth();
    const paymentService = REQUIRE_PAYMENT_FOR_TICKETS
      ? await checkPaymentServiceHealth()
      : {
          status: "not_required",
          required: false
        };
    const isHealthy =
      database.status === "up" &&
      database.schema &&
      database.schema.status === "ready" &&
      bookingService.status === "up" &&
      (!REQUIRE_PAYMENT_FOR_TICKETS || paymentService.status === "up");

    return res.status(isHealthy ? 200 : 503).json({
      service: "ticket-service",
      status: isHealthy ? "healthy" : "degraded",
      database,
      bookingService,
      paymentService,
      requirePaymentForTickets: REQUIRE_PAYMENT_FOR_TICKETS,
      timestamp: new Date().toISOString()
    });
  })
);

app.post(
  "/tickets/issue",
  asyncHandler(async (req, res) => {
    const { booking_id } = req.body;

    assertUuid(booking_id, "booking_id");

    const booking = await fetchBooking(booking_id);

    if (closedBookingStatuses.includes(booking.status)) {
      throw new ApiError(409, "Cannot issue tickets for cancelled or expired booking");
    }

    if (REQUIRE_PAYMENT_FOR_TICKETS) {
      const paymentStatus = await fetchPaymentStatus(booking_id);

      if (paymentStatus.is_paid !== true) {
        const status = paymentStatus.status || "unpaid";

        throw new ApiError(status === "suspicious" ? 409 : 402, "Payment is required before issuing tickets", {
          message: "Payment is required before issuing tickets",
          payment_status: status,
          is_suspicious: paymentStatus.is_suspicious === true
        });
      }
    }

    if (!Number.isInteger(booking.quantity) || booking.quantity <= 0) {
      throw new ApiError(409, "Booking quantity is not valid for ticket issuing");
    }

    const [lockKeyOne, lockKeyTwo] = advisoryLockKeysFromUuid(booking_id);
    const client = await pool.connect();
    let transactionStarted = false;

    try {
      await runClientQuery(client, "begin");
      transactionStarted = true;

      await runClientQuery(client, "select pg_advisory_xact_lock($1, $2)", [lockKeyOne, lockKeyTwo]);

      const existingResult = await runClientQuery(
        client,
        `${ticketSelectSql}
         where booking_id = $1
         order by issued_at asc`,
        [booking_id]
      );

      if (existingResult.rowCount > 0) {
        await runClientQuery(client, "commit");

        return res.json({
          message: "Tickets already issued",
          data: {
            booking_id,
            tickets: existingResult.rows.map(toSafeTicket)
          }
        });
      }

      const createdTickets = [];

      for (let index = 0; index < booking.quantity; index += 1) {
        const ticketId = crypto.randomUUID();
        const signedToken = createTicketToken(ticketId);
        const verificationUrl = `${VERIFY_BASE_URL}/${signedToken}`;
        const tokenHash = hashToken(signedToken);

        const insertResult = await runClientQuery(
          client,
          `insert into public.issued_tickets (
            id,
            booking_id,
            user_id,
            user_email,
            event_id,
            section_id,
            event_title,
            section_name,
            ticket_number,
            verification_token_hash,
            verification_url,
            status,
            expires_at
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'valid', $12)
          returning
            id,
            booking_id,
            user_id,
            user_email,
            event_id,
            section_id,
            event_title,
            section_name,
            ticket_number,
            verification_url,
            status,
            issued_at,
            used_at,
            expires_at,
            created_at,
            updated_at`,
          [
            ticketId,
            booking.id,
            booking.user_id,
            booking.user_email,
            booking.event_id,
            booking.section_id,
            booking.event_title,
            booking.section_name,
            createTicketNumber(index),
            tokenHash,
            verificationUrl,
            null
          ]
        );

        createdTickets.push(insertResult.rows[0]);
      }

      await runClientQuery(client, "commit");

      const ticketsWithQr = await Promise.all(createdTickets.map(createTicketPayload));

      return res.status(201).json({
        message: "Tickets issued successfully",
        data: {
          booking_id,
          tickets: ticketsWithQr
        }
      });
    } catch (error) {
      if (transactionStarted) {
        try {
          await runClientQuery(client, "rollback");
        } catch (rollbackError) {
          logDependencyError("Ticket issuing rollback", rollbackError);
        }
      }

      throw error;
    } finally {
      client.release();
    }
  })
);

app.get(
  "/tickets/verify/:token",
  asyncHandler(async (req, res) => {
    const token = req.params.token;
    let decoded;

    try {
      decoded = jwt.verify(token, TICKET_SIGNING_SECRET, {
        algorithms: ["HS256"]
      });
    } catch (error) {
      throw new ApiError(401, "Invalid ticket token");
    }

    if (
      !decoded ||
      decoded.purpose !== "ticket_verification" ||
      typeof decoded.ticket_id !== "string" ||
      !uuidPattern.test(decoded.ticket_id)
    ) {
      throw new ApiError(401, "Invalid ticket token");
    }

    const tokenHash = hashToken(token);
    const result = await query(
      `${ticketSelectSql}
       where id = $1
       and verification_token_hash = $2
       limit 1`,
      [decoded.ticket_id, tokenHash]
    );

    if (result.rowCount === 0) {
      throw new ApiError(401, "Invalid ticket token");
    }

    const ticket = result.rows[0];

    if (ticket.status === "valid") {
      return res.json({
        status: "valid",
        ticket: toPublicVerificationTicket(ticket)
      });
    }

    if (ticket.status === "used") {
      return res.json({
        status: "used",
        message: "Ticket already used",
        ticket: toPublicVerificationTicket(ticket)
      });
    }

    return res.json({
      status: ticket.status,
      ticket: toPublicVerificationTicket(ticket)
    });
  })
);

app.get(
  "/tickets/:id",
  asyncHandler(async (req, res) => {
    assertUuid(req.params.id, "id");

    const ticket = await getTicketById(req.params.id);

    if (!ticket) {
      throw new ApiError(404, "Ticket not found");
    }

    return res.json({
      data: toSafeTicket(ticket)
    });
  })
);

app.get(
  "/bookings/:bookingId/tickets",
  asyncHandler(async (req, res) => {
    assertUuid(req.params.bookingId, "bookingId");

    const result = await query(
      `${ticketSelectSql}
       where booking_id = $1
       order by issued_at asc`,
      [req.params.bookingId]
    );

    return res.json({
      data: result.rows.map(toSafeTicket)
    });
  })
);

app.get(
  "/users/:userId/tickets",
  asyncHandler(async (req, res) => {
    assertUuid(req.params.userId, "userId");

    const result = await query(
      `${ticketSelectSql}
       where user_id = $1
       order by issued_at desc`,
      [req.params.userId]
    );

    return res.json({
      data: result.rows.map(toSafeTicket)
    });
  })
);

app.post(
  "/tickets/:id/use",
  asyncHandler(async (req, res) => {
    assertUuid(req.params.id, "id");

    const ticket = await getTicketById(req.params.id);

    if (!ticket) {
      throw new ApiError(404, "Ticket not found");
    }

    if (ticket.status !== "valid") {
      throw new ApiError(409, "Only valid tickets can be marked as used", {
        message: "Only valid tickets can be marked as used",
        data: toSafeTicket(ticket)
      });
    }

    const result = await query(
      `update public.issued_tickets
       set status = 'used',
           used_at = now()
       where id = $1
       returning
         id,
         booking_id,
         user_id,
         user_email,
         event_id,
         section_id,
         event_title,
         section_name,
         ticket_number,
         verification_url,
         status,
         issued_at,
         used_at,
         expires_at,
         created_at,
         updated_at`,
      [req.params.id]
    );

    return res.json({
      message: "Ticket marked as used",
      data: toSafeTicket(result.rows[0])
    });
  })
);

app.post(
  "/tickets/:id/cancel",
  asyncHandler(async (req, res) => {
    assertUuid(req.params.id, "id");

    const ticket = await getTicketById(req.params.id);

    if (!ticket) {
      throw new ApiError(404, "Ticket not found");
    }

    if (ticket.status === "cancelled") {
      return res.json({
        message: "Ticket already cancelled",
        data: toSafeTicket(ticket)
      });
    }

    if (ticket.status === "used") {
      throw new ApiError(409, "Used tickets cannot be cancelled", {
        message: "Used tickets cannot be cancelled",
        data: toSafeTicket(ticket)
      });
    }

    if (ticket.status !== "valid") {
      throw new ApiError(409, "Only valid tickets can be cancelled", {
        message: "Only valid tickets can be cancelled",
        data: toSafeTicket(ticket)
      });
    }

    const result = await query(
      `update public.issued_tickets
       set status = 'cancelled'
       where id = $1
       returning
         id,
         booking_id,
         user_id,
         user_email,
         event_id,
         section_id,
         event_title,
         section_name,
         ticket_number,
         verification_url,
         status,
         issued_at,
         used_at,
         expires_at,
         created_at,
         updated_at`,
      [req.params.id]
    );

    return res.json({
      message: "Ticket cancelled successfully",
      data: toSafeTicket(result.rows[0])
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
      message: "Ticketing is temporarily unavailable",
      service: "ticket-service"
    });
  }

  if (error.code === "23505") {
    return res.status(409).json({
      message: "Ticket already exists"
    });
  }

  if (error.code === "23514" || error.code === "22P02") {
    return res.status(400).json({
      message: "Request violates a database constraint"
    });
  }

  return res.status(500).json({
    message: "Internal server error",
    service: "ticket-service"
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
  console.log(`Ticket Service running on port ${PORT}`);
});
