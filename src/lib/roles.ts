/**
 * Role management and normalization utilities.
 *
 * Product rule:
 * - Customers/users must never see internal admin/security/distributed-system UI.
 * - Admin/organizer users manage business operations only.
 * - Security/staff users see security, audit, verification, and monitoring only.
 * - System admins are the only users who can access Distributed Systems.
 */

export type UserRole =
  | "user"
  | "customer"
  | "admin"
  | "organizer"
  | "security"
  | "staff"
  | "system_admin"
  | "super_admin"
  | "gate_staff"
  | "security_staff"
  | "security_leader"
  | "regular_employee";

export type NormalizedRole =
  | "user"
  | "admin"
  | "organizer"
  | "security"
  | "staff"
  | "system_admin";

export interface NavigationItem {
  label: string;
  href: string;
  icon?: string;
}

const PUBLIC_ROUTES = new Set([
  "/",
  "/events",
  "/login",
  "/register",
]);

/**
 * Normalize role string to one of the roles used by the frontend.
 */
export function normalizeRole(role: unknown): NormalizedRole | null {
  if (!role || typeof role !== "string") return null;

  const normalized = role.toLowerCase().trim();

  const roleMap: Record<string, NormalizedRole> = {
    // Customer/user roles
    user: "user",
    customer: "user",
    regular_user: "user",
    normal_user: "user",

    // Admin/business roles
    admin: "admin",
    administrator: "admin",
    organizer: "organizer",
    event_organizer: "organizer",

    // Security/staff roles
    security: "security",
    security_staff: "security",
    security_leader: "system_admin",
    staff: "staff",
    gate_staff: "staff",
    regular_employee: "staff",

    // System admin roles
    system_admin: "system_admin",
    system_administrator: "system_admin",
    super_admin: "system_admin",
    super_administrator: "system_admin",
    sysadmin: "system_admin",
  };

  return roleMap[normalized] ?? null;
}

export function isUser(role: unknown): boolean {
  return normalizeRole(role) === "user";
}

export function isCustomer(role: unknown): boolean {
  return normalizeRole(role) === "user";
}

export function isAdmin(role: unknown): boolean {
  const normalized = normalizeRole(role);
  return normalized === "admin" || normalized === "organizer";
}

export function isOrganizer(role: unknown): boolean {
  return normalizeRole(role) === "organizer";
}

export function isSecurity(role: unknown): boolean {
  return normalizeRole(role) === "security";
}

export function isStaff(role: unknown): boolean {
  return normalizeRole(role) === "staff";
}

export function isSystemAdmin(role: unknown): boolean {
  return normalizeRole(role) === "system_admin";
}

/**
 * Default landing page after login.
 */
export function getDefaultRouteForRole(role: unknown): string {
  const normalized = normalizeRole(role);

  switch (normalized) {
    case "admin":
    case "organizer":
      return "/admin";

    case "security":
      return "/security";

    case "staff":
      return "/staff/events";

    case "system_admin":
      return "/distributed-systems";

    case "user":
    default:
      return "/events";
  }
}

/**
 * Navigation items by role.
 *
 * Keep this strict. Hiding links is not security by itself, but it prevents
 * normal users/admins from seeing irrelevant internal system areas.
 */
export function getNavigationForRole(role: unknown): NavigationItem[] {
  const normalized = normalizeRole(role);

  const baseNav: NavigationItem[] = [
    { label: "Home", href: "/" },
  ];

  const userNav: NavigationItem[] = [
    { label: "Events", href: "/events" },
    { label: "My Bookings", href: "/my-bookings" },
    { label: "My Tickets", href: "/tickets" },
    { label: "Notifications", href: "/notifications" },
    { label: "Profile", href: "/profile" },
  ];

  const adminNav: NavigationItem[] = [
    { label: "Admin Dashboard", href: "/admin" },
    { label: "Gate Assignments", href: "/admin/gate-assignments" },
    { label: "Profile", href: "/profile" },
  ];

  const securityNav: NavigationItem[] = [
    { label: "Security Dashboard", href: "/security" },
    { label: "Ticket Verification", href: "/security/tickets" },
    { label: "Monitoring", href: "/monitoring" },
    { label: "Notifications", href: "/notifications" },
    { label: "Profile", href: "/profile" },
  ];

  const staffNav: NavigationItem[] = [
    { label: "Staff Dashboard", href: "/staff" },
    { label: "My Gate Events", href: "/staff/events" },
    { label: "Gate Scanner", href: "/staff/scanner" },
    { label: "Profile", href: "/profile" },
  ];

  const systemAdminNav: NavigationItem[] = [
    { label: "Admin Dashboard", href: "/admin" },
    { label: "Security Dashboard", href: "/security" },
    { label: "Monitoring", href: "/monitoring" },
    { label: "Distributed Systems", href: "/distributed-systems" },
    { label: "Profile", href: "/profile" },
  ];

  switch (normalized) {
    case "user":
      return [...baseNav, ...userNav];

    case "admin":
    case "organizer":
      return [...baseNav, ...adminNav];

    case "security":
      return [...baseNav, ...securityNav];

    case "staff":
      return [...baseNav, ...staffNav];

    case "system_admin":
      return [...baseNav, ...systemAdminNav];

    default:
      return [...baseNav, { label: "Events", href: "/events" }];
  }
}

/**
 * Check if a role can access a route.
 */
export function canAccessRoute(role: unknown, path: string): boolean {
  const normalized = normalizeRole(role);
  const cleanPath = path.split("?")[0].replace(/\/$/, "") || "/";

  // Public routes and public event details.
  if (PUBLIC_ROUTES.has(cleanPath)) return true;
  if (cleanPath.startsWith("/events/")) return true;

  // Must be authenticated for everything else.
  if (!normalized) return false;

  // Customer/user account routes.
  if (
    cleanPath === "/my-bookings" ||
    cleanPath.startsWith("/my-bookings/") ||
    cleanPath === "/my-tickets" ||
    cleanPath.startsWith("/my-tickets/") ||
    cleanPath === "/tickets" ||
    cleanPath.startsWith("/tickets/") ||
    cleanPath === "/bookings" ||
    cleanPath.startsWith("/bookings/") ||
    cleanPath === "/notifications" ||
    cleanPath === "/profile"
  ) {
    return (
      normalized === "user" ||
      normalized === "admin" ||
      normalized === "organizer" ||
      normalized === "security" ||
      normalized === "system_admin"
    );
  }

  // Admin/business operations.
  if (cleanPath === "/admin" || cleanPath.startsWith("/admin/")) {
    return (
      normalized === "admin" ||
      normalized === "organizer" ||
      normalized === "system_admin"
    );
  }

  // Security operations.
  if (cleanPath === "/security" || cleanPath.startsWith("/security/")) {
    return (
      normalized === "security" ||
      normalized === "system_admin"
    );
  }

  // Distributed systems access is strictly system admin.
  if (
    cleanPath === "/distributed-systems" ||
    cleanPath.startsWith("/distributed-systems/")
  ) {
    return normalized === "system_admin";
  }

  // Staff operations for gate staff only (not security staff).
  if (cleanPath === "/staff" || cleanPath.startsWith("/staff/")) {
    return normalized === "staff" || normalized === "system_admin";
  }

  // Monitoring is security/system-admin only (not gate staff).
  if (cleanPath === "/monitoring" || cleanPath.startsWith("/monitoring/")) {
    return (
      normalized === "security" ||
      normalized === "system_admin"
    );
  }

  return false;
}
