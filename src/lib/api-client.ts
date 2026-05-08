"use client";

export type ApiMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type ApiRequestOptions = {
  method?: ApiMethod;
  body?: unknown;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | null | undefined>;
};

export type ApiEnvelope<T = unknown> = {
  data?: T;
  message?: string;
  error?: string;
  pagination?: {
    limit: number;
    offset: number;
    count: number;
  };
  [key: string]: unknown;
};

export type AuthSession = {
  token: string | null;
  user: {
    id: string;
    email: string;
    role: string;
    staff_status?: string;
    must_reset_password?: boolean;
  } | null;
};

export class ApiClientError extends Error {
  status: number;
  payload: unknown;

  constructor(status: number, message: string, payload: unknown) {
    super(message);
    this.name = "ApiClientError";
    this.status = status;
    this.payload = payload;
  }
}

export function getApiGatewayUrl() {
  const configuredUrl = process.env.NEXT_PUBLIC_API_GATEWAY_URL || "";
  return configuredUrl.replace(/\/+$/, "");
}

export function getStoredSession(): AuthSession {
  if (typeof window === "undefined") {
    return {
      token: null,
      user: null
    };
  }

  try {
    const token = window.localStorage.getItem("secure_tickets_token");
    const rawUser = window.localStorage.getItem("secure_tickets_user");

    return {
      token,
      user: rawUser ? JSON.parse(rawUser) : null
    };
  } catch {
    return {
      token: null,
      user: null
    };
  }
}

export function storeSession(session: AuthSession) {
  if (typeof window === "undefined") {
    return;
  }

  if (session.token) {
    window.localStorage.setItem("secure_tickets_token", session.token);
  } else {
    window.localStorage.removeItem("secure_tickets_token");
  }

  if (session.user) {
    window.localStorage.setItem("secure_tickets_user", JSON.stringify(session.user));
  } else {
    window.localStorage.removeItem("secure_tickets_user");
  }
}

function buildQueryString(query?: ApiRequestOptions["query"]) {
  if (!query) {
    return "";
  }

  const params = new URLSearchParams();

  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      params.set(key, String(value));
    }
  });

  const queryString = params.toString();
  return queryString ? `?${queryString}` : "";
}

function readErrorMessage(payload: unknown, fallback: string) {
  if (payload && typeof payload === "object") {
    const objectPayload = payload as Record<string, unknown>;
    const message = objectPayload.message || objectPayload.error;

    if (typeof message === "string" && message.trim()) {
      return message;
    }
  }

  return fallback;
}

export async function apiRequest<T = unknown>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const baseUrl = getApiGatewayUrl();

  if (!baseUrl) {
    throw new ApiClientError(0, "API Gateway URL is not configured", null);
  }

  const session = getStoredSession();
  const headers: Record<string, string> = {
    accept: "application/json",
    ...options.headers
  };

  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
  }

  if (session.token) {
    headers.authorization = `Bearer ${session.token}`;
  }

  const response = await fetch(`${baseUrl}${path}${buildQueryString(options.query)}`, {
    method: options.method || "GET",
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined
  });

  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json")
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    throw new ApiClientError(response.status, readErrorMessage(payload, "Request failed"), payload);
  }

  return payload as T;
}

export function extractData<T>(payload: ApiEnvelope<T> | T): T {
  if (payload && typeof payload === "object" && "data" in payload) {
    return (payload as ApiEnvelope<T>).data as T;
  }

  return payload as T;
}
