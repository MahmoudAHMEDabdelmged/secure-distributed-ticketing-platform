const crypto = require("crypto");
const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const { pool, query } = require("./db");
require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || "dev_secret_change_me";
const AUDIT_SERVICE_URL = (process.env.AUDIT_SERVICE_URL || "http://localhost:5006").replace(/\/+$/, "");

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const userRoles = ["user", "regular_employee", "gate_staff", "admin", "security_staff", "security_leader"];
const staffRoles = ["regular_employee", "gate_staff", "admin", "security_staff", "security_leader"];
const onboardingTargetRoles = ["regular_employee", "gate_staff", "admin", "security_staff"];
const internalCreatorRoles = ["regular_employee", "admin", "security_staff", "security_leader"];
const securityTeamRoles = ["security_staff", "security_leader"];
const requestStatuses = ["pending", "approved", "rejected", "activated", "cancelled"];
const approvalDecisions = ["approved", "rejected"];

const governancePolicies = {
  admin: {
    target_role: "admin",
    required_approvals: 2,
    approval_policy: "security_two_person",
    approver_roles: securityTeamRoles,
    leader_override_allowed: false,
    description: "New admins require two approvals from active security_staff or security_leader users."
  },
  regular_employee: {
    target_role: "regular_employee",
    required_approvals: 2,
    approval_policy: "security_two_person",
    approver_roles: securityTeamRoles,
    leader_override_allowed: false,
    description: "New regular employees require two approvals from active security_staff or security_leader users."
  },
  security_staff: {
    target_role: "security_staff",
    required_approvals: 4,
    approval_policy: "security_four_person_or_leader",
    approver_roles: securityTeamRoles,
    leader_override_allowed: true,
    leader_override_role: "security_leader",
    description: "New security staff require four security approvals, or one active security_leader override."
  },
  gate_staff: {
    target_role: "gate_staff",
    required_approvals: 2,
    approval_policy: "regular_employee_two_person",
    approver_roles: ["regular_employee"],
    leader_override_allowed: false,
    description: "New gate staff require two approvals from active regular_employee users."
  }
};

class ApiError extends Error {
  constructor(statusCode, message, responseBody) {
    super(message);
    this.statusCode = statusCode;
    this.responseBody = responseBody || {
      error: message
    };
  }
}

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
  console.error("Auth-service internal error:", {
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

function isValidEmail(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function normalizeEmail(value, fieldName = "email") {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";

  if (!isValidEmail(email)) {
    throw new ApiError(400, `${fieldName} must be a valid email`);
  }

  return email;
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

function normalizeMetadata(value) {
  if (value === undefined || value === null) {
    return {};
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "metadata must be an object");
  }

  return value;
}

function assertUuid(value, fieldName) {
  if (typeof value !== "string" || !uuidPattern.test(value)) {
    throw new ApiError(400, `${fieldName} must be a valid UUID`);
  }

  return value;
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
        service_name: "auth-service",
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
      console.warn("Audit logging failed for auth-service event:", {
        event_type: eventType,
        status_code: response.status
      });
    }
  } catch (error) {
    console.warn("Audit service unavailable for auth-service event:", {
      event_type: eventType,
      message: error.name === "AbortError" ? "Audit request timed out" : error.message
    });
  }
}

function toSafeUser(user) {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    staff_status: user.staff_status || "active",
    must_reset_password: user.must_reset_password === true,
    createdAt: user.created_at,
    updatedAt: user.updated_at
  };
}

function toStaffUser(user) {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    staff_status: user.staff_status || "active",
    must_reset_password: user.must_reset_password === true,
    created_at: user.created_at
  };
}

function toOnboardingRequest(row) {
  return {
    id: row.id,
    target_email: row.target_email,
    target_full_name: row.target_full_name,
    target_role: row.target_role,
    status: row.status,
    requested_by_user_id: row.requested_by_user_id,
    target_user_id: row.target_user_id,
    required_approvals: row.required_approvals,
    approval_policy: row.approval_policy,
    approval_count: row.approval_count,
    leader_override: row.leader_override,
    rejection_reason: row.rejection_reason,
    metadata: row.metadata || {},
    created_at: row.created_at,
    updated_at: row.updated_at,
    approved_at: row.approved_at,
    rejected_at: row.rejected_at,
    activated_at: row.activated_at
  };
}

function toOnboardingApproval(row) {
  return {
    id: row.id,
    request_id: row.request_id,
    approver_user_id: row.approver_user_id,
    approver_role: row.approver_role,
    decision: row.decision,
    is_leader_override: row.is_leader_override,
    comment: row.comment,
    created_at: row.created_at
  };
}

function createToken(user) {
  return jwt.sign(
    {
      id: user.id,
      sub: user.id,
      email: user.email,
      role: user.role,
      staff_status: user.staff_status || "active"
    },
    JWT_SECRET,
    {
      expiresIn: "1h"
    }
  );
}

function policyForTargetRole(targetRole) {
  const policy = governancePolicies[targetRole];

  if (!policy) {
    throw new ApiError(400, `target_role must be one of: ${onboardingTargetRoles.join(", ")}`);
  }

  return policy;
}

function isActiveStaff(user) {
  return Boolean(user && user.staff_status === "active" && staffRoles.includes(user.role));
}

function canCreateOnboardingRequest(user) {
  return Boolean(user && user.staff_status === "active" && internalCreatorRoles.includes(user.role));
}

function canApproveRequest(request, approver) {
  if (!isActiveStaff(approver)) {
    return false;
  }

  if (request.target_role === "gate_staff") {
    return approver.role === "regular_employee";
  }

  if (request.target_role === "admin" || request.target_role === "regular_employee") {
    return securityTeamRoles.includes(approver.role);
  }

  if (request.target_role === "security_staff") {
    return securityTeamRoles.includes(approver.role);
  }

  return false;
}

function shouldLeaderOverride(request, approver) {
  return request.target_role === "security_staff" && approver.role === "security_leader";
}

async function fetchUserById(userId, client = { query }) {
  const result = await client.query(
    `select
       id,
       email,
       role,
       staff_status,
       must_reset_password,
       created_by_user_id,
       activated_at,
       created_at,
       updated_at
     from public.users
     where id = $1
     limit 1`,
    [userId]
  );

  return result.rows[0] || null;
}

async function fetchUserByEmail(email, client = { query }) {
  const result = await client.query(
    `select
       id,
       email,
       role,
       staff_status,
       must_reset_password,
       created_by_user_id,
       activated_at,
       created_at,
       updated_at
     from public.users
     where email = $1
     limit 1`,
    [email]
  );

  return result.rows[0] || null;
}

async function fetchOnboardingRequest(requestId, client = { query }, options = {}) {
  const result = await client.query(
    `select
       id,
       target_email,
       target_full_name,
       target_role,
       status,
       requested_by_user_id,
       target_user_id,
       required_approvals,
       approval_policy,
       approval_count,
       leader_override,
       rejection_reason,
       metadata,
       created_at,
       updated_at,
       approved_at,
       rejected_at,
       activated_at
     from public.staff_onboarding_requests
     where id = $1
     limit 1
     ${options.lock ? "for update" : ""}`,
    [requestId]
  );

  return result.rows[0] || null;
}

async function fetchApprovals(requestId, client = { query }) {
  const result = await client.query(
    `select
       id,
       request_id,
       approver_user_id,
       approver_role,
       decision,
       is_leader_override,
       comment,
       created_at
     from public.staff_onboarding_approvals
     where request_id = $1
     order by created_at asc`,
    [requestId]
  );

  return result.rows;
}

async function ensurePendingTargetUser({ email, requestedByUserId }, client) {
  const existingUser = await fetchUserByEmail(email, client);

  if (existingUser) {
    if (existingUser.role !== "user" && existingUser.staff_status === "active") {
      throw new ApiError(409, "Target user already has an active staff role");
    }

    return existingUser;
  }

  const randomPassword = crypto.randomBytes(32).toString("hex");
  const passwordHash = await bcrypt.hash(randomPassword, 10);
  const result = await runClientQuery(
    client,
    `insert into public.users (
       email,
       password_hash,
       role,
       staff_status,
       must_reset_password,
       created_by_user_id
     )
     values ($1, $2, 'user', 'pending_approval', true, $3)
     returning
       id,
       email,
       role,
       staff_status,
       must_reset_password,
       created_by_user_id,
       activated_at,
       created_at,
       updated_at`,
    [email, passwordHash, requestedByUserId]
  );

  return result.rows[0];
}

async function fetchRequestWithApprovals(requestId) {
  const request = await fetchOnboardingRequest(requestId);

  if (!request) {
    throw new ApiError(404, "Staff onboarding request not found");
  }

  const approvals = await fetchApprovals(requestId);

  return {
    ...toOnboardingRequest(request),
    approvals: approvals.map(toOnboardingApproval)
  };
}

app.get("/health", (req, res) => {
  res.json({
    service: "auth-service",
    status: "healthy",
    timestamp: new Date().toISOString()
  });
});

app.post(
  "/register",
  asyncHandler(async (req, res) => {
    const { password } = req.body;
    const email = typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const requestedRole = typeof req.body.role === "string" ? req.body.role.trim() : null;

    if (!isValidEmail(email) || !password) {
      return res.status(400).json({
        error: "A valid email and password are required"
      });
    }

    if (requestedRole && requestedRole !== "user") {
      await auditSecurityEvent("UNAUTHORIZED_STAFF_CREATION_ATTEMPT", {
        severity: "high",
        action: "Public registration attempted to set a privileged role",
        endpoint: "/register",
        method: "POST",
        status: "denied",
        status_code: 403,
        is_suspicious: true,
        suspicious_reason: "Public registration included a non-user role",
        metadata: {
          target_email: email,
          requested_role: requestedRole
        }
      });
    }

    const existingUser = await query(
      "select id from public.users where email = $1 limit 1",
      [email]
    );

    if (existingUser.rowCount > 0) {
      return res.status(409).json({
        error: "User already exists"
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const result = await query(
      `insert into public.users (email, password_hash, role, staff_status, must_reset_password)
       values ($1, $2, 'user', 'active', false)
       returning id, email, role, staff_status, must_reset_password, created_at, updated_at`,
      [email, hashedPassword]
    );

    return res.status(201).json({
      message: "User registered successfully",
      user: toSafeUser(result.rows[0])
    });
  })
);

app.post(
  "/login",
  asyncHandler(async (req, res) => {
    const { password } = req.body;
    const email = typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : "";

    if (!isValidEmail(email) || !password) {
      return res.status(400).json({
        error: "A valid email and password are required"
      });
    }

    const result = await query(
      `select id, email, password_hash, role, staff_status, must_reset_password, created_at, updated_at
       from public.users
       where email = $1
       limit 1`,
      [email]
    );

    if (result.rowCount === 0) {
      return res.status(401).json({
        error: "Invalid credentials"
      });
    }

    const user = result.rows[0];
    const passwordIsValid = await bcrypt.compare(password, user.password_hash);

    if (!passwordIsValid) {
      return res.status(401).json({
        error: "Invalid credentials"
      });
    }

    if (user.role !== "user" && ["disabled", "rejected"].includes(user.staff_status)) {
      return res.status(403).json({
        error: "Staff account is not active"
      });
    }

    const token = createToken(user);

    return res.json({
      message: "Login successful",
      token,
      user: toSafeUser(user)
    });
  })
);

app.get(
  "/profile",
  asyncHandler(async (req, res) => {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return res.status(401).json({
        error: "Missing Authorization header"
      });
    }

    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        error: "Invalid Authorization header format"
      });
    }

    const token = authHeader.split(" ")[1];

    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const userId = decoded.sub || decoded.id;
      const result = await query(
        `select id, email, role, staff_status, must_reset_password, created_at, updated_at
         from public.users
         where id = $1
         limit 1`,
        [userId]
      );

      if (result.rowCount === 0) {
        return res.status(404).json({
          error: "User not found"
        });
      }

      return res.json({
        profile: toSafeUser(result.rows[0])
      });
    } catch (error) {
      if (error.name === "JsonWebTokenError" || error.name === "TokenExpiredError") {
        return res.status(403).json({
          error: "Invalid or expired token"
        });
      }

      throw error;
    }
  })
);

app.get("/staff/governance/policies", (req, res) => {
  return res.json({
    data: governancePolicies
  });
});

app.post(
  "/staff/onboarding/requests",
  asyncHandler(async (req, res) => {
    const requestedByUserId = assertUuid(req.body.requested_by_user_id, "requested_by_user_id");
    const targetEmail = normalizeEmail(req.body.target_email, "target_email");
    const targetFullName = normalizeOptionalString(req.body.target_full_name, "target_full_name", 255);
    const targetRole = typeof req.body.target_role === "string" ? req.body.target_role.trim() : "";
    const metadata = normalizeMetadata(req.body.metadata);
    const policy = policyForTargetRole(targetRole);
    const creator = await fetchUserById(requestedByUserId);

    if (!canCreateOnboardingRequest(creator)) {
      await auditSecurityEvent("UNAUTHORIZED_STAFF_CREATION_ATTEMPT", {
        severity: "high",
        actor_user_id: requestedByUserId,
        actor_role: creator ? creator.role : null,
        action: "Unauthorized staff onboarding request attempt",
        endpoint: "/staff/onboarding/requests",
        method: "POST",
        status: "denied",
        status_code: 403,
        is_suspicious: true,
        suspicious_reason: "Requester is not active internal staff",
        metadata: {
          target_email: targetEmail,
          target_role: targetRole
        }
      });

      throw new ApiError(403, "Only active internal staff can create onboarding requests");
    }

    const existingPendingRequest = await query(
      `select id
       from public.staff_onboarding_requests
       where lower(target_email) = $1
       and status = 'pending'
       limit 1`,
      [targetEmail]
    );

    if (existingPendingRequest.rowCount > 0) {
      throw new ApiError(409, "A pending onboarding request already exists for this email");
    }

    const client = await pool.connect();
    let createdRequest;

    try {
      await runClientQuery(client, "begin");

      const targetUser = await ensurePendingTargetUser(
        {
          email: targetEmail,
          requestedByUserId
        },
        client
      );

      const result = await runClientQuery(
        client,
        `insert into public.staff_onboarding_requests (
           target_email,
           target_full_name,
           target_role,
           requested_by_user_id,
           target_user_id,
           required_approvals,
           approval_policy,
           metadata
         )
         values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
         returning
           id,
           target_email,
           target_full_name,
           target_role,
           status,
           requested_by_user_id,
           target_user_id,
           required_approvals,
           approval_policy,
           approval_count,
           leader_override,
           rejection_reason,
           metadata,
           created_at,
           updated_at,
           approved_at,
           rejected_at,
           activated_at`,
        [
          targetEmail,
          targetFullName,
          targetRole,
          requestedByUserId,
          targetUser.id,
          policy.required_approvals,
          policy.approval_policy,
          JSON.stringify(metadata)
        ]
      );

      createdRequest = result.rows[0];
      await runClientQuery(client, "commit");
    } catch (error) {
      await runClientQuery(client, "rollback");
      throw error;
    } finally {
      client.release();
    }

    await auditSecurityEvent("STAFF_ONBOARDING_REQUESTED", {
      actor_user_id: requestedByUserId,
      actor_role: creator.role,
      action: "Staff onboarding request created",
      resource_type: "staff_onboarding_request",
      resource_id: createdRequest.id,
      endpoint: "/staff/onboarding/requests",
      method: "POST",
      status: "pending",
      status_code: 201,
      metadata: {
        target_role: targetRole,
        target_user_id: createdRequest.target_user_id,
        approval_policy: policy.approval_policy
      }
    });

    return res.status(201).json({
      data: {
        ...toOnboardingRequest(createdRequest),
        approvals: []
      }
    });
  })
);

app.get(
  "/staff/onboarding/requests",
  asyncHandler(async (req, res) => {
    const filters = [];
    const params = [];
    const addParam = (value) => {
      params.push(value);
      return `$${params.length}`;
    };

    if (req.query.status !== undefined && req.query.status !== "") {
      const status = String(req.query.status).trim();

      if (!requestStatuses.includes(status)) {
        throw new ApiError(400, `status must be one of: ${requestStatuses.join(", ")}`);
      }

      filters.push(`status = ${addParam(status)}`);
    }

    if (req.query.target_role !== undefined && req.query.target_role !== "") {
      const targetRole = String(req.query.target_role).trim();
      policyForTargetRole(targetRole);
      filters.push(`target_role = ${addParam(targetRole)}`);
    }

    if (req.query.requested_by_user_id !== undefined && req.query.requested_by_user_id !== "") {
      filters.push(`requested_by_user_id = ${addParam(assertUuid(req.query.requested_by_user_id, "requested_by_user_id"))}`);
    }

    const limit = parseIntegerQuery(req.query.limit, "limit", 50, { min: 1, max: 100 });
    const offset = parseIntegerQuery(req.query.offset, "offset", 0, { min: 0 });
    const whereSql = filters.length > 0 ? `where ${filters.join(" and ")}` : "";

    params.push(limit);
    const limitPlaceholder = `$${params.length}`;
    params.push(offset);
    const offsetPlaceholder = `$${params.length}`;

    const result = await query(
      `select
         id,
         target_email,
         target_full_name,
         target_role,
         status,
         requested_by_user_id,
         target_user_id,
         required_approvals,
         approval_policy,
         approval_count,
         leader_override,
         rejection_reason,
         metadata,
         created_at,
         updated_at,
         approved_at,
         rejected_at,
         activated_at
       from public.staff_onboarding_requests
       ${whereSql}
       order by created_at desc
       limit ${limitPlaceholder}
       offset ${offsetPlaceholder}`,
      params
    );

    return res.json({
      data: result.rows.map(toOnboardingRequest),
      pagination: {
        limit,
        offset,
        count: result.rowCount
      }
    });
  })
);

app.get(
  "/staff/onboarding/requests/:id",
  asyncHandler(async (req, res) => {
    const requestId = assertUuid(req.params.id, "id");

    return res.json({
      data: await fetchRequestWithApprovals(requestId)
    });
  })
);

app.post(
  "/staff/onboarding/requests/:id/approve",
  asyncHandler(async (req, res) => {
    const requestId = assertUuid(req.params.id, "id");
    const approverUserId = assertUuid(req.body.approver_user_id, "approver_user_id");
    const comment = normalizeOptionalString(req.body.comment, "comment", 1000);
    const client = await pool.connect();
    let updatedRequest;
    let updatedApprovals;
    let approver;
    let activated = false;
    let leaderOverride = false;

    try {
      await runClientQuery(client, "begin");

      const request = await fetchOnboardingRequest(requestId, client, { lock: true });

      if (!request) {
        throw new ApiError(404, "Staff onboarding request not found");
      }

      if (request.status !== "pending") {
        throw new ApiError(409, "Only pending onboarding requests can be approved");
      }

      approver = await fetchUserById(approverUserId, client);

      if (approverUserId === request.requested_by_user_id) {
        await auditSecurityEvent("UNAUTHORIZED_STAFF_APPROVAL_ATTEMPT", {
          severity: "high",
          actor_user_id: approverUserId,
          actor_role: approver ? approver.role : null,
          action: "Request creator attempted to approve their own onboarding request",
          resource_type: "staff_onboarding_request",
          resource_id: request.id,
          endpoint: "/staff/onboarding/requests/:id/approve",
          method: "POST",
          status: "denied",
          status_code: 403,
          is_suspicious: true,
          suspicious_reason: "Creator cannot approve their own request",
          metadata: {
            target_role: request.target_role
          }
        });

        throw new ApiError(403, "Request creator cannot approve their own onboarding request");
      }

      if (!canApproveRequest(request, approver)) {
        await auditSecurityEvent("UNAUTHORIZED_STAFF_APPROVAL_ATTEMPT", {
          severity: "high",
          actor_user_id: approverUserId,
          actor_role: approver ? approver.role : null,
          action: "Unauthorized staff approval attempt",
          resource_type: "staff_onboarding_request",
          resource_id: request.id,
          endpoint: "/staff/onboarding/requests/:id/approve",
          method: "POST",
          status: "denied",
          status_code: 403,
          is_suspicious: true,
          suspicious_reason: "Approver does not satisfy the request approval policy",
          metadata: {
            target_role: request.target_role,
            approval_policy: request.approval_policy
          }
        });

        throw new ApiError(403, "Approver is not authorized for this onboarding request");
      }

      const duplicateResult = await runClientQuery(
        client,
        `select id, decision
         from public.staff_onboarding_approvals
         where request_id = $1
         and approver_user_id = $2
         limit 1`,
        [request.id, approverUserId]
      );

      if (duplicateResult.rowCount > 0) {
        await auditSecurityEvent("UNAUTHORIZED_STAFF_APPROVAL_ATTEMPT", {
          severity: "medium",
          actor_user_id: approverUserId,
          actor_role: approver.role,
          action: "Duplicate staff approval attempt",
          resource_type: "staff_onboarding_request",
          resource_id: request.id,
          endpoint: "/staff/onboarding/requests/:id/approve",
          method: "POST",
          status: "denied",
          status_code: 409,
          is_suspicious: true,
          suspicious_reason: "Same approver cannot decide the same request twice",
          metadata: {
            target_role: request.target_role,
            previous_decision: duplicateResult.rows[0].decision
          }
        });

        throw new ApiError(409, "Approver has already submitted a decision for this request");
      }

      leaderOverride = shouldLeaderOverride(request, approver);

      await runClientQuery(
        client,
        `insert into public.staff_onboarding_approvals (
           request_id,
           approver_user_id,
           approver_role,
           decision,
           is_leader_override,
           comment
         )
         values ($1, $2, $3, 'approved', $4, $5)`,
        [request.id, approverUserId, approver.role, leaderOverride, comment]
      );

      const approvalCountResult = await runClientQuery(
        client,
        `select count(*)::int as approval_count
         from public.staff_onboarding_approvals
         where request_id = $1
         and decision = 'approved'`,
        [request.id]
      );
      const approvalCount = approvalCountResult.rows[0].approval_count;
      activated = leaderOverride || approvalCount >= request.required_approvals;

      if (activated) {
        await runClientQuery(
          client,
          `update public.users
           set role = $1,
               staff_status = 'active',
               must_reset_password = true,
               created_by_user_id = coalesce(created_by_user_id, $2),
               activated_at = now()
           where id = $3`,
          [request.target_role, request.requested_by_user_id, request.target_user_id]
        );

        const requestResult = await runClientQuery(
          client,
          `update public.staff_onboarding_requests
           set status = 'activated',
               approval_count = $1,
               leader_override = $2,
               approved_at = coalesce(approved_at, now()),
               activated_at = now()
           where id = $3
           returning
             id,
             target_email,
             target_full_name,
             target_role,
             status,
             requested_by_user_id,
             target_user_id,
             required_approvals,
             approval_policy,
             approval_count,
             leader_override,
             rejection_reason,
             metadata,
             created_at,
             updated_at,
             approved_at,
             rejected_at,
             activated_at`,
          [approvalCount, leaderOverride, request.id]
        );

        updatedRequest = requestResult.rows[0];
      } else {
        const requestResult = await runClientQuery(
          client,
          `update public.staff_onboarding_requests
           set approval_count = $1,
               leader_override = leader_override or $2
           where id = $3
           returning
             id,
             target_email,
             target_full_name,
             target_role,
             status,
             requested_by_user_id,
             target_user_id,
             required_approvals,
             approval_policy,
             approval_count,
             leader_override,
             rejection_reason,
             metadata,
             created_at,
             updated_at,
             approved_at,
             rejected_at,
             activated_at`,
          [approvalCount, leaderOverride, request.id]
        );

        updatedRequest = requestResult.rows[0];
      }

      updatedApprovals = await fetchApprovals(request.id, client);
      await runClientQuery(client, "commit");
    } catch (error) {
      await runClientQuery(client, "rollback");
      throw error;
    } finally {
      client.release();
    }

    await auditSecurityEvent("STAFF_APPROVED", {
      actor_user_id: approverUserId,
      actor_role: approver.role,
      action: "Staff onboarding request approved",
      resource_type: "staff_onboarding_request",
      resource_id: updatedRequest.id,
      endpoint: "/staff/onboarding/requests/:id/approve",
      method: "POST",
      status: updatedRequest.status,
      status_code: 200,
      metadata: {
        target_role: updatedRequest.target_role,
        approval_count: updatedRequest.approval_count,
        required_approvals: updatedRequest.required_approvals,
        leader_override: leaderOverride
      }
    });

    if (activated) {
      await auditSecurityEvent("STAFF_ACTIVATED", {
        actor_user_id: approverUserId,
        actor_role: approver.role,
        action: "Staff account activated after onboarding approval threshold",
        resource_type: "user",
        resource_id: updatedRequest.target_user_id,
        endpoint: "/staff/onboarding/requests/:id/approve",
        method: "POST",
        status: "activated",
        status_code: 200,
        metadata: {
          request_id: updatedRequest.id,
          target_role: updatedRequest.target_role,
          leader_override: updatedRequest.leader_override
        }
      });
    }

    return res.json({
      data: {
        ...toOnboardingRequest(updatedRequest),
        approvals: updatedApprovals.map(toOnboardingApproval)
      }
    });
  })
);

app.post(
  "/staff/onboarding/requests/:id/reject",
  asyncHandler(async (req, res) => {
    const requestId = assertUuid(req.params.id, "id");
    const approverUserId = assertUuid(req.body.approver_user_id, "approver_user_id");
    const reason = normalizeOptionalString(req.body.reason, "reason", 1000) || "Rejected by authorized approver";
    const client = await pool.connect();
    let updatedRequest;
    let updatedApprovals;
    let approver;

    try {
      await runClientQuery(client, "begin");

      const request = await fetchOnboardingRequest(requestId, client, { lock: true });

      if (!request) {
        throw new ApiError(404, "Staff onboarding request not found");
      }

      if (request.status !== "pending") {
        throw new ApiError(409, "Only pending onboarding requests can be rejected");
      }

      approver = await fetchUserById(approverUserId, client);

      if (approverUserId === request.requested_by_user_id) {
        await auditSecurityEvent("UNAUTHORIZED_STAFF_APPROVAL_ATTEMPT", {
          severity: "high",
          actor_user_id: approverUserId,
          actor_role: approver ? approver.role : null,
          action: "Request creator attempted to reject their own onboarding request",
          resource_type: "staff_onboarding_request",
          resource_id: request.id,
          endpoint: "/staff/onboarding/requests/:id/reject",
          method: "POST",
          status: "denied",
          status_code: 403,
          is_suspicious: true,
          suspicious_reason: "Creator cannot reject their own request",
          metadata: {
            target_role: request.target_role
          }
        });

        throw new ApiError(403, "Request creator cannot reject their own onboarding request");
      }

      if (!canApproveRequest(request, approver)) {
        await auditSecurityEvent("UNAUTHORIZED_STAFF_APPROVAL_ATTEMPT", {
          severity: "high",
          actor_user_id: approverUserId,
          actor_role: approver ? approver.role : null,
          action: "Unauthorized staff rejection attempt",
          resource_type: "staff_onboarding_request",
          resource_id: request.id,
          endpoint: "/staff/onboarding/requests/:id/reject",
          method: "POST",
          status: "denied",
          status_code: 403,
          is_suspicious: true,
          suspicious_reason: "Approver does not satisfy the request approval policy",
          metadata: {
            target_role: request.target_role,
            approval_policy: request.approval_policy
          }
        });

        throw new ApiError(403, "Approver is not authorized for this onboarding request");
      }

      const duplicateResult = await runClientQuery(
        client,
        `select id, decision
         from public.staff_onboarding_approvals
         where request_id = $1
         and approver_user_id = $2
         limit 1`,
        [request.id, approverUserId]
      );

      if (duplicateResult.rowCount > 0) {
        throw new ApiError(409, "Approver has already submitted a decision for this request");
      }

      await runClientQuery(
        client,
        `insert into public.staff_onboarding_approvals (
           request_id,
           approver_user_id,
           approver_role,
           decision,
           comment
         )
         values ($1, $2, $3, 'rejected', $4)`,
        [request.id, approverUserId, approver.role, reason]
      );

      if (request.target_user_id) {
        await runClientQuery(
          client,
          `update public.users
           set staff_status = 'rejected'
           where id = $1
           and staff_status = 'pending_approval'`,
          [request.target_user_id]
        );
      }

      const approvedCountResult = await runClientQuery(
        client,
        `select count(*)::int as approval_count
         from public.staff_onboarding_approvals
         where request_id = $1
         and decision = 'approved'`,
        [request.id]
      );

      const requestResult = await runClientQuery(
        client,
        `update public.staff_onboarding_requests
         set status = 'rejected',
             approval_count = $1,
             rejection_reason = $2,
             rejected_at = now()
         where id = $3
         returning
           id,
           target_email,
           target_full_name,
           target_role,
           status,
           requested_by_user_id,
           target_user_id,
           required_approvals,
           approval_policy,
           approval_count,
           leader_override,
           rejection_reason,
           metadata,
           created_at,
           updated_at,
           approved_at,
           rejected_at,
           activated_at`,
        [approvedCountResult.rows[0].approval_count, reason, request.id]
      );

      updatedRequest = requestResult.rows[0];
      updatedApprovals = await fetchApprovals(request.id, client);
      await runClientQuery(client, "commit");
    } catch (error) {
      await runClientQuery(client, "rollback");
      throw error;
    } finally {
      client.release();
    }

    await auditSecurityEvent("STAFF_REJECTED", {
      actor_user_id: approverUserId,
      actor_role: approver.role,
      action: "Staff onboarding request rejected",
      resource_type: "staff_onboarding_request",
      resource_id: updatedRequest.id,
      endpoint: "/staff/onboarding/requests/:id/reject",
      method: "POST",
      status: "rejected",
      status_code: 200,
      metadata: {
        target_role: updatedRequest.target_role,
        target_user_id: updatedRequest.target_user_id
      }
    });

    return res.json({
      data: {
        ...toOnboardingRequest(updatedRequest),
        approvals: updatedApprovals.map(toOnboardingApproval)
      }
    });
  })
);

app.get(
  "/staff/users/:id",
  asyncHandler(async (req, res) => {
    const userId = assertUuid(req.params.id, "id");
    const user = await fetchUserById(userId);

    if (!user) {
      throw new ApiError(404, "User not found");
    }

    return res.json({
      data: toStaffUser(user)
    });
  })
);

app.get(
  "/internal/users/:id/access",
  asyncHandler(async (req, res) => {
    const userId = assertUuid(req.params.id, "id");
    const user = await fetchUserById(userId);

    if (!user) {
      throw new ApiError(404, "User not found");
    }

    const isActiveStaff = user.staff_status === "active" && staffRoles.includes(user.role);

    return res.json({
      id: user.id,
      role: user.role,
      staff_status: user.staff_status,
      is_active_staff: isActiveStaff,
      can_verify_tickets: isActiveStaff && user.role === "gate_staff"
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
    return res.status(error.statusCode).json(error.responseBody);
  }

  if (error.type === "entity.parse.failed") {
    return res.status(400).json({
      error: "Invalid JSON payload"
    });
  }

  logInternalError(error, req);

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
      error: "Auth database schema is not ready. Apply the Phase 10.5 auth migration."
    });
  }

  return res.status(500).json({
    error: "Internal server error"
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
  console.log(`Auth Service running on port ${PORT}`);
});
