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

function verifyToken(req, res, next) {
  const publicRoutes = [
    "/health",
    "/auth/health",
    "/auth/register",
    "/auth/login"
  ];

  if (publicRoutes.includes(req.path)) {
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

app.listen(PORT, () => {
  console.log(`API Gateway running on port ${PORT}`);
});
