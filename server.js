const http = require('node:http');
const { readFile, writeFile, mkdir, stat } = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const PORT = Number(process.env.PORT) || 3000;
const ROOT_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, 'data');
const DB_PATH = path.join(DATA_DIR, 'budget.json');

let state = { accounts: [] };
let isSaving = Promise.resolve();

async function ensureDataDir() {
  try {
    await mkdir(DATA_DIR, { recursive: true });
  } catch (error) {
    if (error.code !== 'EEXIST') {
      throw error;
    }
  }
}

function normalizeState(raw) {
  if (!raw || typeof raw !== 'object') {
    return { accounts: [] };
  }

  const accounts = Array.isArray(raw.accounts) ? raw.accounts : [];

  return {
    accounts: accounts
      .map((account, index) => {
        if (!account || typeof account !== 'object') {
          return null;
        }

        const id = typeof account.id === 'string' && account.id ? account.id : randomUUID();
        const name = typeof account.name === 'string' && account.name.trim() ? account.name.trim() : `Account ${index + 1}`;
        const position = Number.isInteger(account.position) ? account.position : index;
        const startingBalance = Number.isFinite(Number.parseFloat(account.startingBalance))
          ? Math.round(Number.parseFloat(account.startingBalance) * 100) / 100
          : 0;

        const transactions = Array.isArray(account.transactions)
          ? account.transactions
              .map((txn) => {
                if (!txn || typeof txn !== 'object') return null;
                const txnId = typeof txn.id === 'string' && txn.id ? txn.id : randomUUID();
                const type = txn.type === 'expense' ? 'expense' : 'income';
                const name = typeof txn.name === 'string' ? txn.name.trim() : '';
                const amount = Number.parseFloat(txn.amount);
                const startDate = typeof txn.startDate === 'string' ? txn.startDate : '';
                const frequency = typeof txn.frequency === 'string' && txn.frequency.trim() ? txn.frequency.trim() : 'single';

                if (!name || !startDate || !Number.isFinite(amount)) {
                  return null;
                }

                return {
                  id: txnId,
                  type,
                  name,
                  amount: Math.round(amount * 100) / 100,
                  startDate,
                  frequency
                };
              })
              .filter(Boolean)
          : [];

        return {
          id,
          name,
          startingBalance,
          position,
          transactions
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.position - b.position)
      .map((account, idx) => ({ ...account, position: idx }))
  };
}

async function loadState() {
  await ensureDataDir();
  try {
    const file = await readFile(DB_PATH, 'utf8');
    const parsed = JSON.parse(file);
    state = normalizeState(parsed);
  } catch (error) {
    if (error.code === 'ENOENT') {
      state = { accounts: [] };
      await saveState();
      return;
    }

    if (error instanceof SyntaxError) {
      console.error('Budget data file is corrupted. Reinitialising with empty data.');
      state = { accounts: [] };
      await saveState();
      return;
    }

    throw error;
  }
}

function persistState() {
  const payload = JSON.stringify(state, null, 2);
  return writeFile(DB_PATH, payload, 'utf8');
}

async function saveState() {
  // Queue writes to avoid clobbering the file when multiple requests arrive.
  isSaving = isSaving.then(() => persistState());
  try {
    await isSaving;
  } catch (error) {
    console.error('Failed to persist budget data', error);
    throw error;
  }
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function notFound(res, message = 'Not found') {
  json(res, 404, { error: message });
}

function methodNotAllowed(res) {
  json(res, 405, { error: 'Method not allowed' });
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw Object.assign(new Error('Invalid JSON body'), { statusCode: 400 });
  }
}

function sanitizeAccountResponse(account) {
  return {
    id: account.id,
    name: account.name,
    startingBalance: account.startingBalance,
    transactions: account.transactions
      .map((txn) => ({
        id: txn.id,
        type: txn.type,
        name: txn.name,
        amount: txn.amount,
        startDate: txn.startDate,
        frequency: txn.frequency
      }))
      .sort((a, b) => {
        if (a.startDate === b.startDate) {
          return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
        }
        return a.startDate.localeCompare(b.startDate);
      })
  };
}

function listAccounts() {
  return state.accounts
    .slice()
    .sort((a, b) => a.position - b.position)
    .map(sanitizeAccountResponse);
}

function findAccountIndex(id) {
  return state.accounts.findIndex((account) => account.id === id);
}

async function handleAccounts(req, res, segments) {
  if (segments.length === 2) {
    if (req.method === 'GET') {
      return json(res, 200, { accounts: listAccounts() });
    }

    if (req.method === 'POST') {
      const body = await readRequestBody(req);
      const name = typeof body?.name === 'string' ? body.name.trim() : '';
      const position = state.accounts.length;
      const account = {
        id: randomUUID(),
        name: name || `Account ${position + 1}`,
        startingBalance: 0,
        position,
        transactions: []
      };

      state.accounts.push(account);
      await saveState();

      return json(res, 201, { account: sanitizeAccountResponse(account) });
    }

    return methodNotAllowed(res);
  }

  if (segments.length === 3) {
    const accountId = segments[2];
    const index = findAccountIndex(accountId);
    if (index === -1) {
      return notFound(res, 'Account not found');
    }

    const account = state.accounts[index];

    if (req.method === 'PUT') {
      const body = await readRequestBody(req);
      const updates = {};

      if (typeof body?.name === 'string' && body.name.trim()) {
        updates.name = body.name.trim();
      }

      if (body?.startingBalance !== undefined) {
        const value = Number.parseFloat(body.startingBalance);
        if (!Number.isFinite(value)) {
          return json(res, 400, { error: 'startingBalance must be a number' });
        }
        updates.startingBalance = Math.round(value * 100) / 100;
      }

      if (!Object.keys(updates).length) {
        return json(res, 400, { error: 'No valid fields to update' });
      }

      state.accounts[index] = {
        ...account,
        ...updates
      };

      await saveState();
      return json(res, 200, { account: sanitizeAccountResponse(state.accounts[index]) });
    }

    if (req.method === 'DELETE') {
      state.accounts.splice(index, 1);
      state.accounts = state.accounts.map((acct, idx) => ({ ...acct, position: idx }));
      await saveState();
      res.writeHead(204);
      res.end();
      return;
    }

    return methodNotAllowed(res);
  }

  if (segments.length === 4 && segments[3] === 'transactions') {
    const accountId = segments[2];
    const index = findAccountIndex(accountId);

    if (index === -1) {
      return notFound(res, 'Account not found');
    }

    if (req.method !== 'POST') {
      return methodNotAllowed(res);
    }

    const body = await readRequestBody(req);
    const type = body?.type === 'expense' ? 'expense' : 'income';
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    const amount = Number.parseFloat(body?.amount);
    const startDate = typeof body?.startDate === 'string' ? body.startDate : '';
    const frequency = typeof body?.frequency === 'string' && body.frequency.trim() ? body.frequency.trim() : 'single';

    if (!name) {
      return json(res, 400, { error: 'name is required' });
    }

    if (!Number.isFinite(amount)) {
      return json(res, 400, { error: 'amount must be a number' });
    }

    if (!startDate) {
      return json(res, 400, { error: 'startDate is required' });
    }

    const transaction = {
      id: randomUUID(),
      type,
      name,
      amount: Math.round(amount * 100) / 100,
      startDate,
      frequency
    };

    state.accounts[index] = {
      ...state.accounts[index],
      transactions: [...state.accounts[index].transactions, transaction]
    };

    await saveState();
    return json(res, 201, { transaction });
  }

  return notFound(res);
}

async function handleTransactions(req, res, segments) {
  if (segments.length !== 3) {
    return notFound(res);
  }

  if (req.method !== 'DELETE') {
    return methodNotAllowed(res);
  }

  const txnId = segments[2];
  let removed = false;

  state.accounts = state.accounts.map((account) => {
    const filtered = account.transactions.filter((txn) => txn.id !== txnId);
    if (filtered.length !== account.transactions.length) {
      removed = true;
    }
    return { ...account, transactions: filtered };
  });

  if (!removed) {
    return notFound(res, 'Transaction not found');
  }

  await saveState();
  res.writeHead(204);
  res.end();
}

async function handleApi(req, res, url) {
  const segments = url.pathname.split('/').filter(Boolean);

  if (segments[1] === 'accounts') {
    return handleAccounts(req, res, segments);
  }

  if (segments[1] === 'transactions') {
    return handleTransactions(req, res, segments);
  }

  return notFound(res);
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon'
};

async function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return notFound(res);
  }

  let relativePath = url.pathname;

  if (relativePath === '/' || !relativePath) {
    relativePath = '/index.html';
  }

  const filePath = path.join(ROOT_DIR, path.normalize(relativePath));

  if (!filePath.startsWith(ROOT_DIR)) {
    return notFound(res);
  }

  try {
    const stats = await stat(filePath);
    if (stats.isDirectory()) {
      return notFound(res);
    }

    const ext = path.extname(filePath).toLowerCase();
    const type = MIME_TYPES[ext] || 'application/octet-stream';
    const body = req.method === 'HEAD' ? null : await readFile(filePath);

    const headers = {
      'Content-Type': type,
      'Cache-Control': 'no-cache'
    };

    if (body) {
      headers['Content-Length'] = body.length;
    }

    res.writeHead(200, headers);
    if (body) {
      res.end(body);
    } else {
      res.end();
    }
  } catch (error) {
    if (error.code === 'ENOENT') {
      if (!url.pathname.startsWith('/api/')) {
        try {
          const fallback = await readFile(path.join(ROOT_DIR, 'index.html'));
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-cache',
            'Content-Length': fallback.length
          });
          res.end(fallback);
          return;
        } catch (fallbackError) {
          console.error('Failed to load index.html fallback', fallbackError);
        }
      }
      return notFound(res);
    }

    console.error('Static asset error', error);
    json(res, 500, { error: 'Internal server error' });
  }
}

async function requestHandler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }

    await serveStatic(req, res, url);
  } catch (error) {
    const status = error.statusCode || 500;
    if (status >= 500) {
      console.error('Request handling error', error);
    }
    if (!res.headersSent) {
      json(res, status, { error: error.message || 'Internal server error' });
    } else {
      res.end();
    }
  }
}

async function start() {
  await loadState();
  const server = http.createServer((req, res) => {
    requestHandler(req, res);
  });

  server.listen(PORT, () => {
    console.log(`Budget app server listening on http://localhost:${PORT}`);
  });

  const shutdown = () => {
    server.close(() => {
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

start().catch((error) => {
  console.error('Failed to start server', error);
  process.exit(1);
});
