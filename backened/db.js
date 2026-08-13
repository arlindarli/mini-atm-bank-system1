const { Pool } = require("pg");

const connectionString =
  process.env.DATABASE_URL ||
  process.env.STORAGE_URL;

const db = new Pool({
  connectionString,
  ssl: {
    rejectUnauthorized: false
  }
});

async function initDatabase() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      full_name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS accounts (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      account_number TEXT UNIQUE NOT NULL,
      pin_hash TEXT NOT NULL,
      balance NUMERIC(12,2) NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS transactions (
      id SERIAL PRIMARY KEY,
      account_id INTEGER NOT NULL REFERENCES accounts(id),
      type TEXT NOT NULL,
      amount NUMERIC(12,2) NOT NULL,
      balance_after NUMERIC(12,2) NOT NULL,
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

initDatabase()
  .then(() => {
    console.log("PostgreSQL database initialized");
  })
  .catch((error) => {
    console.error("Database initialization error:", error);
  });

module.exports = db;