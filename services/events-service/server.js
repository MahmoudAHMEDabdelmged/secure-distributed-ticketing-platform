const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
require("dotenv").config();

const { pool, query, checkDatabaseConnection, checkRequiredSchema } = require("./db");

const app = express();
const PORT = process.env.PORT || 5001;
const AUTH_SERVICE_URL = (process.env.AUTH_SERVICE_URL || "http://localhost:5000").replace(/\/+$/, "");
const AUDIT_SERVICE_URL = (process.env.AUDIT_SERVICE_URL || "http://localhost:5006").replace(/\/+$/, "");
const NOTIFICATION_SERVICE_URL = (process.env.NOTIFICATION_SERVICE_URL || "http://localhost:5005").replace(/\/+$/, "");
const EVENT_GATE_CODE_SECRET = process.env.EVENT_GATE_CODE_SECRET || "";
const GATE_CODE_ENCRYPTION_KEY = process.env.GATE_CODE_ENCRYPTION_KEY || "";
const GATE_CODE_ACTIVE_OFFSET_MINUTES = Number(process.env.GATE_CODE_ACTIVE_OFFSET_MINUTES || 30);

const allowedStatuses = ["draft", "published", "cancelled", "completed"];
const allowedGateCodeRotatorRoles = ["admin", "security_staff", "security_leader"];
const allowedGateStaffAssignmentManagerRoles = ["admin", "security_staff", "security_leader"];
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const gateStaffCodeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

class ApiError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
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
  console.error("Events-service internal error:", {
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

async function fetchWithTimeout(url, options = {}) {
  if (typeof fetch !== "function") {
    throw new Error("Global fetch is not available in this Node.js runtime");
  }

  const timeoutMs = options.timeoutMs || 3000;
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

async function auditSecurityEvent(eventType, options = {}) {
  try {
    const response = await fetchWithTimeout(`${AUDIT_SERVICE_URL}/audit/logs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json"
      },
      body: JSON.stringify({
        event_type: eventType,
        service_name: "events-service",
        severity: options.severity || "info",
        actor_user_id: options.actor_user_id || null,
        actor_role: options.actor_role || null,
        action: options.action || eventType,
        resource_type: options.resource_type || null,
        resource_id: options.resource_id || null,
        endpoint: options.endpoint || null,
        method: options.method || null,
        status: options.status || null,
        status_code: options.status_code || null,
        is_suspicious: options.is_suspicious === true,
        suspicious_reason: options.suspicious_reason || null,
        metadata: options.metadata || {}
      }),
      timeoutMs: 3000
    });

    if (!response.ok) {
      console.warn("Audit logging failed for events-service event:", {
        event_type: eventType,
        status_code: response.status
      });
    }
  } catch (error) {
    console.warn("Audit service unavailable for events-service event:", {
      event_type: eventType,
      message: error.name === "AbortError" ? "Audit request timed out" : error.message
    });
  }
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeOptionalString(value, fieldName = "field") {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== "string") {
    throw new ApiError(400, `${fieldName} must be a string`);
  }

  const trimmedValue = value.trim();

  return trimmedValue.length > 0 ? trimmedValue : null;
}

function assertUuid(value, fieldName) {
  if (value !== undefined && value !== null && value !== "" && !uuidPattern.test(value)) {
    throw new ApiError(400, `${fieldName} must be a valid UUID`);
  }
}

function assertRequiredUuid(value, fieldName) {
  if (typeof value !== "string" || !uuidPattern.test(value)) {
    throw new ApiError(400, `${fieldName} must be a valid UUID`);
  }
}

function parseDate(value, fieldName) {
  if (!isNonEmptyString(value)) {
    throw new ApiError(400, `${fieldName} is required`);
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new ApiError(400, `${fieldName} must be a valid date`);
  }

  return date;
}

function parseOptionalDate(value, fieldName) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new ApiError(400, `${fieldName} must be a valid date`);
    }

    return value;
  }

  if (typeof value !== "string") {
    throw new ApiError(400, `${fieldName} must be a valid date`);
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new ApiError(400, `${fieldName} must be a valid date`);
  }

  return date;
}

function normalizeMetadata(value) {
  if (value === undefined || value === null) {
    return {};
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "metadata must be an object");
  }

  return value;
}

function normalizeGateCode(value) {
  if (!isNonEmptyString(value)) {
    throw new ApiError(400, "code is required");
  }

  const code = value.trim();

  if (code.length < 6 || code.length > 200) {
    throw new ApiError(400, "code must be between 6 and 200 characters");
  }

  return code;
}

function hashGateCode(code) {
  if (EVENT_GATE_CODE_SECRET) {
    return crypto.createHmac("sha256", EVENT_GATE_CODE_SECRET).update(code).digest("hex");
  }

  return crypto.createHash("sha256").update(code).digest("hex");
}

function createCodeHint(code) {
  return code.slice(-4);
}

function hashStaffGateCode(code) {
  const secret = EVENT_GATE_CODE_SECRET || GATE_CODE_ENCRYPTION_KEY;

  if (secret) {
    return crypto.createHmac("sha256", secret).update(code).digest("hex");
  }

  return crypto.createHash("sha256").update(code).digest("hex");
}

function getGateCodeEncryptionKey() {
  if (!GATE_CODE_ENCRYPTION_KEY) {
    return null;
  }

  const trimmedKey = GATE_CODE_ENCRYPTION_KEY.trim();
  let keyBuffer;

  if (/^[0-9a-f]{64}$/i.test(trimmedKey)) {
    keyBuffer = Buffer.from(trimmedKey, "hex");
  } else {
    keyBuffer = Buffer.from(trimmedKey, "base64");
  }

  return keyBuffer.length === 32 ? keyBuffer : null;
}

function assertGateCodeEncryptionConfigured() {
  const key = getGateCodeEncryptionKey();

  if (!key) {
    throw new ApiError(503, "Gate code encryption is not configured");
  }

  return key;
}

function encryptStaffGateCode(code) {
  const key = assertGateCodeEncryptionConfigured();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(code, "utf8"), cipher.final()]);

  return {
    gate_code_encrypted: encrypted.toString("base64"),
    gate_code_iv: iv.toString("base64"),
    gate_code_auth_tag: cipher.getAuthTag().toString("base64")
  };
}

function decryptStaffGateCode(assignment) {
  const key = assertGateCodeEncryptionConfigured();

  if (!assignment.gate_code_encrypted || !assignment.gate_code_iv || !assignment.gate_code_auth_tag) {
    throw new ApiError(503, "Gate code cannot be displayed because encrypted code data is missing");
  }

  try {
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(assignment.gate_code_iv, "base64")
    );

    decipher.setAuthTag(Buffer.from(assignment.gate_code_auth_tag, "base64"));

    return Buffer.concat([
      decipher.update(Buffer.from(assignment.gate_code_encrypted, "base64")),
      decipher.final()
    ]).toString("utf8");
  } catch (error) {
    throw new ApiError(503, "Gate code cannot be displayed because encrypted code data is invalid");
  }
}

function generateStaffGateCode() {
  let code = "";

  for (let index = 0; index < 8; index += 1) {
    const randomIndex = crypto.randomInt(0, gateStaffCodeAlphabet.length);
    code += gateStaffCodeAlphabet[randomIndex];
  }

  return code;
}

function normalizeStaffGateCode(value) {
  if (!isNonEmptyString(value)) {
    throw new ApiError(400, "gate_code is required");
  }

  const code = value.trim().toUpperCase();

  if (!/^[A-Z0-9-]{4,64}$/.test(code)) {
    throw new ApiError(400, "gate_code format is invalid");
  }

  return code;
}

function normalizeOffsetMinutes() {
  if (!Number.isFinite(GATE_CODE_ACTIVE_OFFSET_MINUTES) || GATE_CODE_ACTIVE_OFFSET_MINUTES < 0) {
    return 30;
  }

  return GATE_CODE_ACTIVE_OFFSET_MINUTES;
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function computeGateCodeWindow(event, body = {}) {
  const eventStart = new Date(event.starts_at);
  const eventEnd = new Date(event.ends_at || event.starts_at);
  const defaultActiveFrom = addMinutes(eventStart, -normalizeOffsetMinutes());
  const defaultExpiresAt = eventEnd > eventStart ? eventEnd : addMinutes(eventStart, 240);
  const activeFrom = parseOptionalDate(body.code_active_from, "code_active_from") || defaultActiveFrom;
  const expiresAt = parseOptionalDate(body.code_expires_at, "code_expires_at") || defaultExpiresAt;

  if (expiresAt <= activeFrom) {
    throw new ApiError(400, "code_expires_at must be after code_active_from");
  }

  return {
    activeFrom,
    expiresAt
  };
}

function getAssignmentWindowState(assignment, now = new Date()) {
  const activeFrom = new Date(assignment.code_active_from);
  const expiresAt = new Date(assignment.code_expires_at);

  if (assignment.status === "revoked" || assignment.revoked_at) {
    return {
      status: "revoked",
      reason: "GATE_CODE_REVOKED",
      seconds_until_active: 0
    };
  }

  if (now < activeFrom) {
    return {
      status: "locked",
      reason: "CODE_NOT_ACTIVE_YET",
      seconds_until_active: Math.max(Math.ceil((activeFrom.getTime() - now.getTime()) / 1000), 0)
    };
  }

  if (now > expiresAt) {
    return {
      status: "expired",
      reason: "CODE_EXPIRED",
      seconds_until_active: 0
    };
  }

  return {
    status: "active",
    reason: null,
    seconds_until_active: 0
  };
}

function createInitialAssignmentStatus(activeFrom, expiresAt, now = new Date()) {
  if (now >= expiresAt) {
    return "expired";
  }

  if (now >= activeFrom) {
    return "active";
  }

  return "assigned";
}

async function fetchUserAccess(userId) {
  let response;

  try {
    response = await fetchWithTimeout(`${AUTH_SERVICE_URL}/internal/users/${encodeURIComponent(userId)}/access`, {
      headers: {
        accept: "application/json"
      },
      timeoutMs: 3000
    });
  } catch (error) {
    console.error("Auth Service access check failed:", {
      message: error.name === "AbortError" ? "Auth Service request timed out" : error.message
    });
    throw new ApiError(503, "Auth Service unavailable, gate code rotation cannot be authorized now");
  }

  if (response.status === 404) {
    throw new ApiError(403, "Rotating user is not authorized");
  }

  if (!response.ok) {
    throw new ApiError(503, "Auth Service unavailable, gate code rotation cannot be authorized now");
  }

  const payload = await response.json();

  if (!payload || typeof payload.role !== "string" || typeof payload.staff_status !== "string") {
    throw new ApiError(503, "Auth Service returned an invalid access response");
  }

  return payload;
}

async function createInAppNotification(notification) {
  try {
    const response = await fetchWithTimeout(`${NOTIFICATION_SERVICE_URL}/notifications/in-app`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json"
      },
      body: JSON.stringify(notification),
      timeoutMs: 3000
    });

    if (!response.ok) {
      console.warn("In-app notification creation failed for events-service:", {
        type: notification.type,
        status_code: response.status
      });
    }
  } catch (error) {
    console.warn("Notification Service unavailable for events-service in-app notification:", {
      type: notification.type,
      message: error.name === "AbortError" ? "Notification request timed out" : error.message
    });
  }
}

async function createSecurityGateNotification(type, title, message, metadata = {}) {
  const commonPayload = {
    scope: "role",
    type,
    title,
    message,
    severity: "critical",
    resource_type: metadata.event_id ? "event" : null,
    resource_id: metadata.event_id || null,
    metadata
  };

  await createInAppNotification({
    ...commonPayload,
    recipient_role: "security_staff"
  });
  await createInAppNotification({
    ...commonPayload,
    recipient_role: "security_leader"
  });
}

function toGateStaffAssignment(row) {
  return {
    id: row.id,
    event_id: row.event_id,
    staff_user_id: row.staff_user_id,
    assigned_by_user_id: row.assigned_by_user_id,
    code_hint: row.code_hint,
    code_active_from: row.code_active_from,
    code_expires_at: row.code_expires_at,
    status: row.status,
    failed_attempts: row.failed_attempts,
    last_used_at: row.last_used_at,
    last_failed_at: row.last_failed_at,
    revoked_at: row.revoked_at,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function toGateStaffEventAssignment(row) {
  const windowState = getAssignmentWindowState(row);

  return {
    event: {
      id: row.event_id,
      title: row.title,
      description: row.description,
      category: row.category,
      starts_at: row.starts_at,
      ends_at: row.ends_at,
      status: row.event_status,
      image_url: row.image_url,
      venue: row.venue_name
        ? {
            name: row.venue_name,
            city: row.venue_city,
            country: row.venue_country
          }
        : null
    },
    assignment: toGateStaffAssignment(row),
    code_status: windowState.status,
    locked: windowState.status === "locked",
    active_from: row.code_active_from,
    expires_at: row.code_expires_at,
    seconds_until_active: windowState.seconds_until_active
  };
}

async function assertGateStaffUser(userId) {
  const access = await fetchUserAccess(userId);

  if (access.role !== "gate_staff" || access.staff_status !== "active" || access.can_verify_tickets !== true) {
    throw new ApiError(403, "User must be active gate_staff");
  }

  return access;
}

async function assertGateAssignmentManager(userId) {
  const access = await fetchUserAccess(userId);

  if (
    access.staff_status !== "active" ||
    !access.is_active_staff ||
    !allowedGateStaffAssignmentManagerRoles.includes(access.role)
  ) {
    throw new ApiError(403, "Only active admin or security staff can manage gate staff assignments");
  }

  return access;
}

async function createUniqueStaffGateCode() {
  for (let attempts = 0; attempts < 10; attempts += 1) {
    const code = generateStaffGateCode();
    const codeHash = hashStaffGateCode(code);
    const existingResult = await query(
      `select id
       from public.event_gate_staff_assignments
       where gate_code_hash = $1
       limit 1`,
      [codeHash]
    );

    if (existingResult.rowCount === 0) {
      return {
        code,
        codeHash
      };
    }
  }

  throw new ApiError(503, "Unable to generate a unique gate code");
}

const gateStaffAssignmentSelectSql = `
  select
    id,
    event_id,
    staff_user_id,
    assigned_by_user_id,
    code_hint,
    code_active_from,
    code_expires_at,
    status,
    failed_attempts,
    last_used_at,
    last_failed_at,
    revoked_at,
    created_at,
    updated_at
  from public.event_gate_staff_assignments
`;

async function getGateStaffAssignment(eventId, assignmentId) {
  const result = await query(
    `${gateStaffAssignmentSelectSql}
     where event_id = $1
     and id = $2
     limit 1`,
    [eventId, assignmentId]
  );

  return result.rows[0] || null;
}

async function recordGateCodeFailure(assignment, reason) {
  if (assignment) {
    await query(
      `update public.event_gate_staff_assignments
       set failed_attempts = failed_attempts + 1,
           last_failed_at = now(),
           status = case
             when $2 = 'CODE_EXPIRED' then 'expired'
             else status
           end
       where id = $1`,
      [assignment.id, reason]
    );
  }
}

function parseIntegerQuery(value, fieldName, defaultValue, options = {}) {
  if (value === undefined) {
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

function normalizeStatus(status) {
  const normalizedStatus = status === undefined || status === null || status === ""
    ? "published"
    : String(status).trim().toLowerCase();

  if (!allowedStatuses.includes(normalizedStatus)) {
    throw new ApiError(400, `status must be one of: ${allowedStatuses.join(", ")}`);
  }

  return normalizedStatus;
}

function validateSections(sections) {
  if (sections === undefined) {
    return [];
  }

  if (!Array.isArray(sections)) {
    throw new ApiError(400, "sections must be an array");
  }

  const seenNames = new Set();

  return sections.map((section, index) => {
    if (!section || typeof section !== "object" || Array.isArray(section)) {
      throw new ApiError(400, `sections[${index}] must be an object`);
    }

    if (!isNonEmptyString(section.name)) {
      throw new ApiError(400, `sections[${index}].name is required`);
    }

    if (!Number.isInteger(section.price_cents) || section.price_cents < 0) {
      throw new ApiError(400, `sections[${index}].price_cents must be a non-negative integer`);
    }

    if (!Number.isInteger(section.total_capacity) || section.total_capacity <= 0) {
      throw new ApiError(400, `sections[${index}].total_capacity must be a positive integer`);
    }

    const currency = section.currency === undefined || section.currency === null || section.currency === ""
      ? "EGP"
      : String(section.currency).trim().toUpperCase();

    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new ApiError(400, `sections[${index}].currency must be 3 letters`);
    }

    const name = section.name.trim();

    if (seenNames.has(name.toLowerCase())) {
      throw new ApiError(400, `sections[${index}].name must be unique within the event`);
    }

    seenNames.add(name.toLowerCase());

    return {
      name,
      price_cents: section.price_cents,
      currency,
      total_capacity: section.total_capacity,
      available_capacity: section.total_capacity
    };
  });
}

function buildEventSelectSql(whereSql) {
  return `
    select
      e.id,
      e.venue_id,
      e.title,
      e.description,
      e.category,
      e.starts_at,
      e.ends_at,
      e.status,
      e.image_url,
      e.created_by_user_id,
      e.created_at,
      e.updated_at,
      case
        when v.id is null then null
        else json_build_object(
          'id', v.id,
          'name', v.name,
          'city', v.city,
          'country', v.country,
          'address', v.address,
          'created_at', v.created_at,
          'updated_at', v.updated_at
        )
      end as venue,
      coalesce(sections.items, '[]'::json) as sections
    from public.events e
    left join public.venues v on v.id = e.venue_id
    left join lateral (
      select json_agg(
        json_build_object(
          'id', s.id,
          'event_id', s.event_id,
          'name', s.name,
          'price_cents', s.price_cents,
          'currency', s.currency,
          'total_capacity', s.total_capacity,
          'available_capacity', s.available_capacity,
          'created_at', s.created_at,
          'updated_at', s.updated_at
        )
        order by s.name asc
      ) as items
      from public.event_sections s
      where s.event_id = e.id
    ) sections on true
    ${whereSql}
  `;
}

async function fetchEventById(eventId, client = { query }) {
  const sql = `${buildEventSelectSql("where e.id = $1")}
     limit 1`;
  const result = await runClientQuery(client, sql, [eventId]);

  return result.rows[0] || null;
}

app.get("/health", (req, res) => {
  res.json({
    service: "events-service",
    status: "up",
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime())
  });
});

app.get(
  "/health/deep",
  asyncHandler(async (req, res) => {
    const startedAt = Date.now();

    try {
      const database = await checkDatabaseConnection();
      let schema;

      try {
        schema = await checkRequiredSchema();
      } catch (schemaError) {
        console.error("Events schema check failed:", {
          message: schemaError.message,
          code: schemaError.code,
          sql: schemaError.sql,
          stack: schemaError.stack
        });

        schema = {
          status: "unknown",
          error: schemaError.message
        };
      }

      return res.json({
        service: "events-service",
        status: "healthy",
        database: {
          ...database,
          schema
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      return res.status(503).json({
        service: "events-service",
        status: "degraded",
        database: {
          status: "down",
          latencyMs: Date.now() - startedAt,
          error: error.message
        },
        timestamp: new Date().toISOString()
      });
    }
  })
);

app.get(
  "/venues",
  asyncHandler(async (req, res) => {
    const result = await query(
      `select id, name, city, country, address, created_at, updated_at
       from public.venues
       order by created_at desc`
    );

    return res.json({
      data: result.rows
    });
  })
);

app.post(
  "/venues",
  asyncHandler(async (req, res) => {
    const { name, city, country } = req.body;

    if (!isNonEmptyString(name)) {
      throw new ApiError(400, "name is required");
    }

    if (!isNonEmptyString(city)) {
      throw new ApiError(400, "city is required");
    }

    if (!isNonEmptyString(country)) {
      throw new ApiError(400, "country is required");
    }

    const address = normalizeOptionalString(req.body.address, "address");

    const result = await query(
      `insert into public.venues (name, city, country, address)
       values ($1, $2, $3, $4)
       returning id, name, city, country, address, created_at, updated_at`,
      [name.trim(), city.trim(), country.trim(), address]
    );

    return res.status(201).json({
      data: result.rows[0]
    });
  })
);

app.get(
  "/events",
  asyncHandler(async (req, res) => {
    const filters = [];
    const params = [];
    const addParam = (value) => {
      params.push(value);
      return `$${params.length}`;
    };

    if (req.query.status === undefined || req.query.status === "") {
      filters.push(`e.status = ${addParam("published")}`);
    } else if (String(req.query.status).trim().toLowerCase() !== "all") {
      filters.push(`e.status = ${addParam(normalizeStatus(req.query.status))}`);
    }

    if (req.query.search !== undefined && req.query.search !== "") {
      const search = `%${String(req.query.search).trim()}%`;
      filters.push(`(e.title ilike ${addParam(search)} or e.description ilike ${addParam(search)})`);
    }

    if (req.query.category !== undefined && req.query.category !== "") {
      filters.push(`e.category = ${addParam(String(req.query.category).trim())}`);
    }

    if (req.query.venue_id !== undefined && req.query.venue_id !== "") {
      assertUuid(req.query.venue_id, "venue_id");
      filters.push(`e.venue_id = ${addParam(req.query.venue_id)}`);
    }

    if (req.query.from !== undefined && req.query.from !== "") {
      const fromDate = parseDate(req.query.from, "from");
      filters.push(`e.starts_at >= ${addParam(fromDate.toISOString())}`);
    }

    if (req.query.to !== undefined && req.query.to !== "") {
      const toDate = parseDate(req.query.to, "to");
      filters.push(`e.starts_at <= ${addParam(toDate.toISOString())}`);
    }

    const limit = parseIntegerQuery(req.query.limit, "limit", 50, { min: 1, max: 100 });
    const offset = parseIntegerQuery(req.query.offset, "offset", 0, { min: 0 });
    const whereSql = filters.length > 0 ? `where ${filters.join(" and ")}` : "";

    params.push(limit);
    const limitPlaceholder = `$${params.length}`;
    params.push(offset);
    const offsetPlaceholder = `$${params.length}`;

    const result = await query(
      `${buildEventSelectSql(whereSql)}
       order by e.starts_at asc
       limit ${limitPlaceholder}
       offset ${offsetPlaceholder}`,
      params
    );

    return res.json({
      data: result.rows,
      pagination: {
        limit,
        offset,
        count: result.rowCount
      }
    });
  })
);

app.get(
  "/events/gate-staff/my-events",
  asyncHandler(async (req, res) => {
    const staffUserId = req.query.staff_user_id;

    assertRequiredUuid(staffUserId, "staff_user_id");
    await assertGateStaffUser(staffUserId);

    const result = await query(
      `select
         a.id,
         a.event_id,
         a.staff_user_id,
         a.assigned_by_user_id,
         a.code_hint,
         a.code_active_from,
         a.code_expires_at,
         a.status,
         a.failed_attempts,
         a.last_used_at,
         a.last_failed_at,
         a.revoked_at,
         a.created_at,
         a.updated_at,
         e.title,
         e.description,
         e.category,
         e.starts_at,
         e.ends_at,
         e.status as event_status,
         e.image_url,
         v.name as venue_name,
         v.city as venue_city,
         v.country as venue_country
       from public.event_gate_staff_assignments a
       join public.events e on e.id = a.event_id
       left join public.venues v on v.id = e.venue_id
       where a.staff_user_id = $1
       order by e.starts_at asc`,
      [staffUserId]
    );

    return res.json({
      data: result.rows.map(toGateStaffEventAssignment),
      dev_identity_fallback: !req.headers["x-user-id"]
    });
  })
);

app.post(
  "/events/:eventId/gate-staff/assignments",
  asyncHandler(async (req, res) => {
    assertRequiredUuid(req.params.eventId, "eventId");
    assertRequiredUuid(req.body.staff_user_id, "staff_user_id");
    assertRequiredUuid(req.body.assigned_by_user_id, "assigned_by_user_id");

    const event = await fetchEventById(req.params.eventId);

    if (!event) {
      throw new ApiError(404, "Event not found");
    }

    const managerAccess = await assertGateAssignmentManager(req.body.assigned_by_user_id);
    await assertGateStaffUser(req.body.staff_user_id);

    if (req.body.staff_user_id === req.body.assigned_by_user_id) {
      throw new ApiError(400, "assigned_by_user_id cannot assign their own gate code");
    }

    const window = computeGateCodeWindow(event, req.body);
    const generatedCode = await createUniqueStaffGateCode();
    const encryptedCode = encryptStaffGateCode(generatedCode.code);
    const status = createInitialAssignmentStatus(window.activeFrom, window.expiresAt);
    const result = await query(
      `insert into public.event_gate_staff_assignments (
         event_id,
         staff_user_id,
         assigned_by_user_id,
         gate_code_hash,
         gate_code_encrypted,
         gate_code_iv,
         gate_code_auth_tag,
         code_hint,
         code_active_from,
         code_expires_at,
         status
       )
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       returning
         id,
         event_id,
         staff_user_id,
         assigned_by_user_id,
         code_hint,
         code_active_from,
         code_expires_at,
         status,
         failed_attempts,
         last_used_at,
         last_failed_at,
         revoked_at,
         created_at,
         updated_at`,
      [
        req.params.eventId,
        req.body.staff_user_id,
        req.body.assigned_by_user_id,
        generatedCode.codeHash,
        encryptedCode.gate_code_encrypted,
        encryptedCode.gate_code_iv,
        encryptedCode.gate_code_auth_tag,
        createCodeHint(generatedCode.code),
        window.activeFrom.toISOString(),
        window.expiresAt.toISOString(),
        status
      ]
    );

    const assignment = result.rows[0];

    await createInAppNotification({
      recipient_user_id: assignment.staff_user_id,
      scope: "user",
      type: "GATE_STAFF_ASSIGNED",
      title: "Gate assignment created",
      message: `You were assigned to ${event.title}. Your gate code unlocks shortly before gate opening.`,
      severity: "info",
      resource_type: "event",
      resource_id: event.id,
      metadata: {
        event_id: event.id,
        assignment_id: assignment.id,
        active_from: assignment.code_active_from,
        expires_at: assignment.code_expires_at,
        code_hint: assignment.code_hint
      }
    });

    await auditSecurityEvent("GATE_STAFF_ASSIGNED", {
      actor_user_id: req.body.assigned_by_user_id,
      actor_role: managerAccess.role,
      action: "Gate staff assigned to event",
      resource_type: "event",
      resource_id: req.params.eventId,
      endpoint: "/events/:eventId/gate-staff/assignments",
      method: "POST",
      status: "assigned",
      status_code: 201,
      metadata: {
        assignment_id: assignment.id,
        staff_user_id: assignment.staff_user_id,
        code_hint: assignment.code_hint,
        active_from: assignment.code_active_from,
        expires_at: assignment.code_expires_at
      }
    });

    return res.status(201).json({
      message: "Gate staff assignment created",
      data: toGateStaffAssignment(assignment)
    });
  })
);

app.get(
  "/events/:eventId/gate-staff/assignments",
  asyncHandler(async (req, res) => {
    assertRequiredUuid(req.params.eventId, "eventId");

    const event = await fetchEventById(req.params.eventId);

    if (!event) {
      throw new ApiError(404, "Event not found");
    }

    const result = await query(
      `${gateStaffAssignmentSelectSql}
       where event_id = $1
       order by created_at desc`,
      [req.params.eventId]
    );

    return res.json({
      data: result.rows.map(toGateStaffAssignment)
    });
  })
);

app.get(
  "/events/:eventId/gate-staff/my-code",
  asyncHandler(async (req, res) => {
    assertRequiredUuid(req.params.eventId, "eventId");
    const staffUserId = req.query.staff_user_id || req.headers["x-user-id"];

    assertRequiredUuid(staffUserId, "staff_user_id");
    await assertGateStaffUser(staffUserId);

    const event = await fetchEventById(req.params.eventId);

    if (!event) {
      throw new ApiError(404, "Event not found");
    }

    const result = await query(
      `select
         id,
         event_id,
         staff_user_id,
         assigned_by_user_id,
         gate_code_hash,
         gate_code_encrypted,
         gate_code_iv,
         gate_code_auth_tag,
         code_hint,
         code_active_from,
         code_expires_at,
         status,
         failed_attempts,
         last_used_at,
         last_failed_at,
         revoked_at,
         created_at,
         updated_at
       from public.event_gate_staff_assignments
       where event_id = $1
       and staff_user_id = $2
       limit 1`,
      [req.params.eventId, staffUserId]
    );

    if (result.rowCount === 0) {
      throw new ApiError(404, "Gate staff assignment not found");
    }

    const assignment = result.rows[0];
    const state = getAssignmentWindowState(assignment);

    if (state.status === "locked") {
      return res.json({
        status: "locked",
        reason: "CODE_NOT_ACTIVE_YET",
        active_from: assignment.code_active_from,
        seconds_until_active: state.seconds_until_active,
        code_hint: assignment.code_hint
      });
    }

    if (state.status === "expired") {
      await query(
        `update public.event_gate_staff_assignments
         set status = 'expired'
         where id = $1
         and status <> 'expired'`,
        [assignment.id]
      );

      return res.json({
        status: "expired",
        reason: "CODE_EXPIRED",
        code_hint: assignment.code_hint
      });
    }

    if (state.status === "revoked") {
      return res.json({
        status: "revoked",
        reason: "GATE_CODE_REVOKED",
        code_hint: assignment.code_hint
      });
    }

    const gateCode = decryptStaffGateCode(assignment);

    await query(
      `update public.event_gate_staff_assignments
       set status = 'active'
       where id = $1
       and status = 'assigned'`,
      [assignment.id]
    );

    return res.json({
      status: "active",
      gate_code: gateCode,
      code_hint: assignment.code_hint,
      expires_at: assignment.code_expires_at
    });
  })
);

app.post(
  "/events/:eventId/gate-staff/assignments/:assignmentId/rotate",
  asyncHandler(async (req, res) => {
    assertRequiredUuid(req.params.eventId, "eventId");
    assertRequiredUuid(req.params.assignmentId, "assignmentId");
    const rotatedByUserId = req.body.rotated_by_user_id || req.body.assigned_by_user_id;

    assertRequiredUuid(rotatedByUserId, "rotated_by_user_id");

    const event = await fetchEventById(req.params.eventId);

    if (!event) {
      throw new ApiError(404, "Event not found");
    }

    const managerAccess = await assertGateAssignmentManager(rotatedByUserId);
    const existingAssignment = await getGateStaffAssignment(req.params.eventId, req.params.assignmentId);

    if (!existingAssignment) {
      throw new ApiError(404, "Gate staff assignment not found");
    }

    const window = computeGateCodeWindow(event, {
      code_active_from: req.body.code_active_from || existingAssignment.code_active_from,
      code_expires_at: req.body.code_expires_at || existingAssignment.code_expires_at
    });
    const generatedCode = await createUniqueStaffGateCode();
    const encryptedCode = encryptStaffGateCode(generatedCode.code);
    const status = createInitialAssignmentStatus(window.activeFrom, window.expiresAt);
    const result = await query(
      `update public.event_gate_staff_assignments
       set assigned_by_user_id = $3,
           gate_code_hash = $4,
           gate_code_encrypted = $5,
           gate_code_iv = $6,
           gate_code_auth_tag = $7,
           code_hint = $8,
           code_active_from = $9,
           code_expires_at = $10,
           status = $11,
           failed_attempts = 0,
           last_failed_at = null,
           revoked_at = null
       where event_id = $1
       and id = $2
       returning
         id,
         event_id,
         staff_user_id,
         assigned_by_user_id,
         code_hint,
         code_active_from,
         code_expires_at,
         status,
         failed_attempts,
         last_used_at,
         last_failed_at,
         revoked_at,
         created_at,
         updated_at`,
      [
        req.params.eventId,
        req.params.assignmentId,
        rotatedByUserId,
        generatedCode.codeHash,
        encryptedCode.gate_code_encrypted,
        encryptedCode.gate_code_iv,
        encryptedCode.gate_code_auth_tag,
        createCodeHint(generatedCode.code),
        window.activeFrom.toISOString(),
        window.expiresAt.toISOString(),
        status
      ]
    );

    const assignment = result.rows[0];

    await createInAppNotification({
      recipient_user_id: assignment.staff_user_id,
      scope: "user",
      type: "GATE_CODE_ROTATED",
      title: "Gate code rotated",
      message: `Your gate code for ${event.title} was rotated. Open the staff dashboard during the active window.`,
      severity: "warning",
      resource_type: "event",
      resource_id: event.id,
      metadata: {
        event_id: event.id,
        assignment_id: assignment.id,
        active_from: assignment.code_active_from,
        expires_at: assignment.code_expires_at,
        code_hint: assignment.code_hint
      }
    });

    await auditSecurityEvent("GATE_STAFF_CODE_ROTATED", {
      actor_user_id: rotatedByUserId,
      actor_role: managerAccess.role,
      action: "Gate staff code rotated",
      resource_type: "event",
      resource_id: req.params.eventId,
      endpoint: "/events/:eventId/gate-staff/assignments/:assignmentId/rotate",
      method: "POST",
      status: "rotated",
      status_code: 200,
      metadata: {
        assignment_id: assignment.id,
        staff_user_id: assignment.staff_user_id,
        code_hint: assignment.code_hint
      }
    });

    return res.json({
      message: "Gate staff assignment code rotated",
      data: toGateStaffAssignment(assignment)
    });
  })
);

app.post(
  "/events/:eventId/gate-staff/assignments/:assignmentId/revoke",
  asyncHandler(async (req, res) => {
    assertRequiredUuid(req.params.eventId, "eventId");
    assertRequiredUuid(req.params.assignmentId, "assignmentId");
    const revokedByUserId = req.body.revoked_by_user_id || req.body.assigned_by_user_id;

    assertRequiredUuid(revokedByUserId, "revoked_by_user_id");

    const event = await fetchEventById(req.params.eventId);

    if (!event) {
      throw new ApiError(404, "Event not found");
    }

    const managerAccess = await assertGateAssignmentManager(revokedByUserId);
    const result = await query(
      `update public.event_gate_staff_assignments
       set status = 'revoked',
           revoked_at = now()
       where event_id = $1
       and id = $2
       returning
         id,
         event_id,
         staff_user_id,
         assigned_by_user_id,
         code_hint,
         code_active_from,
         code_expires_at,
         status,
         failed_attempts,
         last_used_at,
         last_failed_at,
         revoked_at,
         created_at,
         updated_at`,
      [req.params.eventId, req.params.assignmentId]
    );

    if (result.rowCount === 0) {
      throw new ApiError(404, "Gate staff assignment not found");
    }

    const assignment = result.rows[0];

    await createInAppNotification({
      recipient_user_id: assignment.staff_user_id,
      scope: "user",
      type: "GATE_CODE_REVOKED",
      title: "Gate code revoked",
      message: `Your gate access for ${event.title} was revoked.`,
      severity: "warning",
      resource_type: "event",
      resource_id: event.id,
      metadata: {
        event_id: event.id,
        assignment_id: assignment.id,
        code_hint: assignment.code_hint
      }
    });

    await auditSecurityEvent("GATE_STAFF_CODE_REVOKED", {
      actor_user_id: revokedByUserId,
      actor_role: managerAccess.role,
      action: "Gate staff code revoked",
      resource_type: "event",
      resource_id: req.params.eventId,
      endpoint: "/events/:eventId/gate-staff/assignments/:assignmentId/revoke",
      method: "POST",
      status: "revoked",
      status_code: 200,
      metadata: {
        assignment_id: assignment.id,
        staff_user_id: assignment.staff_user_id,
        code_hint: assignment.code_hint
      }
    });

    return res.json({
      message: "Gate staff assignment revoked",
      data: toGateStaffAssignment(assignment)
    });
  })
);

app.post(
  "/events/:eventId/gate-staff/validate-code",
  asyncHandler(async (req, res) => {
    assertRequiredUuid(req.params.eventId, "eventId");
    assertRequiredUuid(req.body.staff_user_id, "staff_user_id");
    const submittedCode = normalizeStaffGateCode(req.body.gate_code);

    const event = await fetchEventById(req.params.eventId);

    if (!event) {
      throw new ApiError(404, "Event not found");
    }

    const assignmentResult = await query(
      `select
         id,
         event_id,
         staff_user_id,
         assigned_by_user_id,
         gate_code_hash,
         code_hint,
         code_active_from,
         code_expires_at,
         status,
         failed_attempts,
         last_used_at,
         last_failed_at,
         revoked_at,
         created_at,
         updated_at
       from public.event_gate_staff_assignments
       where event_id = $1
       and staff_user_id = $2
       limit 1`,
      [req.params.eventId, req.body.staff_user_id]
    );

    const assignment = assignmentResult.rows[0] || null;
    let failureReason = null;
    const submittedHash = hashStaffGateCode(submittedCode);

    if (!assignment) {
      const otherAssignmentResult = await query(
        `select id
         from public.event_gate_staff_assignments
         where event_id = $1
         and gate_code_hash = $2
         and staff_user_id <> $3
         limit 1`,
        [req.params.eventId, submittedHash, req.body.staff_user_id]
      );

      failureReason = otherAssignmentResult.rowCount > 0
        ? "GATE_CODE_DOES_NOT_BELONG_TO_STAFF"
        : "ASSIGNMENT_NOT_FOUND";
    } else {
      const state = getAssignmentWindowState(assignment);

      if (state.status === "revoked") {
        failureReason = "GATE_CODE_REVOKED";
      } else if (state.status === "locked") {
        failureReason = "CODE_NOT_ACTIVE_YET";
      } else if (state.status === "expired") {
        failureReason = "CODE_EXPIRED";
      } else if (assignment.gate_code_hash !== submittedHash) {
        const otherAssignmentResult = await query(
          `select id
           from public.event_gate_staff_assignments
           where event_id = $1
           and gate_code_hash = $2
           and staff_user_id <> $3
           limit 1`,
          [req.params.eventId, submittedHash, req.body.staff_user_id]
        );

        failureReason = otherAssignmentResult.rowCount > 0
          ? "GATE_CODE_DOES_NOT_BELONG_TO_STAFF"
          : "INVALID_GATE_CODE";
      }
    }

    if (failureReason) {
      await recordGateCodeFailure(assignment, failureReason);

      await auditSecurityEvent("GATE_STAFF_CODE_VALIDATE_FAILED", {
        severity: ["CODE_NOT_ACTIVE_YET", "CODE_EXPIRED", "GATE_CODE_DOES_NOT_BELONG_TO_STAFF"].includes(failureReason)
          ? "high"
          : "medium",
        actor_user_id: req.body.staff_user_id,
        action: "Gate staff code validation failed",
        resource_type: "event",
        resource_id: req.params.eventId,
        endpoint: "/events/:eventId/gate-staff/validate-code",
        method: "POST",
        status: "denied",
        status_code: 200,
        is_suspicious: true,
        suspicious_reason: failureReason,
        metadata: {
          event_id: req.params.eventId,
          assignment_id: assignment ? assignment.id : null,
          code_hint: assignment ? assignment.code_hint : null,
          reason: failureReason
        }
      });

      if (["CODE_NOT_ACTIVE_YET", "CODE_EXPIRED", "INVALID_GATE_CODE", "GATE_CODE_DOES_NOT_BELONG_TO_STAFF"].includes(failureReason)) {
        await createSecurityGateNotification(
          `GATE_CODE_${failureReason}`,
          "Gate code misuse attempt",
          `Gate code validation failed for ${event.title}: ${failureReason}.`,
          {
            event_id: req.params.eventId,
            staff_user_id: req.body.staff_user_id,
            assignment_id: assignment ? assignment.id : null,
            reason: failureReason
          }
        );
      }

      return res.json({
        valid: false,
        reason: failureReason,
        event_id: req.params.eventId,
        staff_user_id: req.body.staff_user_id
      });
    }

    const updatedResult = await query(
      `update public.event_gate_staff_assignments
       set last_used_at = now(),
           status = 'active'
       where id = $1
       returning
         id,
         event_id,
         staff_user_id,
         assigned_by_user_id,
         code_hint,
         code_active_from,
         code_expires_at,
         status,
         failed_attempts,
         last_used_at,
         last_failed_at,
         revoked_at,
         created_at,
         updated_at`,
      [assignment.id]
    );

    await auditSecurityEvent("GATE_STAFF_CODE_VALIDATE_SUCCESS", {
      actor_user_id: req.body.staff_user_id,
      action: "Gate staff code validation succeeded",
      resource_type: "event",
      resource_id: req.params.eventId,
      endpoint: "/events/:eventId/gate-staff/validate-code",
      method: "POST",
      status: "success",
      status_code: 200,
      metadata: {
        assignment_id: assignment.id,
        code_hint: assignment.code_hint
      }
    });

    return res.json({
      valid: true,
      event_id: req.params.eventId,
      staff_user_id: req.body.staff_user_id,
      assignment_id: assignment.id,
      status: updatedResult.rows[0].status
    });
  })
);

app.get(
  "/events/:id",
  asyncHandler(async (req, res) => {
    assertUuid(req.params.id, "id");

    const event = await fetchEventById(req.params.id);

    if (!event) {
      throw new ApiError(404, "Event not found");
    }

    return res.json({
      data: event
    });
  })
);

app.post(
  "/events",
  asyncHandler(async (req, res) => {
    const startsAt = parseDate(req.body.starts_at, "starts_at");
    const endsAt = parseDate(req.body.ends_at, "ends_at");

    if (!isNonEmptyString(req.body.title)) {
      throw new ApiError(400, "title is required");
    }

    if (endsAt <= startsAt) {
      throw new ApiError(400, "ends_at must be after starts_at");
    }

    assertUuid(req.body.venue_id, "venue_id");
    assertUuid(req.body.created_by_user_id, "created_by_user_id");

    const sections = validateSections(req.body.sections);
    const eventData = {
      venue_id: req.body.venue_id || null,
      title: req.body.title.trim(),
      description: normalizeOptionalString(req.body.description, "description"),
      category: normalizeOptionalString(req.body.category, "category") || "general",
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
      status: normalizeStatus(req.body.status),
      image_url: normalizeOptionalString(req.body.image_url, "image_url"),
      created_by_user_id: req.body.created_by_user_id || null
    };

    const client = await pool.connect();

    try {
      await client.query("begin");

      const eventResult = await runClientQuery(
        client,
        `insert into public.events (
          venue_id,
          title,
          description,
          category,
          starts_at,
          ends_at,
          status,
          image_url,
          created_by_user_id
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        returning id`,
        [
          eventData.venue_id,
          eventData.title,
          eventData.description,
          eventData.category,
          eventData.starts_at,
          eventData.ends_at,
          eventData.status,
          eventData.image_url,
          eventData.created_by_user_id
        ]
      );

      const eventId = eventResult.rows[0].id;

      for (const section of sections) {
        await runClientQuery(
          client,
          `insert into public.event_sections (
            event_id,
            name,
            price_cents,
            currency,
            total_capacity,
            available_capacity
          )
          values ($1, $2, $3, $4, $5, $6)`,
          [
            eventId,
            section.name,
            section.price_cents,
            section.currency,
            section.total_capacity,
            section.available_capacity
          ]
        );
      }

      const createdEvent = await fetchEventById(eventId, client);

      await client.query("commit");

      return res.status(201).json({
        data: createdEvent
      });
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  })
);

app.post(
  "/events/:eventId/gate-code/rotate",
  asyncHandler(async (req, res) => {
    assertRequiredUuid(req.params.eventId, "eventId");
    assertRequiredUuid(req.body.rotated_by_user_id, "rotated_by_user_id");

    const event = await fetchEventById(req.params.eventId);

    if (!event) {
      throw new ApiError(404, "Event not found");
    }

    const access = await fetchUserAccess(req.body.rotated_by_user_id);

    if (
      access.staff_status !== "active" ||
      !access.is_active_staff ||
      !allowedGateCodeRotatorRoles.includes(access.role)
    ) {
      await auditSecurityEvent("EVENT_GATE_CODE_ROTATED", {
        severity: "high",
        actor_user_id: req.body.rotated_by_user_id,
        actor_role: access.role,
        action: "Unauthorized event gate code rotation attempt",
        resource_type: "event",
        resource_id: req.params.eventId,
        endpoint: "/events/:eventId/gate-code/rotate",
        method: "POST",
        status: "denied",
        status_code: 403,
        is_suspicious: true,
        suspicious_reason: "User does not have an authorized gate code rotation role"
      });

      throw new ApiError(403, "Only active admin or security staff can rotate event gate codes");
    }

    const code = normalizeGateCode(req.body.code);
    const expiresAt = parseOptionalDate(req.body.expires_at, "expires_at");

    if (expiresAt && expiresAt <= new Date()) {
      throw new ApiError(400, "expires_at must be in the future");
    }

    const metadata = normalizeMetadata(req.body.metadata);
    const codeHash = hashGateCode(code);
    const codeHint = createCodeHint(code);
    const client = await pool.connect();
    let rotatedCode;

    try {
      await runClientQuery(client, "begin");

      await runClientQuery(
        client,
        `update public.event_gate_access_codes
         set status = 'revoked',
             revoked_at = now()
         where event_id = $1
         and status = 'active'`,
        [req.params.eventId]
      );

      const result = await runClientQuery(
        client,
        `insert into public.event_gate_access_codes (
           event_id,
           code_hash,
           code_hint,
           rotated_by_user_id,
           status,
           metadata,
           expires_at
         )
         values ($1, $2, $3, $4, 'active', $5::jsonb, $6)
         returning id, event_id, code_hint, rotated_by_user_id, status, metadata, created_at, expires_at, revoked_at`,
        [
          req.params.eventId,
          codeHash,
          codeHint,
          req.body.rotated_by_user_id,
          JSON.stringify(metadata),
          expiresAt ? expiresAt.toISOString() : null
        ]
      );

      rotatedCode = result.rows[0];
      await runClientQuery(client, "commit");
    } catch (error) {
      await runClientQuery(client, "rollback");
      throw error;
    } finally {
      client.release();
    }

    await auditSecurityEvent("EVENT_GATE_CODE_ROTATED", {
      actor_user_id: req.body.rotated_by_user_id,
      actor_role: access.role,
      action: "Event gate access code rotated",
      resource_type: "event",
      resource_id: req.params.eventId,
      endpoint: "/events/:eventId/gate-code/rotate",
      method: "POST",
      status: "active",
      status_code: 201,
      metadata: {
        gate_code_id: rotatedCode.id,
        code_hint: rotatedCode.code_hint,
        expires_at: rotatedCode.expires_at
      }
    });

    return res.status(201).json({
      data: {
        id: rotatedCode.id,
        event_id: rotatedCode.event_id,
        code_hint: rotatedCode.code_hint,
        status: rotatedCode.status,
        expires_at: rotatedCode.expires_at,
        created_at: rotatedCode.created_at
      }
    });
  })
);

app.post(
  "/events/:eventId/gate-code/validate",
  asyncHandler(async (req, res) => {
    assertRequiredUuid(req.params.eventId, "eventId");

    const event = await fetchEventById(req.params.eventId);

    if (!event) {
      throw new ApiError(404, "Event not found");
    }

    let code;

    try {
      code = normalizeGateCode(req.body.code);
    } catch (error) {
      await auditSecurityEvent("EVENT_GATE_CODE_VALIDATE_FAILED", {
        severity: "medium",
        action: "Event gate access code validation failed",
        resource_type: "event",
        resource_id: req.params.eventId,
        endpoint: "/events/:eventId/gate-code/validate",
        method: "POST",
        status: "failed",
        status_code: error.statusCode || 400,
        metadata: {
          reason: "invalid_code_format"
        }
      });

      throw error;
    }

    const codeHash = hashGateCode(code);
    const result = await query(
      `select id, event_id, status, expires_at
       from public.event_gate_access_codes
       where event_id = $1
       and status = 'active'
       and (expires_at is null or expires_at > now())
       and code_hash = $2
       order by created_at desc
       limit 1`,
      [req.params.eventId, codeHash]
    );

    if (result.rowCount === 0) {
      await auditSecurityEvent("EVENT_GATE_CODE_VALIDATE_FAILED", {
        severity: "medium",
        action: "Event gate access code validation failed",
        resource_type: "event",
        resource_id: req.params.eventId,
        endpoint: "/events/:eventId/gate-code/validate",
        method: "POST",
        status: "failed",
        status_code: 200,
        metadata: {
          reason: "code_mismatch_or_expired"
        }
      });

      return res.json({
        valid: false,
        event_id: req.params.eventId,
        status: "invalid"
      });
    }

    await auditSecurityEvent("EVENT_GATE_CODE_VALIDATE_SUCCESS", {
      action: "Event gate access code validation succeeded",
      resource_type: "event",
      resource_id: req.params.eventId,
      endpoint: "/events/:eventId/gate-code/validate",
      method: "POST",
      status: "active",
      status_code: 200,
      metadata: {
        gate_code_id: result.rows[0].id
      }
    });

    return res.json({
      valid: true,
      event_id: result.rows[0].event_id,
      status: result.rows[0].status
    });
  })
);

app.get(
  "/events/:eventId/gate-code/status",
  asyncHandler(async (req, res) => {
    assertRequiredUuid(req.params.eventId, "eventId");

    const event = await fetchEventById(req.params.eventId);

    if (!event) {
      throw new ApiError(404, "Event not found");
    }

    const result = await query(
      `select id, event_id, code_hint, status, expires_at, created_at
       from public.event_gate_access_codes
       where event_id = $1
       and status = 'active'
       and (expires_at is null or expires_at > now())
       order by created_at desc
       limit 1`,
      [req.params.eventId]
    );

    if (result.rowCount === 0) {
      return res.json({
        event_id: req.params.eventId,
        active: false,
        code_hint: null,
        expires_at: null
      });
    }

    const activeCode = result.rows[0];

    return res.json({
      event_id: activeCode.event_id,
      active: true,
      code_hint: activeCode.code_hint,
      expires_at: activeCode.expires_at
    });
  })
);

app.use((req, res) => {
  res.status(404).json({
    error: "Route not found"
  });
});

app.use((error, req, res, next) => {
  if (error instanceof ApiError) {
    return res.status(error.statusCode).json({
      error: error.message
    });
  }

  if (error.type === "entity.parse.failed") {
    return res.status(400).json({
      error: "Invalid JSON payload"
    });
  }

  logInternalError(error, req);

  if (error.code === "23503") {
    return res.status(400).json({
      error: "Referenced venue does not exist"
    });
  }

  if (error.code === "23505") {
    return res.status(409).json({
      error: "A record with those values already exists"
    });
  }

  if (error.code === "23514" || error.code === "22P02") {
    return res.status(400).json({
      error: "Request violates a database constraint"
    });
  }

  if (error.code === "42P01" || error.code === "42703") {
    return res.status(503).json({
      error: "Events database schema is not ready. Apply the Phase 4 events-db migration to the correct database."
    });
  }

  return res.status(500).json({
    error: "Internal server error"
  });
});

process.on("SIGINT", () => {
  process.exit(0);
});

process.on("SIGTERM", () => {
  process.exit(0);
});

app.listen(PORT, () => {
  console.log(`Events Service running on port ${PORT}`);
});
