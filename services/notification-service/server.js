const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const nodemailer = require("nodemailer");
require("dotenv").config();

const { query, checkDatabaseConnection, checkDatabaseSchema, closePool } = require("./db");

const app = express();
const PORT = process.env.PORT || 5005;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const allowedPaymentStatuses = ["succeeded", "failed", "suspicious"];
const allowedNotificationScopes = ["user", "role", "global"];
const allowedNotificationSeverities = ["info", "success", "warning", "critical"];
const sensitiveMetadataKeys = [
  "password",
  "pass",
  "secret",
  "token",
  "jwt",
  "qr",
  "gate_code",
  "gatecode",
  "card_number",
  "cardnumber",
  "cvv",
  "smtp_pass",
  "smtp_password"
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

class SmtpConfigError extends Error {
  constructor(missingVariables) {
    super("SMTP is not configured");
    this.name = "SmtpConfigError";
    this.missingVariables = missingVariables;
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
app.use(express.json({ limit: "5mb" }));

function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function compactSql(text) {
  return String(text).replace(/\s+/g, " ").trim();
}

async function runClientQuery(text, params) {
  try {
    return await query(text, params);
  } catch (error) {
    error.sql = compactSql(text);
    throw error;
  }
}

function logInternalError(error, req) {
  console.error("Notification-service internal error:", {
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

function logSmtpDeliveryError(error) {
  console.error("SMTP delivery failed:", {
    message: error.message,
    name: error.name,
    code: error.code,
    command: error.command,
    responseCode: error.responseCode
  });
}

function isDatabaseConnectivityError(error) {
  return [
    "MISSING_NOTIFICATION_DATABASE_URL",
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

function assertUuid(value, fieldName) {
  if (typeof value !== "string" || !uuidPattern.test(value)) {
    throw new ApiError(400, `${fieldName} must be a valid UUID`);
  }
}

function assertRequiredString(value, fieldName) {
  if (!isNonEmptyString(value)) {
    throw new ApiError(400, `${fieldName} is required`);
  }

  return value.trim();
}

function assertEmail(value, fieldName) {
  const email = assertRequiredString(value, fieldName).toLowerCase();

  if (!emailPattern.test(email)) {
    throw new ApiError(400, `${fieldName} must be a valid email address`);
  }

  return email;
}

function normalizeOptionalEmail(value, fieldName) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  return assertEmail(value, fieldName);
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

function normalizeOptionalUuid(value, fieldName) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  assertUuid(value, fieldName);
  return value;
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

    if (["true", "1", "yes"].includes(normalizedValue)) {
      return true;
    }

    if (["false", "0", "no"].includes(normalizedValue)) {
      return false;
    }
  }

  throw new ApiError(400, `${fieldName} must be a boolean`);
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

function assertNonNegativeInteger(value, fieldName) {
  if (!Number.isInteger(value) || value < 0) {
    throw new ApiError(400, `${fieldName} must be a non-negative integer`);
  }
}

function assertPositiveInteger(value, fieldName) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ApiError(400, `${fieldName} must be a positive integer`);
  }
}

function normalizeCurrency(value) {
  const currency = assertRequiredString(value, "currency").toUpperCase();

  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new ApiError(400, "currency must be a 3-letter string");
  }

  return currency;
}

function assertCardLast4(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  if (typeof value !== "string" || !/^\d{4}$/.test(value)) {
    throw new ApiError(400, "card_last4 must contain exactly 4 digits");
  }

  return value;
}

function assertNoRawCardData(body) {
  if (body.card_number !== undefined || body.cardNumber !== undefined || body.cvv !== undefined || body.CVV !== undefined) {
    throw new ApiError(400, "Only card_last4 is accepted for payment notifications");
  }
}

function normalizeObjectMetadata(value, fieldName = "metadata") {
  if (value === undefined || value === null) {
    return {};
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, `${fieldName} must be an object`);
  }

  return sanitizeMetadata(value);
}

function normalizeNotificationScope(value) {
  const scope = value === undefined || value === null || value === ""
    ? "user"
    : String(value).trim().toLowerCase();

  if (!allowedNotificationScopes.includes(scope)) {
    throw new ApiError(400, `scope must be one of: ${allowedNotificationScopes.join(", ")}`);
  }

  return scope;
}

function normalizeNotificationSeverity(value) {
  const severity = value === undefined || value === null || value === ""
    ? "info"
    : String(value).trim().toLowerCase();

  if (!allowedNotificationSeverities.includes(severity)) {
    throw new ApiError(400, `severity must be one of: ${allowedNotificationSeverities.join(", ")}`);
  }

  return severity;
}

function normalizeNotificationType(value) {
  const type = assertRequiredString(value, "type").toUpperCase();

  if (!/^[A-Z0-9_:-]{3,100}$/.test(type)) {
    throw new ApiError(400, "type must contain only letters, numbers, underscores, colons, or hyphens");
  }

  return type;
}

function parseOptionalFutureDate(value, fieldName) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  if (typeof value !== "string") {
    throw new ApiError(400, `${fieldName} must be a valid ISO date`);
  }

  const parsedDate = new Date(value);

  if (Number.isNaN(parsedDate.getTime())) {
    throw new ApiError(400, `${fieldName} must be a valid ISO date`);
  }

  return parsedDate.toISOString();
}

function sanitizeMetadata(value, depth = 0) {
  if (depth > 4) {
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

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatMoney(amountCents, currency) {
  return `${(amountCents / 100).toFixed(2)} ${currency}`;
}

function checkSmtpConfiguration() {
  const requiredVariables = ["SMTP_HOST", "SMTP_PORT", "SMTP_SECURE", "SMTP_USER", "SMTP_PASS", "EMAIL_FROM"];
  const missingVariables = requiredVariables.filter((key) => !isNonEmptyString(process.env[key]));

  return {
    status: missingVariables.length === 0 ? "configured" : "not_configured",
    missingVariables,
    alertRecipientConfigured: isNonEmptyString(process.env.ALERT_EMAIL_TO)
  };
}

function parseSmtpSecure(value) {
  return ["true", "1", "yes"].includes(String(value || "").trim().toLowerCase());
}

function createTransporter() {
  const smtp = checkSmtpConfiguration();

  if (smtp.status !== "configured") {
    throw new SmtpConfigError(smtp.missingVariables);
  }

  const port = Number(process.env.SMTP_PORT);

  if (!Number.isInteger(port) || port <= 0) {
    throw new SmtpConfigError(["SMTP_PORT"]);
  }

  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: parseSmtpSecure(process.env.SMTP_SECURE),
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
}

async function sendMail(mail) {
  const transporter = createTransporter();

  return transporter.sendMail({
    from: process.env.EMAIL_FROM,
    ...mail
  });
}

function toDelivery(row) {
  return {
    id: row.id,
    notification_type: row.notification_type,
    recipient_email: row.recipient_email,
    subject: row.subject,
    status: row.status,
    booking_id: row.booking_id,
    ticket_id: row.ticket_id,
    payment_id: row.payment_id,
    alert_severity: row.alert_severity,
    provider_message_id: row.provider_message_id,
    error_message: row.error_message,
    metadata: row.metadata,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function toInAppNotification(row) {
  return {
    id: row.id,
    recipient_user_id: row.recipient_user_id,
    recipient_role: row.recipient_role,
    scope: row.scope,
    type: row.type,
    title: row.title,
    message: row.message,
    severity: row.severity,
    resource_type: row.resource_type,
    resource_id: row.resource_id,
    metadata: row.metadata,
    is_read: row.is_read,
    read_at: row.read_at,
    created_at: row.created_at,
    expires_at: row.expires_at
  };
}

const inAppNotificationSelectSql = `
  select
    id,
    recipient_user_id,
    recipient_role,
    scope,
    type,
    title,
    message,
    severity,
    resource_type,
    resource_id,
    metadata,
    is_read,
    read_at,
    created_at,
    expires_at
  from public.in_app_notifications
`;

function normalizeInAppNotificationInput(body) {
  const scope = normalizeNotificationScope(body.scope);
  const recipientUserId = normalizeOptionalUuid(body.recipient_user_id, "recipient_user_id");
  const recipientRole = normalizeOptionalString(body.recipient_role, "recipient_role");

  if (scope === "user" && !recipientUserId) {
    throw new ApiError(400, "recipient_user_id is required when scope is user");
  }

  if (scope === "role" && !recipientRole) {
    throw new ApiError(400, "recipient_role is required when scope is role");
  }

  return {
    recipient_user_id: scope === "user" ? recipientUserId : recipientUserId,
    recipient_role: scope === "role" ? recipientRole : recipientRole,
    scope,
    type: normalizeNotificationType(body.type),
    title: assertRequiredString(body.title, "title"),
    message: assertRequiredString(body.message, "message"),
    severity: normalizeNotificationSeverity(body.severity),
    resource_type: normalizeOptionalString(body.resource_type, "resource_type"),
    resource_id: normalizeOptionalString(body.resource_id, "resource_id"),
    metadata: normalizeObjectMetadata(body.metadata),
    expires_at: parseOptionalFutureDate(body.expires_at, "expires_at")
  };
}

function normalizeNotificationAudience(req) {
  const userId = normalizeOptionalUuid(
    req.headers["x-user-id"] || req.query.user_id || req.body?.user_id,
    "user_id"
  );
  const role = normalizeOptionalString(
    req.headers["x-user-role"] || req.query.role || req.body?.role,
    "role"
  );

  if (!userId && !role) {
    throw new ApiError(400, "user_id or role is required");
  }

  return {
    userId,
    role
  };
}

const deliverySelectSql = `
  select
    id,
    notification_type,
    recipient_email,
    subject,
    status,
    booking_id,
    ticket_id,
    payment_id,
    alert_severity,
    provider_message_id,
    error_message,
    metadata,
    created_at,
    updated_at
  from public.notification_deliveries
`;

async function createDeliveryLog(delivery) {
  const result = await runClientQuery(
    `insert into public.notification_deliveries (
      notification_type,
      recipient_email,
      subject,
      status,
      booking_id,
      ticket_id,
      payment_id,
      alert_severity,
      metadata
    )
    values ($1, $2, $3, 'pending', $4, $5, $6, $7, $8::jsonb)
    returning
      id,
      notification_type,
      recipient_email,
      subject,
      status,
      booking_id,
      ticket_id,
      payment_id,
      alert_severity,
      provider_message_id,
      error_message,
      metadata,
      created_at,
      updated_at`,
    [
      delivery.notificationType,
      delivery.recipientEmail,
      delivery.subject,
      delivery.bookingId,
      delivery.ticketId,
      delivery.paymentId,
      delivery.alertSeverity,
      JSON.stringify(delivery.metadata || {})
    ]
  );

  return result.rows[0];
}

async function updateDeliveryStatus(deliveryId, status, fields = {}) {
  const result = await runClientQuery(
    `update public.notification_deliveries
     set status = $2,
         provider_message_id = $3,
         error_message = $4
     where id = $1
     returning
       id,
       notification_type,
       recipient_email,
       subject,
       status,
       booking_id,
       ticket_id,
       payment_id,
       alert_severity,
       provider_message_id,
       error_message,
       metadata,
       created_at,
       updated_at`,
    [
      deliveryId,
      status,
      fields.providerMessageId || null,
      fields.errorMessage || null
    ]
  );

  return result.rows[0];
}

async function deliverNotification(deliveryData, mail) {
  const pendingDelivery = await createDeliveryLog(deliveryData);

  try {
    const info = await sendMail(mail);
    const sentDelivery = await updateDeliveryStatus(pendingDelivery.id, "sent", {
      providerMessageId: info.messageId || null
    });

    return {
      statusCode: 201,
      message: "Notification sent successfully",
      delivery: sentDelivery
    };
  } catch (error) {
    logSmtpDeliveryError(error);

    const failedDelivery = await updateDeliveryStatus(pendingDelivery.id, "failed", {
      errorMessage: error instanceof SmtpConfigError
        ? "SMTP is not configured"
        : "Email delivery failed"
    });

    return {
      statusCode: error instanceof SmtpConfigError ? 503 : 502,
      message: error instanceof SmtpConfigError ? "SMTP is not configured" : "Notification delivery failed",
      delivery: failedDelivery
    };
  }
}

async function getDeliveryById(deliveryId) {
  const result = await runClientQuery(
    `${deliverySelectSql}
     where id = $1
     limit 1`,
    [deliveryId]
  );

  return result.rows[0] || null;
}

function renderLayout(title, bodyHtml) {
  return `
    <div style="font-family: Arial, sans-serif; line-height: 1.5; color: #17202a;">
      <h2>${escapeHtml(title)}</h2>
      ${bodyHtml}
    </div>
  `;
}

app.get("/health", (req, res) => {
  res.json({
    service: "notification-service",
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
      logDependencyError("Notification database", error);

      database = {
        status: "down",
        latencyMs: 0,
        schema: {
          status: "unknown",
          missingTables: [],
          missingColumns: []
        },
        error: error.code === "MISSING_NOTIFICATION_DATABASE_URL"
          ? "Notification database is not configured"
          : "Notification database is unavailable"
      };
    }

    const smtp = checkSmtpConfiguration();
    const isHealthy =
      database.status === "up" &&
      database.schema &&
      database.schema.status === "ready" &&
      smtp.status === "configured";

    return res.status(isHealthy ? 200 : 503).json({
      service: "notification-service",
      status: isHealthy ? "healthy" : "degraded",
      database,
      smtp,
      timestamp: new Date().toISOString()
    });
  })
);

app.post(
  "/notifications/ticket-email",
  asyncHandler(async (req, res) => {
    const recipientEmail = assertEmail(req.body.recipient_email, "recipient_email");
    const bookingId = req.body.booking_id;
    const ticketId = req.body.ticket_id;
    const ticketNumber = assertRequiredString(req.body.ticket_number, "ticket_number");
    const eventName = assertRequiredString(req.body.event_name, "event_name");
    const sectionName = assertRequiredString(req.body.section_name, "section_name");
    const qrCodeDataUrl = assertRequiredString(req.body.qr_code_data_url, "qr_code_data_url");
    const verificationUrl = assertRequiredString(req.body.verification_url, "verification_url");

    assertUuid(bookingId, "booking_id");
    assertUuid(ticketId, "ticket_id");

    if (!qrCodeDataUrl.startsWith("data:image/")) {
      throw new ApiError(400, "qr_code_data_url must be an image data URL");
    }

    const subject = `Your ticket ${ticketNumber}`;
    const html = renderLayout(
      "Your Ticket",
      `
        <p><strong>Ticket:</strong> ${escapeHtml(ticketNumber)}</p>
        <p><strong>Event:</strong> ${escapeHtml(eventName)}</p>
        <p><strong>Section:</strong> ${escapeHtml(sectionName)}</p>
        <p>Use the QR code below at entry, or open the verification link if needed.</p>
        <p><img src="cid:ticketQr" alt="Ticket QR code" style="max-width: 240px;" /></p>
        <p><a href="${escapeHtml(verificationUrl)}">Open ticket verification</a></p>
      `
    );
    const text = [
      `Ticket: ${ticketNumber}`,
      `Event: ${eventName}`,
      `Section: ${sectionName}`,
      `Verification: ${verificationUrl}`
    ].join("\n");

    const result = await deliverNotification(
      {
        notificationType: "ticket_email",
        recipientEmail,
        subject,
        bookingId,
        ticketId,
        paymentId: null,
        alertSeverity: null,
        metadata: {
          ticket_number: ticketNumber,
          event_name: eventName,
          section_name: sectionName,
          has_qr_code_data_url: true,
          has_verification_url: true
        }
      },
      {
        to: recipientEmail,
        subject,
        text,
        html,
        attachments: [
          {
            filename: "ticket-qr.png",
            path: qrCodeDataUrl,
            cid: "ticketQr"
          }
        ]
      }
    );

    return res.status(result.statusCode).json({
      message: result.message,
      data: toDelivery(result.delivery)
    });
  })
);

app.post(
  "/notifications/booking-confirmation",
  asyncHandler(async (req, res) => {
    const recipientEmail = assertEmail(req.body.recipient_email, "recipient_email");
    const bookingId = req.body.booking_id;
    const eventName = assertRequiredString(req.body.event_name, "event_name");
    const sectionName = assertRequiredString(req.body.section_name, "section_name");
    const quantity = req.body.quantity;
    const totalAmountCents = req.body.total_amount_cents;
    const currency = normalizeCurrency(req.body.currency);

    assertUuid(bookingId, "booking_id");
    assertPositiveInteger(quantity, "quantity");
    assertNonNegativeInteger(totalAmountCents, "total_amount_cents");

    const subject = `Booking confirmation for ${eventName}`;
    const amount = formatMoney(totalAmountCents, currency);
    const html = renderLayout(
      "Booking Confirmation",
      `
        <p>Your booking has been received.</p>
        <p><strong>Event:</strong> ${escapeHtml(eventName)}</p>
        <p><strong>Section:</strong> ${escapeHtml(sectionName)}</p>
        <p><strong>Quantity:</strong> ${quantity}</p>
        <p><strong>Total:</strong> ${escapeHtml(amount)}</p>
      `
    );
    const text = [
      "Your booking has been received.",
      `Event: ${eventName}`,
      `Section: ${sectionName}`,
      `Quantity: ${quantity}`,
      `Total: ${amount}`
    ].join("\n");

    const result = await deliverNotification(
      {
        notificationType: "booking_confirmation",
        recipientEmail,
        subject,
        bookingId,
        ticketId: null,
        paymentId: null,
        alertSeverity: null,
        metadata: {
          event_name: eventName,
          section_name: sectionName,
          quantity,
          total_amount_cents: totalAmountCents,
          currency
        }
      },
      {
        to: recipientEmail,
        subject,
        text,
        html
      }
    );

    return res.status(result.statusCode).json({
      message: result.message,
      data: toDelivery(result.delivery)
    });
  })
);

app.post(
  "/notifications/payment-status",
  asyncHandler(async (req, res) => {
    assertNoRawCardData(req.body);

    const recipientEmail = assertEmail(req.body.recipient_email, "recipient_email");
    const bookingId = req.body.booking_id;
    const paymentId = req.body.payment_id;
    const paymentStatus = assertRequiredString(req.body.payment_status, "payment_status").toLowerCase();
    const amountCents = req.body.amount_cents;
    const currency = normalizeCurrency(req.body.currency);
    const cardLast4 = assertCardLast4(req.body.card_last4);

    assertUuid(bookingId, "booking_id");
    assertUuid(paymentId, "payment_id");
    assertNonNegativeInteger(amountCents, "amount_cents");

    if (!allowedPaymentStatuses.includes(paymentStatus)) {
      throw new ApiError(400, "payment_status must be one of: succeeded, failed, suspicious");
    }

    const notificationType = paymentStatus === "succeeded" ? "payment_success" : "payment_failed";
    const subject = paymentStatus === "succeeded" ? "Payment received" : "Payment could not be completed";
    const amount = formatMoney(amountCents, currency);
    const cardText = cardLast4 ? `Card ending in ${cardLast4}` : "Test payment card";
    const html = renderLayout(
      subject,
      `
        <p><strong>Status:</strong> ${escapeHtml(paymentStatus)}</p>
        <p><strong>Amount:</strong> ${escapeHtml(amount)}</p>
        <p><strong>Card:</strong> ${escapeHtml(cardText)}</p>
      `
    );
    const text = [
      `Status: ${paymentStatus}`,
      `Amount: ${amount}`,
      `Card: ${cardText}`
    ].join("\n");

    const result = await deliverNotification(
      {
        notificationType,
        recipientEmail,
        subject,
        bookingId,
        ticketId: null,
        paymentId,
        alertSeverity: null,
        metadata: {
          payment_status: paymentStatus,
          amount_cents: amountCents,
          currency,
          card_last4: cardLast4
        }
      },
      {
        to: recipientEmail,
        subject,
        text,
        html
      }
    );

    return res.status(result.statusCode).json({
      message: result.message,
      data: toDelivery(result.delivery)
    });
  })
);

app.post(
  "/notifications/security-alert",
  asyncHandler(async (req, res) => {
    const severity = assertRequiredString(req.body.severity, "severity").toLowerCase();
    const title = assertRequiredString(req.body.title, "title");
    const message = assertRequiredString(req.body.message, "message");
    const sourceService = normalizeOptionalString(req.body.source_service, "source_service") || "unknown";
    const resourceType = normalizeOptionalString(req.body.resource_type, "resource_type");
    const resourceId = normalizeOptionalString(req.body.resource_id, "resource_id");
    const metadata = normalizeObjectMetadata(req.body.metadata);
    const recipientEmail = normalizeOptionalEmail(req.body.recipient_email, "recipient_email") ||
      normalizeOptionalEmail(process.env.ALERT_EMAIL_TO, "ALERT_EMAIL_TO");

    if (!recipientEmail) {
      throw new ApiError(503, "Alert recipient is not configured", {
        message: "Alert recipient is not configured",
        service: "notification-service"
      });
    }

    if (!["low", "medium", "high", "critical"].includes(severity)) {
      throw new ApiError(400, "severity must be one of: low, medium, high, critical");
    }

    const subject = `[${severity.toUpperCase()}] ${title}`;
    const html = renderLayout(
      subject,
      `
        <p>${escapeHtml(message)}</p>
        <p><strong>Source:</strong> ${escapeHtml(sourceService)}</p>
        ${resourceType ? `<p><strong>Resource type:</strong> ${escapeHtml(resourceType)}</p>` : ""}
        ${resourceId ? `<p><strong>Resource id:</strong> ${escapeHtml(resourceId)}</p>` : ""}
      `
    );
    const text = [
      message,
      `Source: ${sourceService}`,
      resourceType ? `Resource type: ${resourceType}` : null,
      resourceId ? `Resource id: ${resourceId}` : null
    ].filter(Boolean).join("\n");

    const result = await deliverNotification(
      {
        notificationType: "security_alert",
        recipientEmail,
        subject,
        bookingId: null,
        ticketId: null,
        paymentId: resourceType === "payment" && resourceId && uuidPattern.test(resourceId) ? resourceId : null,
        alertSeverity: severity,
        metadata: {
          title,
          message,
          source_service: sourceService,
          resource_type: resourceType,
          resource_id: resourceId,
          metadata
        }
      },
      {
        to: recipientEmail,
        subject,
        text,
        html
      }
    );

    return res.status(result.statusCode).json({
      message: result.message,
      data: toDelivery(result.delivery)
    });
  })
);

app.post(
  "/notifications/in-app",
  asyncHandler(async (req, res) => {
    const notification = normalizeInAppNotificationInput(req.body);

    const result = await runClientQuery(
      `insert into public.in_app_notifications (
         recipient_user_id,
         recipient_role,
         scope,
         type,
         title,
         message,
         severity,
         resource_type,
         resource_id,
         metadata,
         expires_at
       )
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)
       returning
         id,
         recipient_user_id,
         recipient_role,
         scope,
         type,
         title,
         message,
         severity,
         resource_type,
         resource_id,
         metadata,
         is_read,
         read_at,
         created_at,
         expires_at`,
      [
        notification.recipient_user_id,
        notification.recipient_role,
        notification.scope,
        notification.type,
        notification.title,
        notification.message,
        notification.severity,
        notification.resource_type,
        notification.resource_id,
        JSON.stringify(notification.metadata),
        notification.expires_at
      ]
    );

    return res.status(201).json({
      message: "In-app notification created",
      data: toInAppNotification(result.rows[0])
    });
  })
);

app.get(
  "/notifications/in-app",
  asyncHandler(async (req, res) => {
    const filters = [];
    const params = [];
    const addParam = (value) => {
      params.push(value);
      return `$${params.length}`;
    };

    if (req.query.recipient_user_id !== undefined && req.query.recipient_user_id !== "") {
      filters.push(`recipient_user_id = ${addParam(normalizeOptionalUuid(req.query.recipient_user_id, "recipient_user_id"))}`);
    }

    if (req.query.recipient_role !== undefined && req.query.recipient_role !== "") {
      filters.push(`recipient_role = ${addParam(normalizeOptionalString(req.query.recipient_role, "recipient_role"))}`);
    }

    if (req.query.scope !== undefined && req.query.scope !== "") {
      filters.push(`scope = ${addParam(normalizeNotificationScope(req.query.scope))}`);
    }

    if (req.query.type !== undefined && req.query.type !== "") {
      filters.push(`type = ${addParam(normalizeNotificationType(req.query.type))}`);
    }

    if (req.query.severity !== undefined && req.query.severity !== "") {
      filters.push(`severity = ${addParam(normalizeNotificationSeverity(req.query.severity))}`);
    }

    const isRead = normalizeOptionalBoolean(req.query.is_read, "is_read");

    if (isRead !== null) {
      filters.push(`is_read = ${addParam(isRead)}`);
    }

    const limit = parseIntegerQuery(req.query.limit, "limit", 50, { min: 1, max: 200 });
    const offset = parseIntegerQuery(req.query.offset, "offset", 0, { min: 0 });
    const whereSql = filters.length > 0 ? `where ${filters.join(" and ")}` : "";

    params.push(limit);
    const limitPlaceholder = `$${params.length}`;
    params.push(offset);
    const offsetPlaceholder = `$${params.length}`;

    const result = await runClientQuery(
      `${inAppNotificationSelectSql}
       ${whereSql}
       order by created_at desc
       limit ${limitPlaceholder}
       offset ${offsetPlaceholder}`,
      params
    );

    return res.json({
      data: result.rows.map(toInAppNotification),
      pagination: {
        limit,
        offset,
        count: result.rowCount
      }
    });
  })
);

app.get(
  "/notifications/in-app/me",
  asyncHandler(async (req, res) => {
    const audience = normalizeNotificationAudience(req);
    const limit = parseIntegerQuery(req.query.limit, "limit", 50, { min: 1, max: 200 });
    const offset = parseIntegerQuery(req.query.offset, "offset", 0, { min: 0 });
    const params = [audience.userId, audience.role, limit, offset];

    const result = await runClientQuery(
      `${inAppNotificationSelectSql}
       where (
         (recipient_user_id = $1)
         or ($2::varchar is not null and scope = 'role' and recipient_role = $2)
         or scope = 'global'
       )
       and (expires_at is null or expires_at > now())
       order by created_at desc
       limit $3
       offset $4`,
      params
    );

    return res.json({
      data: result.rows.map(toInAppNotification),
      dev_identity_fallback: !req.headers["x-user-id"] && !req.headers["x-user-role"],
      pagination: {
        limit,
        offset,
        count: result.rowCount
      }
    });
  })
);

app.get(
  "/notifications/in-app/unread-count",
  asyncHandler(async (req, res) => {
    const audience = normalizeNotificationAudience(req);
    const result = await runClientQuery(
      `select count(*)::int as unread_count
       from public.in_app_notifications
       where is_read = false
       and (
         (recipient_user_id = $1)
         or ($2::varchar is not null and scope = 'role' and recipient_role = $2)
         or scope = 'global'
       )
       and (expires_at is null or expires_at > now())`,
      [audience.userId, audience.role]
    );

    return res.json({
      unread_count: result.rows[0].unread_count,
      dev_identity_fallback: !req.headers["x-user-id"] && !req.headers["x-user-role"]
    });
  })
);

app.post(
  "/notifications/in-app/:id/read",
  asyncHandler(async (req, res) => {
    assertUuid(req.params.id, "id");

    const result = await runClientQuery(
      `update public.in_app_notifications
       set is_read = true,
           read_at = coalesce(read_at, now())
       where id = $1
       returning
         id,
         recipient_user_id,
         recipient_role,
         scope,
         type,
         title,
         message,
         severity,
         resource_type,
         resource_id,
         metadata,
         is_read,
         read_at,
         created_at,
         expires_at`,
      [req.params.id]
    );

    if (result.rowCount === 0) {
      throw new ApiError(404, "In-app notification not found");
    }

    return res.json({
      message: "Notification marked as read",
      data: toInAppNotification(result.rows[0])
    });
  })
);

app.post(
  "/notifications/in-app/read-all",
  asyncHandler(async (req, res) => {
    const audience = normalizeNotificationAudience(req);
    const result = await runClientQuery(
      `update public.in_app_notifications
       set is_read = true,
           read_at = coalesce(read_at, now())
       where is_read = false
       and (
         (recipient_user_id = $1)
         or ($2::varchar is not null and scope = 'role' and recipient_role = $2)
         or scope = 'global'
       )
       returning id`,
      [audience.userId, audience.role]
    );

    return res.json({
      message: "Notifications marked as read",
      updated_count: result.rowCount,
      dev_identity_fallback: !req.headers["x-user-id"] && !req.headers["x-user-role"]
    });
  })
);

app.get(
  "/notifications/booking/:bookingId",
  asyncHandler(async (req, res) => {
    assertUuid(req.params.bookingId, "bookingId");

    const result = await runClientQuery(
      `${deliverySelectSql}
       where booking_id = $1
       order by created_at desc`,
      [req.params.bookingId]
    );

    return res.json({
      data: result.rows.map(toDelivery)
    });
  })
);

app.get(
  "/notifications/:id",
  asyncHandler(async (req, res) => {
    assertUuid(req.params.id, "id");

    const delivery = await getDeliveryById(req.params.id);

    if (!delivery) {
      throw new ApiError(404, "Notification delivery not found");
    }

    return res.json({
      data: toDelivery(delivery)
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
      message: "Notifications are temporarily unavailable",
      service: "notification-service"
    });
  }

  if (error.code === "23514" || error.code === "22P02") {
    return res.status(400).json({
      message: "Request violates a database constraint"
    });
  }

  return res.status(500).json({
    message: "Internal server error",
    service: "notification-service"
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
  console.log(`Notification Service running on port ${PORT}`);
});
