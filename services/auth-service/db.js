const { Pool } = require("pg");
require("dotenv").config();

const connectionString = process.env.AUTH_DATABASE_URL;

if (!connectionString) {
  throw new Error("Missing required environment variable: AUTH_DATABASE_URL");
}

const pool = new Pool({
  connectionString,
  ssl: {
    rejectUnauthorized: false
  }
});

function query(text, params) {
  return pool.query(text, params);
}

module.exports = {
  pool,
  query
};
