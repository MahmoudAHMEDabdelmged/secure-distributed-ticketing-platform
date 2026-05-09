"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  ApiClientError,
  ApiEnvelope,
  apiRequest,
  extractData,
  getApiGatewayUrl,
  getStoredSession,
  storeSession,
  type AuthSession
} from "@/src/lib/api-client";
import { useTheme, type ThemeChoice } from "@/src/lib/theme";
import { APP_NAME } from "@/src/lib/branding";
import {
  normalizeRole,
  getDefaultRouteForRole,
  getNavigationForRole,
  canAccessRoute,
  type NavigationItem,
} from "@/src/lib/roles";

export type ViewName =
  | "home"
  | "events"
  | "event-detail"
  | "login"
  | "register"
  | "booking"
  | "payment"
  | "tickets"
  | "ticket-detail"
  | "notifications"
  | "admin"
  | "admin-gate"
  | "security"
  | "monitoring"
  | "monitoring-incident"
  | "staff"
  | "staff-events"
  | "staff-event-panel"
  | "staff-scanner";

type EventSection = {
  id: string;
  name: string;
  price_cents: number;
  currency: string;
  total_capacity?: number;
  available_capacity?: number;
};

type TicketEvent = {
  id: string;
  title: string;
  description?: string;
  category?: string;
  starts_at?: string;
  ends_at?: string;
  status?: string;
  image_url?: string;
  venue?: {
    id?: string;
    name?: string;
    city?: string;
    country?: string;
  } | null;
  sections?: EventSection[];
};

type Booking = {
  id: string;
  user_id: string;
  user_email?: string;
  event_id: string;
  section_id: string;
  event_title: string;
  section_name: string;
  quantity: number;
  total_price_cents: number;
  currency: string;
  status: string;
};

type Payment = {
  id: string;
  booking_id: string;
  status: "succeeded" | "failed" | "suspicious" | string;
  amount_cents: number;
  currency: string;
  is_suspicious?: boolean;
  suspicious_reason?: string;
  failure_reason?: string;
};

type Ticket = {
  id: string;
  booking_id?: string;
  user_id?: string;
  event_id?: string;
  event_title?: string;
  section_name?: string;
  ticket_number?: string;
  verification_url?: string;
  qr_code_data_url?: string;
  status?: string;
  issued_at?: string;
  used_at?: string | null;
};

type InAppNotification = {
  id: string;
  type: string;
  title: string;
  message: string;
  severity: "info" | "success" | "warning" | "critical";
  is_read: boolean;
  created_at: string;
  resource_type?: string | null;
  resource_id?: string | null;
};

type GateAssignment = {
  id: string;
  event_id: string;
  staff_user_id: string;
  code_hint?: string;
  code_active_from: string;
  code_expires_at: string;
  status: string;
  failed_attempts?: number;
  last_used_at?: string | null;
  revoked_at?: string | null;
};

type StaffEventAssignment = {
  event: TicketEvent;
  assignment: GateAssignment;
  code_status: string;
  locked: boolean;
  active_from: string;
  expires_at: string;
  seconds_until_active?: number;
};

type AuditLog = {
  id: string;
  event_type: string;
  service_name: string;
  severity: string;
  action?: string;
  resource_type?: string;
  resource_id?: string;
  is_suspicious?: boolean;
  suspicious_reason?: string;
  created_at: string;
};

type Incident = {
  id: string;
  service_name: string;
  incident_type: string;
  severity: string;
  status: string;
  summary?: string;
  created_at?: string;
  first_detected_at?: string;
  last_detected_at?: string;
};

// Using APP_NAME from branding.ts

function getRoleLabel(role: unknown) {
  const normalized = normalizeRole(role);

  const labels: Record<string, string> = {
    user: "User",
    admin: "Admin",
    organizer: "Organizer",
    security: "Security",
    system_admin: "System Admin",
  };

  return normalized ? labels[normalized] || "User" : "Guest";
}

function pathForView(view: ViewName, resourceId?: string) {
  const encodedResource = resourceId ? encodeURIComponent(resourceId) : "";

  const paths: Record<ViewName, string> = {
    home: "/",
    events: "/events",
    "event-detail": encodedResource ? `/events/${encodedResource}` : "/events",
    login: "/login",
    register: "/register",
    booking: "/booking",
    payment: "/payment",
    tickets: "/tickets",
    "ticket-detail": encodedResource ? `/tickets/${encodedResource}` : "/tickets",
    notifications: "/notifications",
    admin: "/admin",
    "admin-gate": "/admin/gate-assignments",
    security: "/security",
    monitoring: "/monitoring",
    "monitoring-incident": "/monitoring",
    staff: "/staff",
    "staff-events": "/staff/events",
    "staff-event-panel": encodedResource ? `/staff/events/${encodedResource}` : "/staff/events",
    "staff-scanner": "/staff/scanner",
  };

  return paths[view] || "/";
}

function formatDate(value?: string | null) {
  if (!value) {
    return "Not set";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

function formatMoney(amountCents?: number, currency = "EGP") {
  const amount = Number.isFinite(amountCents) ? Number(amountCents) / 100 : 0;
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency
  }).format(amount);
}

function getErrorMessage(error: unknown) {
  if (error instanceof ApiClientError) {
    return error.message;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "Something went wrong";
}

function statusTone(value?: string | boolean | null) {
  const status = String(value ?? "").toLowerCase();

  if (["healthy", "success", "succeeded", "valid", "active", "used", "resolved", "up", "approved"].includes(status)) {
    return "success";
  }

  if (["degraded", "warning", "pending", "assigned", "locked", "suspicious", "acknowledged"].includes(status)) {
    return "warning";
  }

  if (["down", "critical", "failed", "denied", "revoked", "expired", "cancelled", "rejected"].includes(status)) {
    return "critical";
  }

  return "info";
}

function getQrTokenFromInput(value: string) {
  const trimmed = value.trim();

  if (!trimmed) {
    return "";
  }

  try {
    const url = new URL(trimmed);
    return url.pathname.split("/").filter(Boolean).pop() || trimmed;
  } catch {
    return trimmed.split("/").filter(Boolean).pop() || trimmed;
  }
}

function safeArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

export function AppExperience({
  initialView,
  resourceId
}: {
  initialView: ViewName;
  resourceId?: string;
}) {
  const router = useRouter();
  const { theme, resolvedTheme, setTheme } = useTheme();
  const [hasHydrated, setHasHydrated] = useState(false);
  const [session, setSession] = useState<AuthSession>({
    token: null,
    user: null,
  });
  const [events, setEvents] = useState<TicketEvent[]>([]);
  const [selectedEvent, setSelectedEvent] = useState<TicketEvent | null>(null);
  const [selectedSectionId, setSelectedSectionId] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [currentBooking, setCurrentBooking] = useState<Booking | null>(null);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [notifications, setNotifications] = useState<InAppNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [staffEvents, setStaffEvents] = useState<StaffEventAssignment[]>([]);
  const [gateAssignments, setGateAssignments] = useState<GateAssignment[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [monitoringSummary, setMonitoringSummary] = useState<Record<string, unknown> | null>(null);
  const [topology, setTopology] = useState<Record<string, unknown> | null>(null);
  const [distributedModel, setDistributedModel] = useState<Record<string, unknown> | null>(null);
  const [rsmEvents, setRsmEvents] = useState<Record<string, unknown>[]>([]);
  const [toast, setToast] = useState<{ tone: "success" | "warning" | "critical" | "info"; message: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [manualQrToken, setManualQrToken] = useState("");
  const [manualGateCode, setManualGateCode] = useState("");
  const [paymentCardNumber, setPaymentCardNumber] = useState("");
  const [activeGateCode, setActiveGateCode] = useState("");
  const [scannerResult, setScannerResult] = useState<Record<string, unknown> | null>(null);
  const [showNotificationsDropdown, setShowNotificationsDropdown] = useState(false);
  const [registerPassword, setRegisterPassword] = useState("");
  const [registerConfirmPassword, setRegisterConfirmPassword] = useState("");
  const [registerAttempted, setRegisterAttempted] = useState(false);

  const user = hasHydrated ? session.user : null;
  const userRole = user ? normalizeRole(user.role) : null;

  const registerPasswordRules = useMemo(
    () => [
      {
        id: "length",
        label: "At least 8 characters",
        valid: registerPassword.length >= 8,
      },
      {
        id: "uppercase",
        label: "At least one uppercase letter",
        valid: /[A-Z]/.test(registerPassword),
      },
      {
        id: "lowercase",
        label: "At least one lowercase letter",
        valid: /[a-z]/.test(registerPassword),
      },
      {
        id: "number",
        label: "At least one number",
        valid: /\d/.test(registerPassword),
      },
      {
        id: "symbol",
        label: "At least one symbol",
        valid: /[^A-Za-z0-9]/.test(registerPassword),
      },
      {
        id: "match",
        label: "Password and confirmation must match exactly",
        valid:
          registerPassword.length > 0 &&
          registerConfirmPassword.length > 0 &&
          registerPassword === registerConfirmPassword,
      },
    ],
    [registerPassword, registerConfirmPassword],
  );

  const isRegisterPasswordValid = registerPasswordRules.every((rule) => rule.valid);
  
  // Role-based checks
  const isAdmin = userRole === "admin" || userRole === "organizer" || userRole === "system_admin";
  const isSecurity = userRole === "security" || userRole === "system_admin";
  const currentPath = pathForView(initialView, resourceId);
  const canViewCurrentPage = hasHydrated
    ? canAccessRoute(userRole, currentPath)
    : true;

  const selectedTicket = useMemo(() => {
    if (!resourceId) {
      return tickets[0] || null;
    }

    return tickets.find((ticket) => ticket.id === resourceId) || tickets[0] || null;
  }, [resourceId, tickets]);

  const selectedStaffEvent = useMemo(() => {
    if (!resourceId) {
      return staffEvents[0] || null;
    }

    return staffEvents.find((item) => item.event.id === resourceId) || staffEvents[0] || null;
  }, [resourceId, staffEvents]);

  const notify = useCallback((message: string, tone: "success" | "warning" | "critical" | "info" = "info") => {
    setToast({ message, tone });
    window.setTimeout(() => setToast(null), 5000);
  }, []);

  const loadEvents = useCallback(async (includeAll = false) => {
    const payload = await apiRequest<ApiEnvelope<TicketEvent[]>>("/events", {
      query: includeAll ? { status: "all", limit: 100 } : { limit: 100 }
    });
    const loadedEvents = safeArray<TicketEvent>(extractData(payload));
    setEvents(loadedEvents);

    if (resourceId && initialView === "event-detail") {
      const matchingEvent = loadedEvents.find((event) => event.id === resourceId);
      setSelectedEvent(matchingEvent || null);
      setSelectedSectionId(matchingEvent?.sections?.[0]?.id || "");
    } else if (!selectedEvent && loadedEvents[0]) {
      setSelectedEvent(loadedEvents[0]);
      setSelectedSectionId(loadedEvents[0].sections?.[0]?.id || "");
    }
  }, [initialView, resourceId, selectedEvent]);

  const loadTickets = useCallback(async (userId?: string) => {
    if (!userId) {
      setTickets([]);
      return;
    }

    const payload = await apiRequest<ApiEnvelope<Ticket[]>>(`/users/${encodeURIComponent(userId)}/tickets`);
    setTickets(safeArray<Ticket>(extractData(payload)));
  }, []);

  const loadNotifications = useCallback(async (currentUser?: AuthSession["user"]) => {
    if (!currentUser) {
      setNotifications([]);
      setUnreadCount(0);
      return;
    }

    const [feedPayload, countPayload] = await Promise.all([
      apiRequest<ApiEnvelope<InAppNotification[]>>("/notifications/in-app/me", {
        query: {
          user_id: currentUser.id,
          role: currentUser.role,
          limit: 50
        }
      }),
      apiRequest<{ unread_count: number }>("/notifications/in-app/unread-count", {
        query: {
          user_id: currentUser.id,
          role: currentUser.role
        }
      })
    ]);

    setNotifications(safeArray<InAppNotification>(extractData(feedPayload)));
    setUnreadCount(Number(countPayload.unread_count || 0));
  }, []);

  const loadStaffEvents = useCallback(async (staffUserId?: string) => {
    if (!staffUserId) {
      setStaffEvents([]);
      return;
    }

    const payload = await apiRequest<ApiEnvelope<StaffEventAssignment[]>>("/events/gate-staff/my-events", {
      query: {
        staff_user_id: staffUserId
      }
    });
    setStaffEvents(safeArray<StaffEventAssignment>(extractData(payload)));
  }, []);

  const loadMonitoring = useCallback(async () => {
    const [summary, incidentPayload, topologyPayload, modelPayload, rsmPayload] = await Promise.all([
      apiRequest<Record<string, unknown>>("/monitoring/summary"),
      apiRequest<ApiEnvelope<Incident[]>>("/monitoring/incidents", { query: { limit: 50 } }),
      apiRequest<Record<string, unknown>>("/monitoring/topology"),
      apiRequest<Record<string, unknown>>("/monitoring/distributed-model"),
      apiRequest<ApiEnvelope<Record<string, unknown>[]>>("/monitoring/rsm/events", { query: { limit: 30 } })
    ]);

    setMonitoringSummary(summary);
    setIncidents(safeArray<Incident>(extractData(incidentPayload)));
    setTopology(topologyPayload);
    setDistributedModel(modelPayload);
    setRsmEvents(safeArray<Record<string, unknown>>(extractData(rsmPayload)));
  }, []);

  const loadSecurity = useCallback(async () => {
    const payload = await apiRequest<ApiEnvelope<AuditLog[]>>("/audit/logs", {
      query: {
        limit: 80
      }
    });
    setAuditLogs(safeArray<AuditLog>(extractData(payload)));
  }, []);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      const storedSession = getStoredSession();
      setSession(storedSession);
      setHasHydrated(true);

      const shouldLoadEvents = [
        "home",
        "events",
        "event-detail",
        "admin",
        "admin-gate",
        "booking",
      ].includes(initialView);

      if (shouldLoadEvents) {
        void loadEvents(initialView === "admin" || initialView === "admin-gate").catch((error) =>
          notify(getErrorMessage(error), "warning"),
        );
      }

      if (storedSession.user?.id) {
        void loadTickets(storedSession.user.id).catch((error) =>
          notify(getErrorMessage(error), "warning"),
        );
        void loadNotifications(storedSession.user).catch((error) =>
          notify(getErrorMessage(error), "warning"),
        );
      }

      if (storedSession.user?.role === "gate_staff") {
        void loadStaffEvents(storedSession.user.id).catch((error) =>
          notify(getErrorMessage(error), "warning"),
        );
      }
    }, 0);

    return () => window.clearTimeout(timeout);
  }, [initialView, loadEvents, loadNotifications, loadStaffEvents, loadTickets, notify]);

  // Security and monitoring dashboards are intentionally manual-only.
  // They do not run checks or load operational data automatically on page open.
  // Use the Refresh buttons inside each dashboard when needed.

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);

    try {
      const form = new FormData(event.currentTarget);
      const payload = await apiRequest<{ token: string; user: AuthSession["user"] }>("/auth/login", {
        method: "POST",
        body: {
          email: String(form.get("email") || ""),
          password: String(form.get("password") || "")
        }
      });
      const nextSession = {
        token: payload.token,
        user: payload.user
      };

      storeSession(nextSession);
      setSession(nextSession);
      
      // Determine role and redirect accordingly
      const userRole = payload.user ? normalizeRole(payload.user.role) : null;
      const redirectUrl = getDefaultRouteForRole(userRole);
      
      await Promise.all([
        loadTickets(payload.user?.id),
        loadNotifications(payload.user),
        loadStaffEvents(payload.user?.role === "gate_staff" ? payload.user.id : undefined)
      ]);
      notify("Login successful", "success");
      
      // Redirect to role-appropriate page
      router.push(redirectUrl);
    } catch (error) {
      notify(getErrorMessage(error), "critical");
    } finally {
      setLoading(false);
    }
  }

  async function handleRegister(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setRegisterAttempted(true);

    const form = new FormData(event.currentTarget);
    const fullName = String(form.get("full_name") || "").trim();
    const email = String(form.get("email") || "").trim().toLowerCase();
    const phone = String(form.get("phone") || "").trim();
    const password = String(form.get("password") || "");
    const confirmPassword = String(form.get("confirm_password") || "");

    if (!fullName || !email || !phone) {
      notify("Please complete your full name, email, and phone number.", "critical");
      return;
    }

    if (password !== confirmPassword) {
      notify("Password and confirmation password must match exactly.", "critical");
      return;
    }

    if (!isRegisterPasswordValid) {
      notify("Please complete all password requirements before creating your account.", "critical");
      return;
    }

    setLoading(true);

    try {
      await apiRequest("/auth/register", {
        method: "POST",
        body: {
          name: fullName,
          full_name: fullName,
          email,
          phone,
          phone_number: phone,
          password,
          role: "user",
        }
      });

      notify("Registration successful. You can log in now.", "success");
      setRegisterPassword("");
      setRegisterConfirmPassword("");
      setRegisterAttempted(false);
      router.push("/login");
    } catch (error) {
      notify(getErrorMessage(error), "critical");
    } finally {
      setLoading(false);
    }
  }

  function logout() {
    const nextSession = {
      token: null,
      user: null
    };
    storeSession(nextSession);
    setSession(nextSession);
    setTickets([]);
    setNotifications([]);
    setUnreadCount(0);
    setStaffEvents([]);
    notify("Signed out", "info");
  }

  async function createBooking() {
    if (!user) {
      notify("Log in before creating a booking.", "warning");
      return;
    }

    if (!selectedEvent || !selectedSectionId) {
      notify("Select an event section first.", "warning");
      return;
    }

    setLoading(true);

    try {
      const payload = await apiRequest<ApiEnvelope<Booking>>("/bookings", {
        method: "POST",
        body: {
          user_id: user.id,
          user_email: user.email,
          event_id: selectedEvent.id,
          section_id: selectedSectionId,
          quantity
        }
      });
      const booking = extractData(payload);
      setCurrentBooking(booking);
      window.localStorage.setItem("ezbook_booking", JSON.stringify(booking));
      window.localStorage.removeItem("secure_tickets_booking");
      notify("Booking created. Continue to payment.", "success");
    } catch (error) {
      notify(getErrorMessage(error), "critical");
    } finally {
      setLoading(false);
    }
  }

  async function simulatePayment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!user) {
      notify("Log in before paying.", "warning");
      return;
    }

    const booking = currentBooking || (() => {
      try {
        return JSON.parse(
          window.localStorage.getItem("ezbook_booking") ||
          window.localStorage.getItem("secure_tickets_booking") ||
          "null"
        ) as Booking | null;
      } catch {
        return null;
      }
    })();

    if (!booking) {
      notify("Create a booking first.", "warning");
      return;
    }

    setLoading(true);

    try {
      const form = new FormData(event.currentTarget);
      const paymentPayload = await apiRequest<ApiEnvelope<Payment>>("/payments", {
        method: "POST",
        body: {
          booking_id: booking.id,
          user_id: user.id,
          user_email: user.email,
          amount_cents: booking.total_price_cents,
          currency: booking.currency,
          payment_method: "card",
          card_number: String(form.get("card_number") || "")
        }
      });
      const payment = extractData(paymentPayload);
      setPayments((current) => [payment, ...current]);

      if (payment.status === "succeeded") {
        const ticketPayload = await apiRequest<ApiEnvelope<{ tickets: Ticket[] }>>("/tickets/issue", {
          method: "POST",
          body: {
            booking_id: booking.id
          }
        });
        const issued = extractData(ticketPayload);
        setTickets(issued.tickets || []);
        notify("Payment succeeded and tickets were issued.", "success");
      } else if (payment.status === "suspicious") {
        notify("Payment was marked suspicious. Security review notification was created by the backend flow when configured.", "warning");
      } else {
        notify(payment.failure_reason || "Payment failed. Please check the payment details and try again.", "critical");
      }
    } catch (error) {
      notify(getErrorMessage(error), "critical");
    } finally {
      setLoading(false);
    }
  }

  async function markNotificationRead(notificationId: string) {
    await apiRequest(`/notifications/in-app/${encodeURIComponent(notificationId)}/read`, {
      method: "POST"
    });
    await loadNotifications(user);
  }

  async function markAllNotificationsRead() {
    if (!user) {
      return;
    }

    await apiRequest("/notifications/in-app/read-all", {
      method: "POST",
      body: {
        user_id: user.id,
        role: user.role
      }
    });
    await loadNotifications(user);
  }

  async function assignGateStaff(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!user) {
      notify("Log in as an admin or security staff member first.", "warning");
      return;
    }

    const form = new FormData(event.currentTarget);
    const eventId = String(form.get("event_id") || "");

    setLoading(true);

    try {
      const payload = await apiRequest<ApiEnvelope<GateAssignment>>(`/events/${encodeURIComponent(eventId)}/gate-staff/assignments`, {
        method: "POST",
        body: {
          staff_user_id: String(form.get("staff_user_id") || ""),
          assigned_by_user_id: user.id,
          code_active_from: String(form.get("code_active_from") || "") || undefined,
          code_expires_at: String(form.get("code_expires_at") || "") || undefined
        }
      });
      const assignment = extractData(payload);
      setGateAssignments((current) => [assignment, ...current]);
      notify("Gate staff assigned. Admin response contains only code hint and metadata.", "success");
    } catch (error) {
      notify(getErrorMessage(error), "critical");
    } finally {
      setLoading(false);
    }
  }

  async function loadGateAssignments(eventId: string) {
    const payload = await apiRequest<ApiEnvelope<GateAssignment[]>>(`/events/${encodeURIComponent(eventId)}/gate-staff/assignments`);
    setGateAssignments(safeArray<GateAssignment>(extractData(payload)));
  }

  async function loadMyGateCode(eventId: string) {
    if (!user) {
      notify("Log in as gate staff first.", "warning");
      return;
    }

    try {
      const payload = await apiRequest<Record<string, unknown>>(`/events/${encodeURIComponent(eventId)}/gate-staff/my-code`, {
        query: {
          staff_user_id: user.id
        }
      });

      if (payload.status === "active" && typeof payload.gate_code === "string") {
        setActiveGateCode(payload.gate_code);
        setManualGateCode(payload.gate_code);
        notify("Gate code is active for your assignment.", "success");
      } else {
        setActiveGateCode("");
        notify(String(payload.reason || "Gate code is not active yet."), "warning");
      }
    } catch (error) {
      notify(getErrorMessage(error), "critical");
    }
  }

  async function verifyAtGate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!user) {
      notify("Log in as gate staff first.", "warning");
      return;
    }

    const form = new FormData(event.currentTarget);
    const eventId = String(form.get("event_id") || selectedStaffEvent?.event.id || "");
    const gateCode = String(form.get("gate_code") || manualGateCode || "");
    const qrToken = getQrTokenFromInput(String(form.get("qr_token") || manualQrToken || ""));

    setLoading(true);

    try {
      const payload = await apiRequest<Record<string, unknown>>("/tickets/gate/verify-use", {
        method: "POST",
        body: {
          event_id: eventId,
          staff_user_id: user.id,
          gate_code: gateCode,
          qr_token: qrToken
        }
      });
      setScannerResult(payload);
      notify("Ticket verified and marked used.", "success");
    } catch (error) {
      setScannerResult({
        status: "denied",
        reason: getErrorMessage(error)
      });
      notify(getErrorMessage(error), "critical");
    } finally {
      setLoading(false);
    }
  }

  async function acknowledgeIncident(incidentId: string) {
    await apiRequest(`/monitoring/incidents/${encodeURIComponent(incidentId)}/acknowledge`, {
      method: "POST"
    });
    await loadMonitoring();
    notify("Incident acknowledged", "success");
  }

  async function resolveIncident(incidentId: string) {
    await apiRequest(`/monitoring/incidents/${encodeURIComponent(incidentId)}/resolve`, {
      method: "POST"
    });
    await loadMonitoring();
    notify("Incident resolved", "success");
  }

  if (!hasHydrated) {
    return renderLoadingShell();
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Link className="brand" href="/">
          <span className="brand-mark">EZ</span>
          <span>
            <strong>{APP_NAME}</strong>
            <small>Secure Ticketing</small>
          </span>
        </Link>

        <nav className="nav-list" aria-label="Primary navigation">
          {getNavigationForRole(userRole).map((item: NavigationItem) => (
            <Link key={item.href} href={item.href}>
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="sidebar-footer">
          <label className="field-label" htmlFor="theme-select">Theme</label>
          <select
            id="theme-select"
            value={theme}
            onChange={(event) => setTheme(event.target.value as ThemeChoice)}
          >
            <option value="light">Light</option>
            <option value="dark">Dark</option>
            <option value="system">System</option>
          </select>
          <small>Resolved: {resolvedTheme}</small>
        </div>
      </aside>

      <main className="main-panel">
        <header className="topbar">
          <div>
            <p className="eyebrow">{APP_NAME}</p>
            <h1>{titleForView(initialView)}</h1>
          </div>
          <div className="topbar-actions">
            <span className={`api-status ${getApiGatewayUrl() ? "ok" : "missing"}`}>
              {getApiGatewayUrl() ? "Gateway OK" : "Gateway missing"}
            </span>
            
            {/* Notifications dropdown - top right */}
            <div className="notification-dropdown-wrapper">
              <button
                className="bell-button"
                onClick={() => setShowNotificationsDropdown(!showNotificationsDropdown)}
                title="Notifications"
                aria-label="Notifications"
              >
                <span className="bell-icon">🔔</span>
                {unreadCount > 0 ? <span className="badge">{unreadCount}</span> : null}
              </button>
              
              {showNotificationsDropdown && (
                <div className="notification-dropdown">
                  <div className="dropdown-header">
                    <h3>Notifications</h3>
                    <button
                      type="button"
                      className="close-button"
                      onClick={() => setShowNotificationsDropdown(false)}
                    >
                      ×
                    </button>
                  </div>
                  <div className="dropdown-content">
                    {notifications.length > 0 ? (
                      notifications.slice(0, 5).map((notif) => (
                        <div key={notif.id} className="notification-item-compact">
                          <span className="severity-badge" data-severity={notif.severity}>
                            {notif.severity}
                          </span>
                          <div>
                            <p>{notif.title}</p>
                            <small>{notif.message}</small>
                          </div>
                        </div>
                      ))
                    ) : (
                      <p className="empty-message">No notifications</p>
                    )}
                  </div>
                  <div className="dropdown-footer">
                    <Link href="/notifications">View all notifications</Link>
                  </div>
                </div>
              )}
            </div>
            
            {user ? (
              <div className="user-chip">
                <span>{user.email}</span>
                <strong>{getRoleLabel(user.role)}</strong>
                <button type="button" onClick={logout}>Logout</button>
              </div>
            ) : (
              <div className="auth-links">
                <Link href="/login">Login</Link>
                <Link href="/register">Register</Link>
              </div>
            )}
          </div>
        </header>

        {toast ? <div className={`toast ${toast.tone}`}>{toast.message}</div> : null}

        {renderView()}
      </main>
    </div>
  );

  function renderLoadingShell() {
    return (
      <div className="app-shell">
        <aside className="sidebar">
          <Link className="brand" href="/">
            <span className="brand-mark">EZ</span>
            <span>
              <strong>{APP_NAME}</strong>
              <small>Book it EZ</small>
            </span>
          </Link>
        </aside>
        <main className="main-panel">
          <section className="empty-state">
            <p className="eyebrow">Loading</p>
            <h2>Preparing your EZbook experience</h2>
            <p>Please wait while we load your session and dashboard.</p>
          </section>
        </main>
      </div>
    );
  }

  function renderAccessDenied() {
    const targetRoute = user ? getDefaultRouteForRole(userRole) : "/login";

    return (
      <section className="large-panel access-denied-panel">
        <p className="eyebrow">{APP_NAME}</p>
        <h2>Access denied</h2>
        <p>
          {user
            ? "You do not have permission to view this page."
            : "Please log in to continue."}
        </p>
        <Link className="primary-button" href={targetRoute}>
          {user ? "Go to my dashboard" : "Go to login"}
        </Link>
      </section>
    );
  }

  function renderView() {
    if (!canViewCurrentPage) {
      return renderAccessDenied();
    }

    switch (initialView) {
      case "events":
        return renderEventsList();
      case "event-detail":
        return renderEventDetail(selectedEvent);
      case "login":
        return renderLogin();
      case "register":
        return renderRegister();
      case "booking":
        return renderBooking();
      case "payment":
        return renderPayment();
      case "tickets":
        return renderTickets();
      case "ticket-detail":
        return renderTicketDetail(selectedTicket);
      case "notifications":
        return renderNotifications();
      case "admin":
        return renderAdmin();
      case "admin-gate":
        return renderAdminGate();
      case "security":
        return renderSecurity();
      case "monitoring":
      case "monitoring-incident":
        return renderMonitoring();
      case "staff":
        return renderStaff();
      case "staff-events":
      case "staff-event-panel":
        return renderStaffEvents();
      case "staff-scanner":
        return renderScanner();
      default:
        return renderHome();
    }
  }

  function renderHome() {
    return (
      <section className="hero-section">
        <div className="hero-copy">
          <p className="eyebrow">{APP_NAME}</p>
          <h2>Secure Event Ticketing Made Simple</h2>
          <p>
            Book tickets for your favorite events, manage your bookings, and enjoy seamless access control.
            All powered by secure, distributed infrastructure.
          </p>
          <div className="button-row">
            {!user ? (
              <>
                <Link className="primary-button" href="/events">Browse Events</Link>
                <Link className="secondary-button" href="/login">Sign In</Link>
              </>
            ) : (
              <>
                <Link className="primary-button" href="/events">Browse Events</Link>
                <Link className="secondary-button" href="/booking">My Bookings</Link>
              </>
            )}
          </div>
        </div>
        <div className="hero-visual" aria-hidden="true">
          <div className="ticket-visual">
            <span>{APP_NAME}</span>
            <strong>Secure Ticketing</strong>
            <div className="qr-grid">
              {Array.from({ length: 25 }).map((_, index) => (
                <i key={index} className={index % 3 === 0 || index % 7 === 0 ? "on" : ""} />
              ))}
            </div>
          </div>
        </div>
      </section>
    );
  }

  function renderEventsList() {
    return (
      <section className="content-stack">
        <div className="section-header">
          <div>
            <p className="eyebrow">Public flow</p>
            <h2>Events</h2>
          </div>
          <button type="button" onClick={() => void loadEvents(false)}>Refresh</button>
        </div>
        <div className="event-grid">
          {events.map((event) => (
            <article className="event-card" key={event.id}>
              <div className="event-image">
                <span>{event.category || "event"}</span>
              </div>
              <div>
                <p className="eyebrow">{event.venue?.city || "Venue pending"}</p>
                <h3>{event.title}</h3>
                <p>{event.description || "Secure ticketing event."}</p>
              </div>
              <div className="card-footer">
                <span>{formatDate(event.starts_at)}</span>
                <Link href={`/events/${event.id}`}>Details</Link>
              </div>
            </article>
          ))}
        </div>
      </section>
    );
  }

  function renderEventDetail(event: TicketEvent | null) {
    if (!event) {
      return <EmptyState title="Event not loaded" message="Refresh the events list or open a valid event route." />;
    }

    return (
      <section className="content-stack">
        <div className="detail-layout">
          <article className="large-panel">
            <p className="eyebrow">{event.category || "event"}</p>
            <h2>{event.title}</h2>
            <p>{event.description || "No description has been provided for this event yet."}</p>
            <dl className="detail-grid">
              <div><dt>Starts</dt><dd>{formatDate(event.starts_at)}</dd></div>
              <div><dt>Ends</dt><dd>{formatDate(event.ends_at)}</dd></div>
              <div><dt>Venue</dt><dd>{event.venue?.name || "TBA"}</dd></div>
              <div><dt>Status</dt><dd><StatusBadge value={event.status || "published"} /></dd></div>
            </dl>
          </article>
          <article className="panel">
            <h3>Book seats</h3>
            <label className="field-label" htmlFor="section-select">Section</label>
            <select
              id="section-select"
              value={selectedSectionId}
              onChange={(input) => setSelectedSectionId(input.target.value)}
            >
              {(event.sections || []).map((section) => (
                <option key={section.id} value={section.id}>
                  {section.name} - {formatMoney(section.price_cents, section.currency)}
                </option>
              ))}
            </select>
            <label className="field-label" htmlFor="quantity-input">Quantity</label>
            <input
              id="quantity-input"
              type="number"
              min={1}
              value={quantity}
              onChange={(input) => setQuantity(Math.max(1, Number(input.target.value)))}
            />
            <button type="button" className="primary-button" disabled={loading} onClick={() => void createBooking()}>
              Create booking
            </button>
            {currentBooking ? (
              <Link className="secondary-button" href="/payment">Continue payment</Link>
            ) : null}
          </article>
        </div>
      </section>
    );
  }

  function renderBooking() {
    return (
      <section className="content-stack">
        <div className="section-header">
          <div>
            <p className="eyebrow">Booking flow</p>
            <h2>Create booking</h2>
          </div>
          <Link href="/events">Choose event</Link>
        </div>
        {selectedEvent ? renderEventDetail(selectedEvent) : <EmptyState title="No event selected" message="Open an event details page first." />}
      </section>
    );
  }

  function renderPayment() {
    const booking = currentBooking;

    return (
      <section className="content-stack">
        <div className="detail-layout">
          <article className="panel">
            <p className="eyebrow">Secure payment</p>
            <h2>{booking ? booking.event_title : "No booking selected"}</h2>
            <p>
              Submit a payment for the selected booking. Test scenarios are controlled from the System Admin dashboard only.
            </p>
            {booking ? (
              <dl className="detail-grid">
                <div><dt>Section</dt><dd>{booking.section_name}</dd></div>
                <div><dt>Quantity</dt><dd>{booking.quantity}</dd></div>
                <div><dt>Total</dt><dd>{formatMoney(booking.total_price_cents, booking.currency)}</dd></div>
                <div><dt>Status</dt><dd><StatusBadge value={booking.status} /></dd></div>
              </dl>
            ) : null}
          </article>
          <form className="panel form-stack" onSubmit={(event) => void simulatePayment(event)}>
            <h3>Card details</h3>
            <input
              name="card_number"
              value={paymentCardNumber}
              onChange={(input) => setPaymentCardNumber(input.target.value)}
              aria-label="Card number"
              placeholder="Enter card number"
            />
            <button className="primary-button" disabled={loading || !booking} type="submit">Submit payment</button>
          </form>
        </div>
        <DataTable
          title="Recent payments"
          rows={payments}
          columns={["id", "status", "amount_cents", "currency", "is_suspicious"]}
        />
      </section>
    );
  }

  function renderTickets() {
    return (
      <section className="content-stack">
        <div className="section-header">
          <div>
            <p className="eyebrow">User tickets</p>
            <h2>My Tickets</h2>
          </div>
          <button type="button" onClick={() => void loadTickets(user?.id)}>Refresh</button>
        </div>
        {tickets.length === 0 ? (
          <EmptyState title="No tickets yet" message="Complete a booking and successful payment to issue tickets." />
        ) : (
          <div className="ticket-list">
            {tickets.map((ticket) => (
              <article className="ticket-row" key={ticket.id}>
                <div>
                  <h3>{ticket.event_title || "Event"}</h3>
                  <p>{ticket.ticket_number || ticket.id}</p>
                </div>
                <StatusBadge value={ticket.status || "valid"} />
                <Link href={`/tickets/${ticket.id}`}>Open QR</Link>
              </article>
            ))}
          </div>
        )}
      </section>
    );
  }

  function renderTicketDetail(ticket: Ticket | null) {
    if (!ticket) {
      return <EmptyState title="Ticket not found" message="Tickets appear after successful payment and issuing." />;
    }

    return (
      <section className="detail-layout">
        <article className="large-panel">
          <p className="eyebrow">Ticket QR</p>
          <h2>{ticket.event_title || "Ticket"}</h2>
          <p>{ticket.section_name || "Section"} Â· {ticket.ticket_number || ticket.id}</p>
          <StatusBadge value={ticket.status || "valid"} />
          <div className="qr-ticket-box">
            {ticket.qr_code_data_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={ticket.qr_code_data_url} alt="Ticket QR code" />
            ) : (
              <div className="qr-grid large">
                {Array.from({ length: 49 }).map((_, index) => (
                  <i key={index} className={index % 2 === 0 || index % 5 === 0 ? "on" : ""} />
                ))}
              </div>
            )}
          </div>
        </article>
        <article className="panel">
          <h3>Verification URL</h3>
          <p className="breakable">{ticket.verification_url || "Issued ticket did not include a verification URL."}</p>
        </article>
      </section>
    );
  }

  function renderLogin() {
    return (
      <form className="auth-panel" onSubmit={(event) => void handleLogin(event)}>
        <p className="eyebrow">{APP_NAME}</p>
        <h2>Sign In</h2>
        <p style={{ color: "var(--muted)", fontSize: "0.9rem" }}>Sign in to your {APP_NAME} account</p>
        <input
          name="email"
          type="email"
          placeholder="Email address"
          required
          disabled={loading}
        />
        <input
          name="password"
          type="password"
          placeholder="Password"
          required
          disabled={loading}
        />
        <button className="primary-button" disabled={loading} type="submit">
          {loading ? "Signing in..." : "Sign In"}
        </button>
        <p style={{ marginTop: "16px", textAlign: "center", fontSize: "0.9rem" }}>
          Don&apos;t have an account?{" "}
          <Link href="/register" style={{ color: "var(--primary)", fontWeight: "600" }}>
            Create one
          </Link>
        </p>
      </form>
    );
  }

  function renderRegister() {
    return (
      <form className="auth-panel" onSubmit={(event) => void handleRegister(event)}>
        <p className="eyebrow">{APP_NAME}</p>
        <h2>Create Account</h2>
        <p style={{ color: "var(--muted)", fontSize: "0.9rem" }}>
          Create your EZbook account to book events and manage your tickets.
        </p>

        <label className="field-label" htmlFor="register-full-name">
          Full name
        </label>
        <input
          id="register-full-name"
          name="full_name"
          type="text"
          placeholder="Full name"
          autoComplete="name"
          required
          disabled={loading}
        />

        <label className="field-label" htmlFor="register-email">
          Email address
        </label>
        <input
          id="register-email"
          name="email"
          type="email"
          placeholder="Email address"
          autoComplete="email"
          required
          disabled={loading}
        />

        <label className="field-label" htmlFor="register-phone">
          Phone number
        </label>
        <input
          id="register-phone"
          name="phone"
          type="tel"
          placeholder="Phone number"
          autoComplete="tel"
          required
          disabled={loading}
        />

        <label className="field-label" htmlFor="register-password">
          Password
        </label>
        <input
          id="register-password"
          name="password"
          type="password"
          placeholder="Create a strong password"
          autoComplete="new-password"
          required
          value={registerPassword}
          onChange={(event) => setRegisterPassword(event.target.value)}
          aria-describedby="password-rules"
          disabled={loading}
        />

        <div id="password-rules" className="password-rules">
          <p>Password must include:</p>
          <ul>
            {registerPasswordRules.map((rule) => {
              const showError = registerAttempted && !rule.valid;

              return (
                <li
                  key={rule.id}
                  className={[
                    "password-rule",
                    rule.valid ? "valid" : "",
                    showError ? "invalid" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                >
                  <span aria-hidden="true">{rule.valid ? "âœ“" : "â€¢"}</span>
                  {rule.label}
                </li>
              );
            })}
          </ul>
        </div>

        <label className="field-label" htmlFor="register-confirm-password">
          Confirm password
        </label>
        <input
          id="register-confirm-password"
          name="confirm_password"
          type="password"
          placeholder="Re-enter the same password"
          autoComplete="new-password"
          required
          value={registerConfirmPassword}
          onChange={(event) => setRegisterConfirmPassword(event.target.value)}
          disabled={loading}
        />

        <button className="primary-button" disabled={loading} type="submit">
          {loading ? "Creating account..." : "Create Account"}
        </button>
        <p style={{ marginTop: "16px", textAlign: "center", fontSize: "0.9rem" }}>
          Already have an account?{" "}
          <Link href="/login" style={{ color: "var(--primary)", fontWeight: "600" }}>
            Sign in
          </Link>
        </p>
      </form>
    );
  }

  function renderNotifications() {
    return (
      <section className="content-stack">
        <div className="section-header">
          <div>
            <p className="eyebrow">In-app center</p>
            <h2>Notifications</h2>
          </div>
          <div className="button-row">
            <button type="button" onClick={() => void loadNotifications(user)}>Refresh</button>
            <button type="button" onClick={() => void markAllNotificationsRead()}>Mark all read</button>
          </div>
        </div>
        <div className="notification-list">
          {notifications.map((notification) => (
            <article className={`notification-item ${notification.is_read ? "read" : "unread"}`} key={notification.id}>
              <StatusBadge value={notification.severity} />
              <div>
                <h3>{notification.title}</h3>
                <p>{notification.message}</p>
                <small>{notification.type} Â· {formatDate(notification.created_at)}</small>
              </div>
              {!notification.is_read ? (
                <button type="button" onClick={() => void markNotificationRead(notification.id)}>Mark read</button>
              ) : null}
            </article>
          ))}
        </div>
      </section>
    );
  }

  function renderAdmin() {
    return (
      <section className="content-stack">
        <KpiGrid
          items={[
            ["Events", events.length],
            ["Tickets", tickets.length],
            ["Gate assignments", gateAssignments.length],
            ["Staff mode", isAdmin ? "enabled" : "login required"]
          ]}
        />
        <div className="section-header">
          <div>
            <p className="eyebrow">Organizer dashboard</p>
            <h2>Manage events and sections</h2>
          </div>
          <Link href="/admin/gate-assignments">Gate assignments</Link>
        </div>
        <DataTable title="Events" rows={events} columns={["id", "title", "status", "starts_at", "category"]} />
      </section>
    );
  }

  function renderAdminGate() {
    return (
      <section className="content-stack">
        <div className="section-header">
          <div>
            <p className="eyebrow">Admin gate control</p>
            <h2>Gate staff assignments</h2>
          </div>
          <button type="button" onClick={() => void loadEvents(true)}>Load all events</button>
        </div>
        <form className="panel form-grid" onSubmit={(event) => void assignGateStaff(event)}>
          <select name="event_id" required>
            <option value="">Select event</option>
            {events.map((event) => (
              <option key={event.id} value={event.id}>{event.title}</option>
            ))}
          </select>
          <input name="staff_user_id" placeholder="Gate staff user UUID" required />
          <input name="code_active_from" type="datetime-local" aria-label="Code active from" />
          <input name="code_expires_at" type="datetime-local" aria-label="Code expires at" />
          <button className="primary-button" type="submit" disabled={loading}>Assign gate staff</button>
        </form>
        <div className="event-grid">
          {events.slice(0, 6).map((event) => (
            <article className="panel" key={event.id}>
              <h3>{event.title}</h3>
              <p>{formatDate(event.starts_at)}</p>
              <button type="button" onClick={() => void loadGateAssignments(event.id)}>View assignments</button>
            </article>
          ))}
        </div>
        <DataTable title="Assignment status" rows={gateAssignments} columns={["id", "staff_user_id", "status", "code_hint", "code_active_from", "code_expires_at", "failed_attempts"]} />
      </section>
    );
  }

  function renderSecurity() {
    const suspicious = auditLogs.filter((log) => log.is_suspicious);

    return (
      <section className="content-stack">
        <div className="section-header">
          <div>
            <p className="eyebrow">Manual security dashboard</p>
            <h2>Security logs</h2>
          </div>
          <button type="button" onClick={() => void loadSecurity()}>Refresh</button>
        </div>
        <KpiGrid
          items={[
            ["Audit events", auditLogs.length],
            ["Suspicious", suspicious.length],
            ["Security role", isSecurity ? "active" : "inactive"],
            ["Unread alerts", unreadCount]
          ]}
        />
        <DataTable title="Suspicious events" rows={suspicious} columns={["event_type", "service_name", "severity", "suspicious_reason", "created_at"]} />
        <DataTable title="Audit logs" rows={auditLogs} columns={["event_type", "service_name", "severity", "action", "resource_type", "created_at"]} />
      </section>
    );
  }

  function renderMonitoring() {
    return (
      <section className="content-stack">
        <div className="section-header">
          <div>
            <p className="eyebrow">Phase 11 dashboard</p>
            <h2>Monitoring</h2>
          </div>
          <div className="button-row">
            <button type="button" onClick={() => void loadMonitoring()}>Refresh</button>
          </div>
        </div>
        <KpiGrid
          items={[
            ["Total services", String(monitoringSummary?.total_services ?? "n/a")],
            ["Healthy", String(monitoringSummary?.healthy_services ?? "n/a")],
            ["Degraded", String(monitoringSummary?.degraded_services ?? "n/a")],
            ["Open incidents", String(monitoringSummary?.open_incidents ?? "n/a")]
          ]}
        />
        <div className="incident-list">
          {incidents.map((incident) => (
            <article className="ticket-row" key={incident.id}>
              <div>
                <h3>{incident.service_name}</h3>
                <p>{incident.incident_type} Â· {incident.summary}</p>
              </div>
              <StatusBadge value={incident.severity} />
              <div className="button-row">
                <button type="button" onClick={() => void acknowledgeIncident(incident.id)}>Ack</button>
                <button type="button" onClick={() => void resolveIncident(incident.id)}>Resolve</button>
              </div>
            </article>
          ))}
        </div>
        <JsonPanel title="Topology" value={topology} />
        <JsonPanel title="Distributed model" value={distributedModel} />
        <DataTable title="RSM events" rows={rsmEvents} columns={["log_index", "event_type", "status", "created_at"]} />
      </section>
    );
  }

  function renderStaff() {
    return (
      <section className="content-stack">
        <KpiGrid
          items={[
            ["Role", user ? getRoleLabel(user.role) : "Not logged in"],
            ["Gate events", staffEvents.length],
            ["Staff status", user?.staff_status || "unknown"],
            ["Gate access", userRole === "security" ? "enabled" : "not staff role"]
          ]}
        />
        <div className="button-row">
          <Link className="primary-button" href="/staff/events">My gate events</Link>
          <Link className="secondary-button" href="/staff/scanner">Gate scanner</Link>
        </div>
      </section>
    );
  }

  function renderStaffEvents() {
    return (
      <section className="content-stack">
        <div className="section-header">
          <div>
            <p className="eyebrow">Gate staff</p>
            <h2>My Gate Events</h2>
          </div>
          <button type="button" onClick={() => void loadStaffEvents(user?.id)}>Refresh</button>
        </div>
        <div className="event-grid">
          {staffEvents.map((item) => (
            <article className="panel" key={item.assignment.id}>
              <p className="eyebrow">{item.event.venue?.city || "gate"}</p>
              <h3>{item.event.title}</h3>
              <StatusBadge value={item.code_status} />
              <p>Active: {formatDate(item.active_from)}</p>
              <p>Expires: {formatDate(item.expires_at)}</p>
              {item.seconds_until_active ? <p>{item.seconds_until_active}s until code unlocks</p> : null}
              <div className="button-row">
                <button type="button" onClick={() => void loadMyGateCode(item.event.id)}>Get my code</button>
                <Link href={`/staff/events/${item.event.id}`}>Panel</Link>
              </div>
            </article>
          ))}
        </div>
        {activeGateCode ? (
          <article className="gate-code-panel">
            <p className="eyebrow">Your active code</p>
            <strong>{activeGateCode}</strong>
            <small>Visible only for your assignment during the active window.</small>
          </article>
        ) : null}
      </section>
    );
  }

  function renderScanner() {
    const eventId = selectedStaffEvent?.event.id || resourceId || "";

    return (
      <section className="detail-layout">
        <form className="large-panel form-stack" onSubmit={(event) => void verifyAtGate(event)}>
          <p className="eyebrow">Manual scanner fallback</p>
          <h2>Gate Scanner</h2>
          <select name="event_id" defaultValue={eventId}>
            <option value="">Select assigned event</option>
            {staffEvents.map((item) => (
              <option key={item.event.id} value={item.event.id}>{item.event.title}</option>
            ))}
          </select>
          <input
            name="gate_code"
            value={manualGateCode}
            onChange={(input) => setManualGateCode(input.target.value)}
            placeholder="Your active gate code"
          />
          <textarea
            name="qr_token"
            value={manualQrToken}
            onChange={(input) => setManualQrToken(input.target.value)}
            placeholder="Paste user's QR token or verification URL"
            rows={5}
          />
          <button className="primary-button" type="submit" disabled={loading}>Verify and use ticket</button>
        </form>
        <JsonPanel title="Verification result" value={scannerResult} />
      </section>
    );
  }
}

function titleForView(view: ViewName) {
  const titles: Record<ViewName, string> = {
    home: APP_NAME,
    events: "Events",
    "event-detail": "Event Details",
    login: "Login",
    register: "Register",
    booking: "Booking",
    payment: "Payment",
    tickets: "My Tickets",
    "ticket-detail": "Ticket QR",
    notifications: "Notification Center",
    admin: "Admin Dashboard",
    "admin-gate": "Gate Assignments",
    security: "Security Dashboard",
    monitoring: "Monitoring Dashboard",
    "monitoring-incident": "Incident Detail",
    staff: "Staff Dashboard",
    "staff-events": "My Gate Events",
    "staff-event-panel": "Event Gate Panel",
    "staff-scanner": "Gate Scanner"
  };

  return titles[view];
}

function StatusBadge({ value }: { value?: string | boolean | null }) {
  const tone = statusTone(value);

  return <span className={`status-badge ${tone}`}>{String(value ?? "info")}</span>;
}

function EmptyState({ title, message }: { title: string; message: string }) {
  return (
    <article className="empty-state">
      <h2>{title}</h2>
      <p>{message}</p>
    </article>
  );
}

function KpiGrid({ items }: { items: Array<[string, string | number]> }) {
  return (
    <div className="kpi-grid">
      {items.map(([label, value]) => (
        <article className="kpi-card" key={label}>
          <span>{label}</span>
          <strong>{value}</strong>
        </article>
      ))}
    </div>
  );
}

function DataTable<T extends Record<string, unknown>>({
  title,
  rows,
  columns
}: {
  title: string;
  rows: T[];
  columns: string[];
}) {
  return (
    <section className="table-panel">
      <div className="section-header compact">
        <h3>{title}</h3>
        <span>{rows.length} rows</span>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              {columns.map((column) => <th key={column}>{column}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length}>No records loaded.</td>
              </tr>
            ) : rows.map((row, index) => (
              <tr key={String(row.id || index)}>
                {columns.map((column) => (
                  <td key={column}>{formatCellValue(row[column])}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function JsonPanel({ title, value }: { title: string; value: unknown }) {
  return (
    <article className="json-panel">
      <h3>{title}</h3>
      <pre>{JSON.stringify(value || { status: "not loaded" }, null, 2)}</pre>
    </article>
  );
}

function formatCellValue(value: unknown) {
  if (value === null || value === undefined) {
    return "n/a";
  }

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  if (typeof value === "object") {
    return JSON.stringify(value);
  }

  return String(value);
}

