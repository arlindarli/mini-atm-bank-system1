const express = require("express");
const cors = require("cors");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const db = require("./db");
require("dotenv").config();
const app = express();

app.use(cors());
app.use(express.json());
function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    return res.status(401).json({ message: "Access denied. No token provided." });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(403).json({ message: "Invalid or expired token" });
  }
}
app.get("/", (req, res) => {
  res.send("Mini ATM Bank API is running");
});
app.get("/accounts", (req, res) => {
  res.json(accounts);
});
 app.post("/register", async (req, res) => {
  const { fullName, email, password, pin } = req.body;

  if (!fullName || !email || !password || !pin) {
    return res.status(400).json({ message: "All fields are required" });
  }

  const existingUser = db
    .prepare("SELECT * FROM users WHERE email = ?")
    .get(email);

  if (existingUser) {
    return res.status(400).json({ message: "Email already registered" });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const pinHash = await bcrypt.hash(pin, 10);

  const userResult = db
    .prepare("INSERT INTO users (full_name, email, password_hash) VALUES (?, ?, ?)")
    .run(fullName, email, passwordHash);

  const userId = userResult.lastInsertRowid;

  const accountNumber = String(100000 + userId);

  const accountResult = db
    .prepare(
      "INSERT INTO accounts (user_id, account_number, pin_hash, balance) VALUES (?, ?, ?, ?)"
    )
    .run(userId, accountNumber, pinHash, 0);

  res.status(201).json({
    message: "User registered successfully",
    user: {
      id: userId,
      fullName,
      email
    },
    account: {
      id: accountResult.lastInsertRowid,
      accountNumber,
      balance: 0
    }
  });
});
app.post("/login", async (req, res) => {
  const { email, password, pin } = req.body;

  if (!email || !password || !pin) {
    return res.status(400).json({ message: "Email, password and PIN are required" });
  }

  const user = db
    .prepare("SELECT * FROM users WHERE email = ?")
    .get(email);

  if (!user) {
    return res.status(404).json({ message: "User not found" });
  }

  const isPasswordCorrect = await bcrypt.compare(password, user.password_hash);

  if (!isPasswordCorrect) {
    return res.status(401).json({ message: "Invalid password" });
  }

  const account = db
    .prepare("SELECT * FROM accounts WHERE user_id = ?")
    .get(user.id);

  if (!account) {
    return res.status(404).json({ message: "Account not found" });
  }

  const isPinCorrect = await bcrypt.compare(pin, account.pin_hash);

  if (!isPinCorrect) {
    return res.status(401).json({ message: "Invalid PIN" });
  }

  const token = jwt.sign(
    {
      userId: user.id,
      email: user.email,
      accountNumber: account.account_number
    },
    process.env.JWT_SECRET,
    { expiresIn: "1h" }
  );

  res.json({
    message: "Login successful",
    token,
    user: {
      id: user.id,
      fullName: user.full_name,
      email: user.email
    },
    account: {
      accountNumber: account.account_number,
      balance: account.balance
    }
  });
});
app.post("/withdraw", authenticateToken, (req, res) => {
  const { accountNumber, amount } = req.body;

  if (req.user.accountNumber !== accountNumber) {
    return res.status(403).json({ message: "You can only access your own account" });
  }

  if (amount <= 0) {
    return res.status(400).json({ message: "Amount must be greater than 0" });
  }

  const account = db
    .prepare("SELECT * FROM accounts WHERE account_number = ?")
    .get(accountNumber);

  if (!account) {
    return res.status(404).json({ message: "Account not found" });
  }

  if (amount > account.balance) {
    return res.status(400).json({ message: "Insufficient funds" });
  }

  const newBalance = account.balance - amount;

  const withdrawTransaction = db.transaction(() => {
    db.prepare("UPDATE accounts SET balance = ? WHERE id = ?")
      .run(newBalance, account.id);

    db.prepare(
      "INSERT INTO transactions (account_id, type, amount, balance_after) VALUES (?, ?, ?, ?)"
    ).run(account.id, "withdraw", amount, newBalance);
  });

  withdrawTransaction();

  res.json({
    message: "Withdraw successful",
    account: {
      accountNumber: account.account_number,
      balance: newBalance
    },
    transaction: {
      type: "withdraw",
      amount,
      balanceAfter: newBalance
    }
  });
});
app.post("/transfer", authenticateToken, (req, res) => {
  const { fromAccountNumber, toAccountNumber, amount } = req.body;

  if (req.user.accountNumber !== fromAccountNumber) {
    return res.status(403).json({ message: "You can only send money from your own account" });
  }

  if (!toAccountNumber || amount <= 0) {
    return res.status(400).json({ message: "Receiver account and valid amount are required" });
  }

  if (fromAccountNumber === toAccountNumber) {
    return res.status(400).json({ message: "You cannot send money to the same account" });
  }

  const fromAccount = db
    .prepare("SELECT * FROM accounts WHERE account_number = ?")
    .get(fromAccountNumber);

  const toAccount = db
    .prepare("SELECT * FROM accounts WHERE account_number = ?")
    .get(toAccountNumber);

  if (!fromAccount) {
    return res.status(404).json({ message: "Sender account not found" });
  }

  if (!toAccount) {
    return res.status(404).json({ message: "Receiver account not found" });
  }

  if (amount > fromAccount.balance) {
    return res.status(400).json({ message: "Insufficient funds" });
  }

  const newSenderBalance = fromAccount.balance - amount;
  const newReceiverBalance = toAccount.balance + amount;

  const transferTransaction = db.transaction(() => {
    db.prepare("UPDATE accounts SET balance = ? WHERE id = ?")
      .run(newSenderBalance, fromAccount.id);

    db.prepare("UPDATE accounts SET balance = ? WHERE id = ?")
      .run(newReceiverBalance, toAccount.id);

    db.prepare(
      "INSERT INTO transactions (account_id, type, amount, balance_after) VALUES (?, ?, ?, ?)"
    ).run(fromAccount.id, "transfer sent", amount, newSenderBalance);

    db.prepare(
      "INSERT INTO transactions (account_id, type, amount, balance_after) VALUES (?, ?, ?, ?)"
    ).run(toAccount.id, "transfer received", amount, newReceiverBalance);
  });

  transferTransaction();

  res.json({
    message: "Transfer successful",
    account: {
      accountNumber: fromAccount.account_number,
      balance: newSenderBalance
    },
    transfer: {
      from: fromAccount.account_number,
      to: toAccount.account_number,
      amount
    }
  });
});
app.get("/transactions/:accountNumber", authenticateToken, (req, res) => {
  const { accountNumber } = req.params;

  if (req.user.accountNumber !== accountNumber) {
    return res.status(403).json({ message: "You can only view your own transactions" });
  }

  const account = db
    .prepare("SELECT * FROM accounts WHERE account_number = ?")
    .get(accountNumber);

  if (!account) {
    return res.status(404).json({ message: "Account not found" });
  }

  const accountTransactions = db
    .prepare(
      "SELECT type, amount, balance_after, timestamp FROM transactions WHERE account_id = ? ORDER BY timestamp DESC"
    )
    .all(account.id);

  res.json(accountTransactions);
});
app.post("/deposit", authenticateToken, (req, res) => {
  const { accountNumber, amount } = req.body;

  if (req.user.accountNumber !== accountNumber) {
    return res.status(403).json({ message: "You can only access your own account" });
  }

  if (amount <= 0) {
    return res.status(400).json({ message: "Amount must be greater than 0" });
  }

  const account = db
    .prepare("SELECT * FROM accounts WHERE account_number = ?")
    .get(accountNumber);

  if (!account) {
    return res.status(404).json({ message: "Account not found" });
  }

  const newBalance = account.balance + amount;

  const depositTransaction = db.transaction(() => {
    db.prepare("UPDATE accounts SET balance = ? WHERE id = ?")
      .run(newBalance, account.id);

    db.prepare(
      "INSERT INTO transactions (account_id, type, amount, balance_after) VALUES (?, ?, ?, ?)"
    ).run(account.id, "deposit", amount, newBalance);
  });

  depositTransaction();

  res.json({
    message: "Deposit successful",
    account: {
      accountNumber: account.account_number,
      balance: newBalance
    },
    transaction: {
      type: "deposit",
      amount,
      balanceAfter: newBalance
    }
  });
});
const PORT = process.env.PORT || 3000;
app.get("/db-test", (req, res) => {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all();

  res.json({
    message: "Database connected successfully",
    tables
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});