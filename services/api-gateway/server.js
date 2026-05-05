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
    "/booking-service/health/deep"
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

function matchesRoutePrefix(path, prefix) {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function matchesUserBookingsRoute(path) {
  return /^\/users\/[^/]+\/bookings\/?$/.test(path);
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

app.listen(PORT, () => {
  console.log(`API Gateway running on port ${PORT}`);
});
