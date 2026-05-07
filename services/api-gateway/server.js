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

const requestCounts = new Map();

function rateLimiter(req, res, next) {
  const ip = req.ip;
  const now = Date.now();
  const windowMs = 60 * 1000;
  const maxRequests = 20;

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

function isPublicRoute(req) {
  const publicRoutes = [
    "/health",
    "/auth/health",
    "/auth/register",
    "/auth/login",
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
    "/saga-service/health/deep"
  ];

  if (publicRoutes.includes(req.path)) {
    return true;
  }

  if (req.method === "GET" && (req.path === "/events" || req.path.startsWith("/events/"))) {
    return true;
  }

  if (req.method === "GET" && req.path === "/venues") {
    return true;
  }

  // TODO: Protect these write routes with organizer/admin authorization in the admin flow phase.
  if ((req.method === "POST") && (req.path === "/events" || req.path === "/venues")) {
    return true;
  }

  // TODO: Derive user_id from JWT and protect booking routes in the admin/user flow phase.
  if (
    matchesRoutePrefix(req.path, "/bookings") ||
    matchesUserBookingsRoute(req.path)
  ) {
    return true;
  }

  // TODO: Protect ticket issuance and ticket state changes with user/admin authorization.
  if (
    matchesRoutePrefix(req.path, "/tickets") ||
    matchesBookingTicketsRoute(req.path) ||
    matchesUserTicketsRoute(req.path) ||
    matchesRoutePrefix(req.path, "/verify-ticket")
  ) {
    return true;
  }

  // TODO: Protect payment routes with user/admin authorization in the frontend auth flow phase.
  if (matchesRoutePrefix(req.path, "/payments") || matchesBookingPaymentsRoute(req.path)) {
    return true;
  }

  // TODO: Protect notification routes with user/admin authorization in the frontend auth flow phase.
  if (matchesRoutePrefix(req.path, "/notifications")) {
    return true;
  }

  // TODO: Protect audit routes with admin/security-dashboard authorization in the dashboard phase.
  if (matchesRoutePrefix(req.path, "/audit")) {
    return true;
  }

  // TODO: Protect saga orchestration with authenticated user context in the frontend auth flow phase.
  if (matchesRoutePrefix(req.path, "/sagas")) {
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

function sanitizeGatewayPath(path) {
  return String(path)
    .replace(/\/verify-ticket\/[^/?#]+/g, "/verify-ticket/[token]")
    .replace(/\/tickets\/verify\/[^/?#]+/g, "/tickets/verify/[token]");
}

function matchesRoutePrefix(path, prefix) {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function matchesUserBookingsRoute(path) {
  return /^\/users\/[^/]+\/bookings\/?$/.test(path);
}

function matchesBookingTicketsRoute(path) {
  return /^\/bookings\/[^/]+\/tickets\/?$/.test(path);
}

function matchesBookingPaymentsRoute(path) {
  return /^\/bookings\/[^/]+\/payments\/?$/.test(path);
}

function matchesPaymentStatusRoute(path) {
  return /^\/payments\/booking\/[^/]+\/status\/?$/.test(path);
}

function matchesNotificationBookingRoute(path) {
  return /^\/notifications\/booking\/[^/]+\/?$/.test(path);
}

function matchesUserTicketsRoute(path) {
  return /^\/users\/[^/]+\/tickets\/?$/.test(path);
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
    pathFilter: (path) => matchesRoutePrefix(path, "/venues"),
    target: EVENTS_SERVICE_URL,
    changeOrigin: true,
    on: {
      error: eventsServiceUnavailable
    }
  })
);

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
    pathFilter: (path) => matchesRoutePrefix(path, "/sagas"),
    target: SAGA_SERVICE_URL,
    changeOrigin: true,
    on: {
      error: sagaServiceUnavailable
    }
  })
);

app.use(
  createProxyMiddleware({
    pathFilter: (path) => matchesRoutePrefix(path, "/verify-ticket"),
    target: TICKET_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: {
      "^/verify-ticket": "/tickets/verify"
    },
    on: {
      error: ticketServiceUnavailable
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

app.use(
  createProxyMiddleware({
    pathFilter: (path) => matchesNotificationBookingRoute(path),
    target: NOTIFICATION_SERVICE_URL,
    changeOrigin: true,
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

app.use(
  createProxyMiddleware({
    pathFilter: (path) => matchesPaymentStatusRoute(path),
    target: PAYMENT_SERVICE_URL,
    changeOrigin: true,
    on: {
      error: paymentServiceUnavailable
    }
  })
);

app.use(
  createProxyMiddleware({
    pathFilter: (path) => matchesBookingPaymentsRoute(path),
    target: PAYMENT_SERVICE_URL,
    changeOrigin: true,
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

app.use(
  createProxyMiddleware({
    pathFilter: (path) => matchesBookingTicketsRoute(path),
    target: TICKET_SERVICE_URL,
    changeOrigin: true,
    on: {
      error: ticketServiceUnavailable
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
    on: {
      error: bookingServiceUnavailable
    }
  })
);

app.use(
  createProxyMiddleware({
    pathFilter: (path) => matchesUserTicketsRoute(path),
    target: TICKET_SERVICE_URL,
    changeOrigin: true,
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

app.listen(PORT, () => {
  console.log(`API Gateway running on port ${PORT}`);
});
