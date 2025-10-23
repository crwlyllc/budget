const express = require('express');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

const dataDir = path.join(__dirname, 'data');
const dbPath = path.join(dataDir, 'budget.sqlite');

fs.mkdirSync(dataDir, { recursive: true });

const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  db.run('PRAGMA foreign_keys = ON');
  db.run(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      starting_balance REAL NOT NULL DEFAULT 0,
      position INTEGER NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('income', 'expense')),
      name TEXT NOT NULL,
      amount REAL NOT NULL,
      start_date TEXT NOT NULL,
      frequency TEXT NOT NULL,
      FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE
    )
  `);
});

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (error) {
      if (error) {
        reject(error);
      } else {
        resolve({ lastID: this.lastID, changes: this.changes });
      }
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => {
      if (error) {
        reject(error);
      } else {
        resolve(row);
      }
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => {
      if (error) {
        reject(error);
      } else {
        resolve(rows);
      }
    });
  });
}

app.use(express.json());
app.use(express.static(__dirname));

app.get('/api/accounts', async (req, res) => {
  try {
    const accountRows = await all(
      `SELECT id, name, starting_balance AS startingBalance, position FROM accounts ORDER BY position ASC`
    );
    const txnRows = await all(
      `SELECT id, account_id AS accountId, type, name, amount, start_date AS startDate, frequency FROM transactions ORDER BY start_date ASC, name ASC, id ASC`
    );

    const accounts = accountRows.map((account) => {
      const transactions = txnRows
        .filter((txn) => txn.accountId === account.id)
        .map((txn) => ({
          id: txn.id,
          type: txn.type,
          name: txn.name,
          amount: Number(txn.amount) || 0,
          startDate: txn.startDate,
          frequency: txn.frequency
        }));

      return {
        id: account.id,
        name: account.name,
        startingBalance: Number(account.startingBalance) || 0,
        transactions
      };
    });

    res.json({ accounts });
  } catch (error) {
    console.error('Failed to fetch accounts', error);
    res.status(500).json({ error: 'Failed to load accounts' });
  }
});

app.post('/api/accounts', async (req, res) => {
  try {
    const { name } = req.body || {};
    const positionRow = await get('SELECT COALESCE(MAX(position), -1) AS maxPosition FROM accounts');
    const position = (positionRow?.maxPosition ?? -1) + 1;
    const trimmed = typeof name === 'string' ? name.trim() : '';
    const label = trimmed || `Account ${position + 1}`;
    const id = crypto.randomUUID();

    await run('INSERT INTO accounts (id, name, starting_balance, position) VALUES (?, ?, 0, ?)', [
      id,
      label,
      position
    ]);

    res.status(201).json({
      account: {
        id,
        name: label,
        startingBalance: 0,
        transactions: []
      }
    });
  } catch (error) {
    console.error('Failed to create account', error);
    res.status(500).json({ error: 'Failed to create account' });
  }
});

app.put('/api/accounts/:id', async (req, res) => {
  const { name, startingBalance } = req.body || {};
  const updates = [];
  const params = [];

  if (typeof name === 'string') {
    const trimmed = name.trim();
    if (trimmed) {
      updates.push('name = ?');
      params.push(trimmed);
    }
  }

  if (startingBalance !== undefined) {
    const value = Number.parseFloat(startingBalance);
    if (!Number.isFinite(value)) {
      return res.status(400).json({ error: 'startingBalance must be a number' });
    }
    updates.push('starting_balance = ?');
    params.push(value);
  }

  if (!updates.length) {
    return res.status(400).json({ error: 'No valid fields to update' });
  }

  params.push(req.params.id);

  try {
    const result = await run(`UPDATE accounts SET ${updates.join(', ')} WHERE id = ?`, params);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Account not found' });
    }

    const account = await get('SELECT id, name, starting_balance FROM accounts WHERE id = ?', [
      req.params.id
    ]);

    res.json({
      account: {
        id: account.id,
        name: account.name,
        startingBalance: Number(account.starting_balance) || 0
      }
    });
  } catch (error) {
    console.error('Failed to update account', error);
    res.status(500).json({ error: 'Failed to update account' });
  }
});

app.delete('/api/accounts/:id', async (req, res) => {
  try {
    const result = await run('DELETE FROM accounts WHERE id = ?', [req.params.id]);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Account not found' });
    }

    const rows = await all('SELECT id, position FROM accounts ORDER BY position ASC');
    await Promise.all(
      rows.map((row, index) => run('UPDATE accounts SET position = ? WHERE id = ?', [index, row.id]))
    );

    res.status(204).end();
  } catch (error) {
    console.error('Failed to delete account', error);
    res.status(500).json({ error: 'Failed to delete account' });
  }
});

app.post('/api/accounts/:id/transactions', async (req, res) => {
  try {
    const accountId = req.params.id;
    const account = await get('SELECT id FROM accounts WHERE id = ?', [accountId]);
    if (!account) {
      return res.status(404).json({ error: 'Account not found' });
    }

    const { type, name, amount, startDate, frequency } = req.body || {};
    const trimmedName = typeof name === 'string' ? name.trim() : '';
    const entryType = type === 'expense' ? 'expense' : 'income';
    const parsedAmount = Number.parseFloat(amount);
    const start = typeof startDate === 'string' ? startDate : '';
    const freq = typeof frequency === 'string' && frequency.trim() ? frequency.trim() : 'single';

    if (!trimmedName) {
      return res.status(400).json({ error: 'name is required' });
    }

    if (!Number.isFinite(parsedAmount)) {
      return res.status(400).json({ error: 'amount must be a number' });
    }

    if (!start) {
      return res.status(400).json({ error: 'startDate is required' });
    }

    const transactionId = crypto.randomUUID();

    await run(
      `INSERT INTO transactions (id, account_id, type, name, amount, start_date, frequency) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [transactionId, accountId, entryType, trimmedName, parsedAmount, start, freq]
    );

    res.status(201).json({
      transaction: {
        id: transactionId,
        type: entryType,
        name: trimmedName,
        amount: Math.round(parsedAmount * 100) / 100,
        startDate: start,
        frequency: freq
      }
    });
  } catch (error) {
    console.error('Failed to create transaction', error);
    res.status(500).json({ error: 'Failed to create transaction' });
  }
});

app.delete('/api/transactions/:id', async (req, res) => {
  try {
    const result = await run('DELETE FROM transactions WHERE id = ?', [req.params.id]);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    res.status(204).end();
  } catch (error) {
    console.error('Failed to delete transaction', error);
    res.status(500).json({ error: 'Failed to delete transaction' });
  }
});

app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const server = app.listen(PORT, () => {
  console.log(`Budget app server listening on http://localhost:${PORT}`);
});

function shutdown() {
  server.close(() => {
    db.close(() => {
      process.exit(0);
    });
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
