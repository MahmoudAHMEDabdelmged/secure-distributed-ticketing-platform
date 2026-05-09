/**
 * Authentication utilities and helpers.
 *
 * This file wraps api-client.ts with safe convenience functions.
 * It is intentionally frontend-focused and should not be treated as backend security.
 */

import {
  getStoredSession,
  storeSession,
  type AuthSession,
} from "./api-client";
import { normalizeRole, type NormalizedRole } from "./roles";

type JwtPayload = Record<string, unknown>;

function safeGetStoredSession(): AuthSession {
  try {
    return getStoredSession();
  } catch {
    return {
      token: null,
      user: null,
    };
  }
}

/**
 * Get current user from stored session.
 */
export function getCurrentUser() {
  const session = safeGetStoredSession();
  return session.user || null;
}

/**
 * Get current authentication token.
 */
export function getToken(): string | null {
  const session = safeGetStoredSession();
  return session.token || null;
}

/**
 * Store authentication token and user.
 */
export function setSession(session: AuthSession) {
  storeSession(session);
}

/**
 * Clear current auth session.
 */
export function clearSession() {
  storeSession({
    token: null,
    user: null,
  });
}

/**
 * Decode JWT payload without verification.
 *
 * Client-side only helper.
 * Do not rely on this for security. Backend must always verify tokens.
 */
export function decodeJwtPayload(token: string): JwtPayload | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const payload = parts[1];

    // JWT uses base64url, not plain base64.
    const base64 = payload
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(payload.length / 4) * 4, "=");

    const decoded =
      typeof window !== "undefined"
        ? window.atob(base64)
        : Buffer.from(base64, "base64").toString("utf-8");

    return JSON.parse(decoded) as JwtPayload;
  } catch {
    return null;
  }
}

/**
 * Extract possible role value from JWT payload.
 */
function getRoleFromToken(token: string | null): NormalizedRole | null {
  if (!token) return null;

  const payload = decodeJwtPayload(token);
  if (!payload) return null;

  const possibleRole =
    payload.role ||
    payload.user_role ||
    payload.userRole ||
    payload.account_role ||
    payload.accountRole;

  return normalizeRole(possibleRole);
}

/**
 * Get current normalized role.
 *
 * Priority:
 * 1. session.user.role
 * 2. JWT role claim
 */
export function getCurrentRole(): NormalizedRole | null {
  const user = getCurrentUser();
  const roleFromUser = normalizeRole(user?.role);

  if (roleFromUser) {
    return roleFromUser;
  }

  return getRoleFromToken(getToken());
}

/**
 * Check if user is authenticated.
 */
export function isAuthenticated(): boolean {
  return Boolean(getCurrentUser() && getToken());
}

/**
 * Check if current user has a specific normalized role.
 */
export function hasRole(role: NormalizedRole | NormalizedRole[]): boolean {
  const currentRole = getCurrentRole();
  if (!currentRole) return false;

  if (Array.isArray(role)) {
    return role.includes(currentRole);
  }

  return currentRole === role;
}

/**
 * Get Authorization header for API requests.
 */
export function getAuthHeader(): Record<string, string> {
  const token = getToken();

  if (!token) {
    return {};
  }

  return {
    Authorization: `Bearer ${token}`,
  };
}

/**
 * Logout current user.
 */
export function logout() {
  clearSession();
}

/**
 * Get user's email.
 */
export function getUserEmail(): string | null {
  const user = getCurrentUser();
  return user?.email || null;
}

/**
 * Get user's ID.
 */
export function getUserId(): string | null {
  const user = getCurrentUser();
  return user?.id || null;
}

/**
 * Get a display name for the current user.
 */
export function getCurrentUserDisplayName(): string {
  const user = getCurrentUser();

  if (!user) return "Guest";

  const possibleName =
    "name" in user && typeof user.name === "string"
      ? user.name
      : null;

  return possibleName || user.email || "User";
}