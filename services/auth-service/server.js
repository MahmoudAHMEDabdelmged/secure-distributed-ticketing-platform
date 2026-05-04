const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const { query } = require("./db");
require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || "dev_secret_change_me";

const allowedRoles = ["user", "admin", "organizer"];

function isValidEmail(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function toSafeUser(user) {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    createdAt: user.created_at,
    updatedAt: user.updated_at
  };
}

function createToken(user) {
  return jwt.sign(
    {
      id: user.id,
      sub: user.id,
      email: user.email,
      role: user.role
    },
    JWT_SECRET,
    {
      expiresIn: "1h"
    }
  );
}

app.get("/health", (req, res) => {
  res.json({
    service: "auth-service",
    status: "healthy",
    timestamp: new Date().toISOString()
  });
});

app.post("/register", async (req, res) => {
  try {
    const { password, role = "user" } = req.body;
    const email = typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : "";

    if (!isValidEmail(email) || !password) {
      return res.status(400).json({
        error: "A valid email and password are required"
      });
    }

    if (!allowedRoles.includes(role)) {
      return res.status(400).json({
        error: "Invalid role"
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
      `insert into public.users (email, password_hash, role)
       values ($1, $2, $3)
       returning id, email, role, created_at, updated_at`,
      [email, hashedPassword, role]
    );

    return res.status(201).json({
      message: "User registered successfully",
      user: toSafeUser(result.rows[0])
    });
  } catch (error) {
    console.error("Registration failed:", error);

    if (error.code === "23505") {
      return res.status(409).json({
        error: "User already exists"
      });
    }

    return res.status(500).json({
      error: "Registration failed"
    });
  }
});

app.post("/login", async (req, res) => {
  try {
    const { password } = req.body;
    const email = typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : "";

    if (!isValidEmail(email) || !password) {
      return res.status(400).json({
        error: "A valid email and password are required"
      });
    }

    const result = await query(
      `select id, email, password_hash, role, created_at, updated_at
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

    const token = createToken(user);

    return res.json({
      message: "Login successful",
      token,
      user: toSafeUser(user)
    });
  } catch (error) {
    console.error("Login failed:", error);

    return res.status(500).json({
      error: "Login failed"
    });
  }
});

app.get("/profile", async (req, res) => {
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
      `select id, email, role, created_at, updated_at
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
    console.error("Profile lookup failed:", error);

    if (error.name === "JsonWebTokenError" || error.name === "TokenExpiredError") {
      return res.status(403).json({
        error: "Invalid or expired token"
      });
    }

    return res.status(500).json({
      error: "Profile lookup failed"
    });
  }
});

app.use((error, req, res, next) => {
  console.error("Unhandled auth-service error:", error);

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
  console.log(`Auth Service running on port ${PORT}`);
});
