const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
require("dotenv").config();

const { pool, query, checkDatabaseConnection, checkRequiredSchema } = require("./db");

const app = express();
const PORT = process.env.PORT || 5001;
const AUTH_SERVICE_URL = (process.env.AUTH_SERVICE_URL || "http://localhost:5000").replace(/\/+$/, "");
const AUDIT_SERVICE_URL = (process.env.AUDIT_SERVICE_URL || "http://localhost:5006").replace(/\/+$/, "");
const EVENT_GATE_CODE_SECRET = process.env.EVENT_GATE_CODE_SECRET || "";

const allowedStatuses = ["draft", "published", "cancelled", "completed"];
const allowedGateCodeRotatorRoles = ["admin", "security_staff", "security_leader"];
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
