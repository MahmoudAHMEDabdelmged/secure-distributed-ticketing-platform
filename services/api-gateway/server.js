const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const { createProxyMiddleware } = require("http-proxy-middleware");
require("dotenv").config();

const app = express();

app.use(cors());

const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || "dev_secret_change_me";
const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || "http://localhost:5000";
const EVENTS_SERVICE_URL = process.env.EVENTS_SERVICE_URL || "http://localhost:5001";
const BOOKING_SERVICE_URL = process.env.BOOKING_SERVICE_URL || "http://localhost:5002";
const TICKET_SERVICE_URL = process.env.TICKET_SERVICE_URL || "http://localhost:5003";
const PAYMENT_SERVICE_URL = process.env.PAYMENT_SERVICE_URL || "http://localhost:5004";
const NOTIFICATION_SERVICE_URL = process.env.NOTIFICATION_SERVICE_URL || "http://localhost:5005";
const AUDIT_SERVICE_URL = process.env.AUDIT_SERVICE_URL || "http://localhost:5006";
const SAGA_SERVICE_URL = process.env.SAGA_SERVICE_URL || "http://localhost:5007";
const MONITORING_SERVICE_URL = process.env.MONITORING_SERVICE_URL || "http://localhost:5008";
const COORDINATOR_SERVICE_URL = process.env.COORDINATOR_SERVICE_URL || "http://localhost:4010";

const requestCounts = new Map();

function rateLimiter(req, res, next) {
  const ip = req.ip;
  const now = Date.now();
  const windowMs = 60 * 1000;
  const maxRequests = 120;

  const record = requestCounts.get(ip) || {
    count: 0,
    startTime: now
  };

  if (now - record.startTime > windowMs) {
    record.count = 0;
    record.startTime = now;
  }

  record.count += 1;
  requestCounts.set(ip, record);

  if (record.count > maxRequests) {
    console.log(`Suspicious activity detected from IP: ${ip}`);

    return res.status(429).json({
      error: "Too many requests. Please try again later."
    });
  }

  next();
}

function normalizeGatewayPath(path) {
  const normalized = String(path || "/").replace(/\/+$/, "");
  return normalized || "/";
}

function isPublicRoute(req) {
  const path = normalizeGatewayPath(req.path);
  const method = req.method.toUpperCase();

  const publicExactRoutes = new Set([
    "/health",

    // Direct auth-service style routes.
    "/auth/health",
    "/auth/register",
    "/auth/login",

    // Frontend/API style auth routes.
    "/api/auth/health",
    "/api/auth/register",
    "/api/auth/login",

    // Direct service health routes.
    "/events-service/health",
    "/events-service/health/deep",
    "/booking-service/health",
    "/booking-service/health/deep",
    "/ticket-service/health",
    "/ticket-service/health/deep",
    "/payment-service/health",
    "/payment-service/health/deep",
    "/notification-service/health",
    "/notification-service/health/deep",
    "/audit-service/health",
    "/audit-service/health/deep",
    "/saga-service/health",
    "/saga-service/health/deep",
    "/monitoring-service/health",
    "/monitoring-service/health/deep",

    // Legacy public health aliases.
    "/events/health",
    "/events/health/deep",
    "/bookings/health",
    "/bookings/health/deep",
    "/tickets/health",
    "/tickets/health/deep",
    "/payments/health",
    "/payments/health/deep",
    "/notifications/health",
    "/notifications/health/deep",
    "/audit/health",
    "/audit/health/deep",
    "/sagas/health",
    "/sagas/health/deep",
    "/monitoring/health",
    "/monitoring/health/deep",

    // API style health routes.
    "/api/events/health",
    "/api/events/health/deep",
    "/api/bookings/health",
    "/api/bookings/health/deep",
    "/api/tickets/health",
    "/api/tickets/health/deep",
    "/api/payments/health",
    "/api/payments/health/deep",
    "/api/notifications/health",
    "/api/notifications/health/deep",
    "/api/audit/health",
    "/api/audit/health/deep",
    "/api/sagas/health",
    "/api/sagas/health/deep",
    "/api/monitoring/health",
    "/api/monitoring/health/deep",

    // Coordinator safe read-only / readiness routes.
    "/api/coordinator/health",
    "/api/coordinator/health/deep",
    "/api/coordinator/cluster",
    "/api/coordinator/fault-tolerance",
    "/api/coordinator/leader"
  ]);

  if (publicExactRoutes.has(path)) {
    return true;
  }

  // Public event discovery.
  if (
    method === "GET" &&
    (
      path === "/events" ||
      path.startsWith("/events/") ||
      path === "/api/events" ||
      path.startsWith("/api/events/")
    )
  ) {
    return true;
  }

  // Public venues listing.
  if (method === "GET" && (path === "/venues" || path === "/api/venues")) {
    return true;
  }

  // Public QR verification endpoint. It returns hardened public verification data.
  if (
    method === "GET" &&
    (
      matchesRoutePrefix(path, "/verify-ticket") ||
      matchesRoutePrefix(path, "/api/verify-ticket")
    )
  ) {
    return true;
  }

  return false;
}

function verifyToken(req, res, next) {
  if (isPublicRoute(req)) {
    return next();
  }

  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({
      error: "Missing Authorization header"
    });
  }

  const token = authHeader.replace("Bearer ", "");

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    return next();
  } catch (error) {
    return res.status(403).json({
      error: "Invalid or expired token"
    });
  }
}

function eventsServiceUnavailable(error, req, res) {
  console.error("Events Service proxy error:", {
    message: error.message,
    code: error.code,
    path: req.originalUrl
  });

  if (!res.headersSent) {
    res.writeHead(502, {
      "Content-Type": "application/json"
    });
  }

  res.end(
    JSON.stringify({
      message: "Events Service unavailable",
      service: "api-gateway"
    })
  );
}

function bookingServiceUnavailable(error, req, res) {
  console.error("Booking Service proxy error:", {
    message: error.message,
    code: error.code,
    path: req.originalUrl
  });

  if (!res.headersSent) {
    res.writeHead(502, {
      "Content-Type": "application/json"
    });
  }

  res.end(
    JSON.stringify({
      message: "Booking Service unavailable",
      service: "api-gateway"
    })
  );
}

function ticketServiceUnavailable(error, req, res) {
  console.error("Ticket Service proxy error:", {
    message: error.message,
    code: error.code,
    path: sanitizeGatewayPath(req.originalUrl)
  });

  if (!res.headersSent) {
    res.writeHead(502, {
      "Content-Type": "application/json"
    });
  }

  res.end(
    JSON.stringify({
      message: "Ticket Service unavailable",
      service: "api-gateway"
    })
  );
}

function paymentServiceUnavailable(error, req, res) {
  console.error("Payment Service proxy error:", {
    message: error.message,
    code: error.code,
    path: sanitizeGatewayPath(req.originalUrl)
  });

  if (!res.headersSent) {
    res.writeHead(502, {
      "Content-Type": "application/json"
    });
  }

  res.end(
    JSON.stringify({
      message: "Payment Service unavailable",
      service: "api-gateway"
    })
  );
}

function notificationServiceUnavailable(error, req, res) {
  console.error("Notification Service proxy error:", {
    message: error.message,
    code: error.code,
    path: sanitizeGatewayPath(req.originalUrl)
  });

  if (!res.headersSent) {
    res.writeHead(502, {
      "Content-Type": "application/json"
    });
  }

  res.end(
    JSON.stringify({
      message: "Notification Service unavailable",
      service: "api-gateway"
    })
  );
}

function auditServiceUnavailable(error, req, res) {
  console.error("Audit Service proxy error:", {
    message: error.message,
    code: error.code,
    path: sanitizeGatewayPath(req.originalUrl)
  });

  if (!res.headersSent) {
    res.writeHead(502, {
      "Content-Type": "application/json"
    });
  }

  res.end(
    JSON.stringify({
      message: "Audit Service unavailable",
      service: "api-gateway"
    })
  );
}

function sagaServiceUnavailable(error, req, res) {
  console.error("Saga Service proxy error:", {
    message: error.message,
    code: error.code,
    path: sanitizeGatewayPath(req.originalUrl)
  });

  if (!res.headersSent) {
    res.writeHead(502, {
      "Content-Type": "application/json"
    });
  }

  res.end(
    JSON.stringify({
      message: "Saga Service unavailable",
      service: "api-gateway"
    })
  );
}

function monitoringServiceUnavailable(error, req, res) {
  console.error("Monitoring Service proxy error:", {
    message: error.message,
    code: error.code,
    path: sanitizeGatewayPath(req.originalUrl)
  });

  if (!res.headersSent) {
    res.writeHead(502, {
      "Content-Type": "application/json"
    });
  }

  res.end(
    JSON.stringify({
      message: "Monitoring Service unavailable",
      service: "api-gateway"
    })
  );
}

function coordinatorServiceUnavailable(error, req, res) {
  console.error("Coordinator Service proxy error:", {
    message: error.message,
    code: error.code,
    path: req.originalUrl
  });

  if (!res.headersSent) {
    res.writeHead(502, {
      "Content-Type": "application/json"
    });
  }

  res.end(
    JSON.stringify({
      message: "Coordinator Service unavailable",
      service: "api-gateway"
    })
  );
}

function sanitizeGatewayPath(path) {
  return String(path)
    .replace(/\/verify-ticket\/[^/?#]+/g, "/verify-ticket/[token]")
    .replace(/\/api\/verify-ticket\/[^/?#]+/g, "/api/verify-ticket/[token]")
    .replace(/\/tickets\/verify\/[^/?#]+/g, "/tickets/verify/[token]")
    .replace(/\/api\/tickets\/verify\/[^/?#]+/g, "/api/tickets/verify/[token]");
}

function matchesRoutePrefix(path, prefix) {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function matchesUserBookingsRoute(path) {
  return /^\/users\/[^/]+\/bookings\/?$/.test(path) ||
    /^\/api\/users\/[^/]+\/bookings\/?$/.test(path);
}

function matchesBookingTicketsRoute(path) {
  return /^\/bookings\/[^/]+\/tickets\/?$/.test(path) ||
    /^\/api\/bookings\/[^/]+\/tickets\/?$/.test(path);
}

function matchesBookingPaymentsRoute(path) {
  return /^\/bookings\/[^/]+\/payments\/?$/.test(path) ||
    /^\/api\/bookings\/[^/]+\/payments\/?$/.test(path);
}

function matchesPaymentStatusRoute(path) {
  return /^\/payments\/booking\/[^/]+\/status\/?$/.test(path) ||
    /^\/api\/payments\/booking\/[^/]+\/status\/?$/.test(path);
}

function matchesNotificationBookingRoute(path) {
  return /^\/notifications\/booking\/[^/]+\/?$/.test(path) ||
    /^\/api\/notifications\/booking\/[^/]+\/?$/.test(path);
}

function matchesUserTicketsRoute(path) {
  return /^\/users\/[^/]+\/tickets\/?$/.test(path) ||
    /^\/api\/users\/[^/]+\/tickets\/?$/.test(path);
}

function matchesInternalUserAccessRoute(path) {
  return /^\/internal\/users\/[^/]+\/access\/?$/.test(path) ||
    /^\/api\/internal\/users\/[^/]+\/access\/?$/.test(path);
}

function matchesEventGateCodeRoute(path) {
  return /^\/events\/[^/]+\/gate-code\/(rotate|validate|status)\/?$/.test(path) ||
    /^\/api\/events\/[^/]+\/gate-code\/(rotate|validate|status)\/?$/.test(path);
}

function matchesEventGateStaffRoute(path) {
  return /^\/events\/gate-staff\/my-events\/?$/.test(path) ||
    /^\/api\/events\/gate-staff\/my-events\/?$/.test(path) ||
    /^\/events\/[^/]+\/gate-staff\/(assignments|my-code|validate-code)\/?$/.test(path) ||
    /^\/api\/events\/[^/]+\/gate-staff\/(assignments|my-code|validate-code)\/?$/.test(path) ||
    /^\/events\/[^/]+\/gate-staff\/assignments\/[^/]+\/(rotate|revoke)\/?$/.test(path) ||
    /^\/api\/events\/[^/]+\/gate-staff\/assignments\/[^/]+\/(rotate|revoke)\/?$/.test(path);
}

function stripApiPrefix(path, prefix, replacement) {
  return path.replace(prefix, replacement);
}

app.use(rateLimiter);
app.use(verifyToken);

app.get("/health", (req, res) => {
  res.json({
    service: "api-gateway",
    status: "healthy",
    timestamp: new Date().toISOString()
  });
});

app.get("/secure-test", (req, res) => {
  res.json({
    message: "Protected gateway route is working",
    user: req.user
  });
});

/**
 * Auth service
 * Supports both:
 * - /auth/login
 * - /api/auth/login
 */
app.use(
  "/auth",
  createProxyMiddleware({
    target: AUTH_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: {
      "^/auth": ""
    }
  })
);

app.use(
  "/api/auth",
  createProxyMiddleware({
    target: AUTH_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: {
      "^/api/auth": ""
    }
  })
);

app.use(
  createProxyMiddleware({
    pathFilter: (path) => matchesRoutePrefix(path, "/staff"),
    target: AUTH_SERVICE_URL,
    changeOrigin: true
  })
);

app.use(
  createProxyMiddleware({
    pathFilter: (path) => matchesRoutePrefix(path, "/api/staff"),
    target: AUTH_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: (path) => stripApiPrefix(path, /^\/api\/staff/, "/staff")
  })
);

app.use(
  createProxyMiddleware({
    pathFilter: (path) => matchesInternalUserAccessRoute(path),
    target: AUTH_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: (path) => path.replace(/^\/api/, "")
  })
);

/**
 * Health aliases for /api/{service}/health.
 */
app.use(
  createProxyMiddleware({
    pathFilter: (path) => path === "/api/events/health" || path === "/api/events/health/deep",
    target: EVENTS_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: {
      "^/api/events": ""
    },
    on: {
      error: eventsServiceUnavailable
    }
  })
);

app.use(
  createProxyMiddleware({
    pathFilter: (path) => path === "/api/bookings/health" || path === "/api/bookings/health/deep",
    target: BOOKING_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: {
      "^/api/bookings": ""
    },
    on: {
      error: bookingServiceUnavailable
    }
  })
);

app.use(
  createProxyMiddleware({
    pathFilter: (path) => path === "/api/tickets/health" || path === "/api/tickets/health/deep",
    target: TICKET_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: {
      "^/api/tickets": ""
    },
    on: {
      error: ticketServiceUnavailable
    }
  })
);

app.use(
  createProxyMiddleware({
    pathFilter: (path) => path === "/api/payments/health" || path === "/api/payments/health/deep",
    target: PAYMENT_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: {
      "^/api/payments": ""
    },
    on: {
      error: paymentServiceUnavailable
    }
  })
);

app.use(
  createProxyMiddleware({
    pathFilter: (path) => path === "/api/notifications/health" || path === "/api/notifications/health/deep",
    target: NOTIFICATION_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: {
      "^/api/notifications": ""
    },
    on: {
      error: notificationServiceUnavailable
    }
  })
);

app.use(
  createProxyMiddleware({
    pathFilter: (path) => path === "/api/audit/health" || path === "/api/audit/health/deep",
    target: AUDIT_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: {
      "^/api/audit": ""
    },
    on: {
      error: auditServiceUnavailable
    }
  })
);

app.use(
  createProxyMiddleware({
    pathFilter: (path) => path === "/api/sagas/health" || path === "/api/sagas/health/deep",
    target: SAGA_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: {
      "^/api/sagas": ""
    },
    on: {
      error: sagaServiceUnavailable
    }
  })
);

app.use(
  createProxyMiddleware({
    pathFilter: (path) => path === "/api/monitoring/health" || path === "/api/monitoring/health/deep",
    target: MONITORING_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: {
      "^/api/monitoring": ""
    },
    on: {
      error: monitoringServiceUnavailable
    }
  })
);

/**
 * Events service
 */
app.use(
  createProxyMiddleware({
    pathFilter: (path) => matchesRoutePrefix(path, "/events-service"),
    target: EVENTS_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: {
      "^/events-service": ""
    },
    on: {
      error: eventsServiceUnavailable
    }
  })
);

app.use(
  createProxyMiddleware({
    pathFilter: (path) => matchesRoutePrefix(path, "/api/events"),
    target: EVENTS_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: (path) => stripApiPrefix(path, /^\/api\/events/, "/events"),
    on: {
      error: eventsServiceUnavailable
    }
  })
);

app.use(
  createProxyMiddleware({
    pathFilter: (path) => matchesRoutePrefix(path, "/events"),
    target: EVENTS_SERVICE_URL,
    changeOrigin: true,
    on: {
      error: eventsServiceUnavailable
    }
  })
);

app.use(
  createProxyMiddleware({
    pathFilter: (path) => matchesRoutePrefix(path, "/api/venues"),
    target: EVENTS_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: (path) => stripApiPrefix(path, /^\/api\/venues/, "/venues"),
    on: {
      error: eventsServiceUnavailable
    }
  })
);

app.use(
  createProxyMiddleware({
    pathFilter: (path) => matchesRoutePrefix(path, "/venues"),
    target: EVENTS_SERVICE_URL,
    changeOrigin: true,
    on: {
      error: eventsServiceUnavailable
    }
  })
);

/**
 * Booking service
 */
app.use(
  createProxyMiddleware({
    pathFilter: (path) => matchesRoutePrefix(path, "/booking-service"),
    target: BOOKING_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: {
      "^/booking-service": ""
    },
    on: {
      error: bookingServiceUnavailable
    }
  })
);

app.use(
  createProxyMiddleware({
    pathFilter: (path) => matchesRoutePrefix(path, "/api/bookings"),
    target: BOOKING_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: (path) => stripApiPrefix(path, /^\/api\/bookings/, "/bookings"),
    on: {
      error: bookingServiceUnavailable
    }
  })
);

app.use(
  createProxyMiddleware({
    pathFilter: (path) => matchesRoutePrefix(path, "/api/users") && path.includes("/bookings"),
    target: BOOKING_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: (path) => path.replace(/^\/api/, ""),
    on: {
      error: bookingServiceUnavailable
    }
  })
);

app.use(
  createProxyMiddleware({
    pathFilter: (path) => matchesRoutePrefix(path, "/bookings"),
    target: BOOKING_SERVICE_URL,
    changeOrigin: true,
    on: {
      error: bookingServiceUnavailable
    }
  })
);

app.use(
  createProxyMiddleware({
    pathFilter: (path) => matchesUserBookingsRoute(path),
    target: BOOKING_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: (path) => path.replace(/^\/api/, ""),
    on: {
      error: bookingServiceUnavailable
    }
  })
);

/**
 * Ticket service
 */
app.use(
  createProxyMiddleware({
    pathFilter: (path) => matchesRoutePrefix(path, "/ticket-service"),
    target: TICKET_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: {
      "^/ticket-service": ""
    },
    on: {
      error: ticketServiceUnavailable
    }
  })
);

app.use(
  createProxyMiddleware({
    pathFilter: (path) => path === "/tickets/gate/verify-use" || path === "/api/tickets/gate/verify-use",
    target: TICKET_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: (path) => path.replace(/^\/api/, ""),
    on: {
      error: ticketServiceUnavailable
    }
  })
);

app.use(
  createProxyMiddleware({
    pathFilter: (path) => matchesRoutePrefix(path, "/verify-ticket") || matchesRoutePrefix(path, "/api/verify-ticket"),
    target: TICKET_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: (path) =>
      path
        .replace(/^\/api\/verify-ticket/, "/tickets/verify")
        .replace(/^\/verify-ticket/, "/tickets/verify"),
    on: {
      error: ticketServiceUnavailable
    }
  })
);

app.use(
  createProxyMiddleware({
    pathFilter: (path) => matchesBookingTicketsRoute(path),
    target: TICKET_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: (path) => path.replace(/^\/api/, ""),
    on: {
      error: ticketServiceUnavailable
    }
  })
);

app.use(
  createProxyMiddleware({
    pathFilter: (path) => matchesUserTicketsRoute(path),
    target: TICKET_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: (path) => path.replace(/^\/api/, ""),
    on: {
      error: ticketServiceUnavailable
    }
  })
);

app.use(
  createProxyMiddleware({
    pathFilter: (path) => matchesRoutePrefix(path, "/api/tickets"),
    target: TICKET_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: (path) => stripApiPrefix(path, /^\/api\/tickets/, "/tickets"),
    on: {
      error: ticketServiceUnavailable
    }
  })
);

app.use(
  createProxyMiddleware({
    pathFilter: (path) => matchesRoutePrefix(path, "/tickets"),
    target: TICKET_SERVICE_URL,
    changeOrigin: true,
    on: {
      error: ticketServiceUnavailable
    }
  })
);

/**
 * Payment service
 */
app.use(
  createProxyMiddleware({
    pathFilter: (path) => matchesRoutePrefix(path, "/payment-service"),
    target: PAYMENT_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: {
      "^/payment-service": ""
    },
    on: {
      error: paymentServiceUnavailable
    }
  })
);

app.use(
  createProxyMiddleware({
    pathFilter: (path) => matchesPaymentStatusRoute(path) || matchesBookingPaymentsRoute(path),
    target: PAYMENT_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: (path) => path.replace(/^\/api/, ""),
    on: {
      error: paymentServiceUnavailable
    }
  })
);

app.use(
  createProxyMiddleware({
    pathFilter: (path) => matchesRoutePrefix(path, "/api/payments"),
    target: PAYMENT_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: (path) => stripApiPrefix(path, /^\/api\/payments/, "/payments"),
    on: {
      error: paymentServiceUnavailable
    }
  })
);

app.use(
  createProxyMiddleware({
    pathFilter: (path) => matchesRoutePrefix(path, "/payments"),
    target: PAYMENT_SERVICE_URL,
    changeOrigin: true,
    on: {
      error: paymentServiceUnavailable
    }
  })
);

/**
 * Notification service
 */
app.use(
  createProxyMiddleware({
    pathFilter: (path) => matchesRoutePrefix(path, "/notification-service"),
    target: NOTIFICATION_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: {
      "^/notification-service": ""
    },
    on: {
      error: notificationServiceUnavailable
    }
  })
);

app.use(
  createProxyMiddleware({
    pathFilter: (path) => matchesNotificationBookingRoute(path),
    target: NOTIFICATION_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: (path) => path.replace(/^\/api/, ""),
    on: {
      error: notificationServiceUnavailable
    }
  })
);

app.use(
  createProxyMiddleware({
    pathFilter: (path) => matchesRoutePrefix(path, "/api/notifications"),
    target: NOTIFICATION_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: (path) => stripApiPrefix(path, /^\/api\/notifications/, "/notifications"),
    on: {
      error: notificationServiceUnavailable
    }
  })
);

app.use(
  createProxyMiddleware({
    pathFilter: (path) => matchesRoutePrefix(path, "/notifications"),
    target: NOTIFICATION_SERVICE_URL,
    changeOrigin: true,
    on: {
      error: notificationServiceUnavailable
    }
  })
);

/**
 * Audit service
 */
app.use(
  createProxyMiddleware({
    pathFilter: (path) => matchesRoutePrefix(path, "/audit-service"),
    target: AUDIT_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: {
      "^/audit-service": ""
    },
    on: {
      error: auditServiceUnavailable
    }
  })
);

app.use(
  createProxyMiddleware({
    pathFilter: (path) => matchesRoutePrefix(path, "/api/audit"),
    target: AUDIT_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: (path) => stripApiPrefix(path, /^\/api\/audit/, "/audit"),
    on: {
      error: auditServiceUnavailable
    }
  })
);

app.use(
  createProxyMiddleware({
    pathFilter: (path) => matchesRoutePrefix(path, "/audit"),
    target: AUDIT_SERVICE_URL,
    changeOrigin: true,
    on: {
      error: auditServiceUnavailable
    }
  })
);

/**
 * Saga service
 */
app.use(
  createProxyMiddleware({
    pathFilter: (path) => matchesRoutePrefix(path, "/saga-service"),
    target: SAGA_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: {
      "^/saga-service": ""
    },
    on: {
      error: sagaServiceUnavailable
    }
  })
);

app.use(
  createProxyMiddleware({
    pathFilter: (path) => matchesRoutePrefix(path, "/api/sagas"),
    target: SAGA_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: (path) => stripApiPrefix(path, /^\/api\/sagas/, "/sagas"),
    on: {
      error: sagaServiceUnavailable
    }
  })
);

app.use(
  createProxyMiddleware({
    pathFilter: (path) => matchesRoutePrefix(path, "/sagas"),
    target: SAGA_SERVICE_URL,
    changeOrigin: true,
    on: {
      error: sagaServiceUnavailable
    }
  })
);

/**
 * Monitoring service
 */
app.use(
  createProxyMiddleware({
    pathFilter: (path) => matchesRoutePrefix(path, "/monitoring-service"),
    target: MONITORING_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: {
      "^/monitoring-service": ""
    },
    on: {
      error: monitoringServiceUnavailable
    }
  })
);

app.use(
  createProxyMiddleware({
    pathFilter: (path) => matchesRoutePrefix(path, "/api/monitoring"),
    target: MONITORING_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: (path) => stripApiPrefix(path, /^\/api\/monitoring/, "/monitoring"),
    on: {
      error: monitoringServiceUnavailable
    }
  })
);

app.use(
  createProxyMiddleware({
    pathFilter: (path) => matchesRoutePrefix(path, "/monitoring"),
    target: MONITORING_SERVICE_URL,
    changeOrigin: true,
    on: {
      error: monitoringServiceUnavailable
    }
  })
);

/**
 * Coordinator service
 */
app.use(
  createProxyMiddleware({
    pathFilter: (path) => matchesRoutePrefix(path, "/api/coordinator"),
    target: COORDINATOR_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: {
      "^/api/coordinator": ""
    },
    on: {
      error: coordinatorServiceUnavailable
    }
  })
);

app.listen(PORT, () => {
  console.log(`API Gateway running on port ${PORT}`);
});