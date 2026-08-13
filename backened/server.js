const express = require("express");
const cors = require("cors");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const path = require("path");
const db = require("./db");

require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.json());

/* =========================
   AUTH MIDDLEWARE
========================= */

function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    return res.status(401).json({
      message: "Access denied. No token provided."
    });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(403).json({
      message: "Invalid or expired token"
    });
  }
}

/* =========================
   BASIC ROUTES
========================= */

app.get("/api", (req, res) => {
  res.json({
    message: "Mini ATM Bank API is running"
  });
});

app.get("/db-test", async (req, res) => {
  try {
    const result = await db.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);

    res.json({
      message: "PostgreSQL database connected successfully",
      tables: result.rows
    });
  } catch (error) {
    console.error("DB TEST ERROR:", error);

    res.status(500).json({
      message: "Database connection failed"
    });
  }
});

/* =========================
   REGISTER
========================= */

app.post("/register", async (req, res) => {
  const client = await db.connect();

  try {
    const { fullName, email, password, pin } = req.body;

    if (!fullName || !email || !password || !pin) {
      return res.status(400).json({
        message: "All fields are required"
      });
    }

    if (String(pin).length < 4) {
      return res.status(400).json({
        message: "PIN must contain at least 4 characters"
      });
    }

    const existingUserResult = await client.query(
      "SELECT id FROM users WHERE email = $1",
      [email.trim().toLowerCase()]
    );

    if (existingUserResult.rows.length > 0) {
      return res.status(400).json({
        message: "Email already registered"
      });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const pinHash = await bcrypt.hash(String(pin), 10);

    await client.query("BEGIN");

    const userResult = await client.query(
      `
      INSERT INTO users (
        full_name,
        email,
        password_hash
      )
      VALUES ($1, $2, $3)
      RETURNING id
      `,
      [
        fullName.trim(),
        email.trim().toLowerCase(),
        passwordHash
      ]
    );

    const userId = userResult.rows[0].id;

    const accountNumber = String(100000 + Number(userId));

    const accountResult = await client.query(
      `
      INSERT INTO accounts (
        user_id,
        account_number,
        pin_hash,
        balance
      )
      VALUES ($1, $2, $3, $4)
      RETURNING id, account_number, balance
      `,
      [
        userId,
        accountNumber,
        pinHash,
        0
      ]
    );

    await client.query("COMMIT");

    const account = accountResult.rows[0];

    return res.status(201).json({
      message: "User registered successfully",

      user: {
        id: userId,
        fullName,
        email: email.trim().toLowerCase()
      },

      account: {
        id: account.id,
        accountNumber: account.account_number,
        balance: Number(account.balance)
      }
    });

  } catch (error) {
    await client.query("ROLLBACK");

    console.error("REGISTER ERROR:", error);

    return res.status(500).json({
      message: "Server error"
    });

  } finally {
    client.release();
  }
});

/* =========================
   LOGIN
========================= */

app.post("/login", async (req, res) => {
  try {
    const { email, password, pin } = req.body;

    if (!email || !password || !pin) {
      return res.status(400).json({
        message: "Email, password and PIN are required"
      });
    }

    const userResult = await db.query(
      `
      SELECT *
      FROM users
      WHERE email = $1
      `,
      [email.trim().toLowerCase()]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({
        message: "User not found"
      });
    }

    const user = userResult.rows[0];

    const isPasswordCorrect = await bcrypt.compare(
      password,
      user.password_hash
    );

    if (!isPasswordCorrect) {
      return res.status(401).json({
        message: "Invalid password"
      });
    }

    const accountResult = await db.query(
      `
      SELECT *
      FROM accounts
      WHERE user_id = $1
      `,
      [user.id]
    );

    if (accountResult.rows.length === 0) {
      return res.status(404).json({
        message: "Account not found"
      });
    }

    const account = accountResult.rows[0];

    const isPinCorrect = await bcrypt.compare(
      String(pin),
      account.pin_hash
    );

    if (!isPinCorrect) {
      return res.status(401).json({
        message: "Invalid PIN"
      });
    }

    const token = jwt.sign(
      {
        userId: user.id,
        email: user.email,
        accountNumber: account.account_number
      },
      process.env.JWT_SECRET,
      {
        expiresIn: "1h"
      }
    );

    return res.json({
      message: "Login successful",

      token,

      user: {
        id: user.id,
        fullName: user.full_name,
        email: user.email
      },

      account: {
        accountNumber: account.account_number,
        balance: Number(account.balance)
      }
    });

  } catch (error) {
    console.error("LOGIN ERROR:", error);

    return res.status(500).json({
      message: "Server error"
    });
  }
});

/* =========================
   DEPOSIT
========================= */

app.post("/deposit", authenticateToken, async (req, res) => {
  const client = await db.connect();

  try {
    const { accountNumber, amount } = req.body;

    const numericAmount = Number(amount);

    if (req.user.accountNumber !== accountNumber) {
      return res.status(403).json({
        message: "You can only access your own account"
      });
    }

    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      return res.status(400).json({
        message: "Amount must be greater than 0"
      });
    }

    await client.query("BEGIN");

    const accountResult = await client.query(
      `
      SELECT *
      FROM accounts
      WHERE account_number = $1
      FOR UPDATE
      `,
      [accountNumber]
    );

    if (accountResult.rows.length === 0) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        message: "Account not found"
      });
    }

    const account = accountResult.rows[0];

    const currentBalance = Number(account.balance);
    const newBalance = currentBalance + numericAmount;

    await client.query(
      `
      UPDATE accounts
      SET balance = $1
      WHERE id = $2
      `,
      [
        newBalance,
        account.id
      ]
    );

    await client.query(
      `
      INSERT INTO transactions (
        account_id,
        type,
        amount,
        balance_after
      )
      VALUES ($1, $2, $3, $4)
      `,
      [
        account.id,
        "deposit",
        numericAmount,
        newBalance
      ]
    );

    await client.query("COMMIT");

    return res.json({
      message: "Deposit successful",

      account: {
        accountNumber: account.account_number,
        balance: newBalance
      },

      transaction: {
        type: "deposit",
        amount: numericAmount,
        balanceAfter: newBalance
      }
    });

  } catch (error) {
    await client.query("ROLLBACK");

    console.error("DEPOSIT ERROR:", error);

    return res.status(500).json({
      message: "Server error"
    });

  } finally {
    client.release();
  }
});

/* =========================
   WITHDRAW
========================= */

app.post("/withdraw", authenticateToken, async (req, res) => {
  const client = await db.connect();

  try {
    const { accountNumber, amount } = req.body;

    const numericAmount = Number(amount);

    if (req.user.accountNumber !== accountNumber) {
      return res.status(403).json({
        message: "You can only access your own account"
      });
    }

    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      return res.status(400).json({
        message: "Amount must be greater than 0"
      });
    }

    await client.query("BEGIN");

    const accountResult = await client.query(
      `
      SELECT *
      FROM accounts
      WHERE account_number = $1
      FOR UPDATE
      `,
      [accountNumber]
    );

    if (accountResult.rows.length === 0) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        message: "Account not found"
      });
    }

    const account = accountResult.rows[0];

    const currentBalance = Number(account.balance);

    if (numericAmount > currentBalance) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        message: "Insufficient funds"
      });
    }

    const newBalance = currentBalance - numericAmount;

    await client.query(
      `
      UPDATE accounts
      SET balance = $1
      WHERE id = $2
      `,
      [
        newBalance,
        account.id
      ]
    );

    await client.query(
      `
      INSERT INTO transactions (
        account_id,
        type,
        amount,
        balance_after
      )
      VALUES ($1, $2, $3, $4)
      `,
      [
        account.id,
        "withdraw",
        numericAmount,
        newBalance
      ]
    );

    await client.query("COMMIT");

    return res.json({
      message: "Withdraw successful",

      account: {
        accountNumber: account.account_number,
        balance: newBalance
      },

      transaction: {
        type: "withdraw",
        amount: numericAmount,
        balanceAfter: newBalance
      }
    });

  } catch (error) {
    await client.query("ROLLBACK");

    console.error("WITHDRAW ERROR:", error);

    return res.status(500).json({
      message: "Server error"
    });

  } finally {
    client.release();
  }
});

/* =========================
   TRANSFER
========================= */

app.post("/transfer", authenticateToken, async (req, res) => {
  const client = await db.connect();

  try {
    const {
      fromAccountNumber,
      toAccountNumber,
      amount
    } = req.body;

    const numericAmount = Number(amount);

    if (req.user.accountNumber !== fromAccountNumber) {
      return res.status(403).json({
        message: "You can only send money from your own account"
      });
    }

    if (
      !toAccountNumber ||
      !Number.isFinite(numericAmount) ||
      numericAmount <= 0
    ) {
      return res.status(400).json({
        message: "Receiver account and valid amount are required"
      });
    }

    if (fromAccountNumber === toAccountNumber) {
      return res.status(400).json({
        message: "You cannot send money to the same account"
      });
    }

    await client.query("BEGIN");

    const fromAccountResult = await client.query(
      `
      SELECT *
      FROM accounts
      WHERE account_number = $1
      FOR UPDATE
      `,
      [fromAccountNumber]
    );

    if (fromAccountResult.rows.length === 0) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        message: "Sender account not found"
      });
    }

    const toAccountResult = await client.query(
      `
      SELECT *
      FROM accounts
      WHERE account_number = $1
      FOR UPDATE
      `,
      [toAccountNumber]
    );

    if (toAccountResult.rows.length === 0) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        message: "Receiver account not found"
      });
    }

    const fromAccount = fromAccountResult.rows[0];
    const toAccount = toAccountResult.rows[0];

    const senderBalance = Number(fromAccount.balance);
    const receiverBalance = Number(toAccount.balance);

    if (numericAmount > senderBalance) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        message: "Insufficient funds"
      });
    }

    const newSenderBalance = senderBalance - numericAmount;
    const newReceiverBalance = receiverBalance + numericAmount;

    await client.query(
      `
      UPDATE accounts
      SET balance = $1
      WHERE id = $2
      `,
      [
        newSenderBalance,
        fromAccount.id
      ]
    );

    await client.query(
      `
      UPDATE accounts
      SET balance = $1
      WHERE id = $2
      `,
      [
        newReceiverBalance,
        toAccount.id
      ]
    );

    await client.query(
      `
      INSERT INTO transactions (
        account_id,
        type,
        amount,
        balance_after
      )
      VALUES ($1, $2, $3, $4)
      `,
      [
        fromAccount.id,
        "transfer sent",
        numericAmount,
        newSenderBalance
      ]
    );

    await client.query(
      `
      INSERT INTO transactions (
        account_id,
        type,
        amount,
        balance_after
      )
      VALUES ($1, $2, $3, $4)
      `,
      [
        toAccount.id,
        "transfer received",
        numericAmount,
        newReceiverBalance
      ]
    );

    await client.query("COMMIT");

    return res.json({
      message: "Transfer successful",

      account: {
        accountNumber: fromAccount.account_number,
        balance: newSenderBalance
      },

      transfer: {
        from: fromAccount.account_number,
        to: toAccount.account_number,
        amount: numericAmount
      }
    });

  } catch (error) {
    await client.query("ROLLBACK");

    console.error("TRANSFER ERROR:", error);

    return res.status(500).json({
      message: "Server error"
    });

  } finally {
    client.release();
  }
});

/* =========================
   TRANSACTION HISTORY
========================= */

app.get(
  "/transactions/:accountNumber",
  authenticateToken,
  async (req, res) => {
    try {
      const { accountNumber } = req.params;

      if (req.user.accountNumber !== accountNumber) {
        return res.status(403).json({
          message: "You can only view your own transactions"
        });
      }

      const accountResult = await db.query(
        `
        SELECT *
        FROM accounts
        WHERE account_number = $1
        `,
        [accountNumber]
      );

      if (accountResult.rows.length === 0) {
        return res.status(404).json({
          message: "Account not found"
        });
      }

      const account = accountResult.rows[0];

      const transactionsResult = await db.query(
        `
        SELECT
          type,
          amount,
          balance_after,
          timestamp
        FROM transactions
        WHERE account_id = $1
        ORDER BY timestamp DESC
        `,
        [account.id]
      );

      const transactions = transactionsResult.rows.map((tx) => ({
        type: tx.type,
        amount: Number(tx.amount),
        balance_after: Number(tx.balance_after),
        timestamp: tx.timestamp
      }));

      return res.json(transactions);

    } catch (error) {
      console.error("TRANSACTIONS ERROR:", error);

      return res.status(500).json({
        message: "Server error"
      });
    }
  }
);

/* =========================
   SERVE FRONTEND
========================= */

const frontendPath = path.join(__dirname, "fronted");

app.use(express.static(frontendPath));

app.get("/{*splat}", (req, res, next) => {
  if (
    req.path.startsWith("/register") ||
    req.path.startsWith("/login") ||
    req.path.startsWith("/deposit") ||
    req.path.startsWith("/withdraw") ||
    req.path.startsWith("/transfer") ||
    req.path.startsWith("/transactions") ||
    req.path.startsWith("/db-test") ||
    req.path.startsWith("/api")
  ) {
    return next();
  }

  res.sendFile(path.join(frontendPath, "index.html"));
});

/* =========================
   LOCAL SERVER
========================= */

const PORT = process.env.PORT || 3000;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

module.exports = app;