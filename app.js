const frequencySteps = {
  single: { type: 'single' },
  weekly: { days: 7 },
  biweekly: { days: 14 },
  every14: { days: 14 },
  monthly: { months: 1 },
  quarterly: { months: 3 },
  semiannual: { months: 6 },
  annual: { months: 12 }
};

const frequencyLabels = {
  weekly: 'Weekly',
  biweekly: 'Biweekly',
  every14: 'Every 14 Days',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  semiannual: 'Every 6 Months',
  annual: 'Annually',
  single: 'One-time'
};

const state = {
  accounts: {},
  accountOrder: [],
  currentAccountId: null
};

const API_BASE = '/api';

async function api(path, options = {}) {
  const { body, headers, method = 'GET', ...rest } = options;
  const config = {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(headers || {})
    },
    ...rest
  };

  if (body !== undefined) {
    config.body = typeof body === 'string' ? body : JSON.stringify(body);
  }

  const response = await fetch(`${API_BASE}${path}`, config);
  const text = await response.text();
  let payload = null;

  if (text) {
    try {
      payload = JSON.parse(text);
    } catch (error) {
      console.error('Failed to parse API response', error);
    }
  }

  if (!response.ok) {
    const message = payload?.error || `Request failed with status ${response.status}`;
    throw new Error(message);
  }

  return payload;
}

function normalizeTransaction(raw) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const amount = Number.parseFloat(raw.amount);
  const type = raw.type === 'expense' ? 'expense' : 'income';
  const frequency = typeof raw.frequency === 'string' && raw.frequency ? raw.frequency : 'single';
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  const startDate = typeof raw.startDate === 'string' ? raw.startDate : '';

  if (!name || !startDate || !Number.isFinite(amount)) {
    return null;
  }

  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : createId(),
    type,
    name,
    amount: Math.round(amount * 100) / 100,
    startDate,
    frequency
  };
}

function normalizeAccount(raw) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const id = typeof raw.id === 'string' && raw.id ? raw.id : createId();
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : 'Account';
  const starting = Number.parseFloat(raw.startingBalance);
  const startingBalance = Number.isFinite(starting) ? Math.round(starting * 100) / 100 : 0;
  const transactions = Array.isArray(raw.transactions)
    ? raw.transactions.map((txn) => normalizeTransaction(txn)).filter(Boolean)
    : [];

  return {
    id,
    name,
    startingBalance,
    transactions
  };
}

function applyAccountsToState(list = []) {
  state.accounts = {};
  state.accountOrder = [];

  list.forEach((raw) => {
    const account = normalizeAccount(raw);
    if (!account) return;
    state.accounts[account.id] = account;
    state.accountOrder.push(account.id);
  });
}

async function loadAccounts() {
  try {
    const response = await api('/accounts');
    const accounts = Array.isArray(response?.accounts) ? response.accounts : [];
    applyAccountsToState(accounts);
  } catch (error) {
    console.error('Failed to load accounts from the server.', error);
    throw error;
  }
}

const els = {
  accountSelect: document.getElementById('account-select'),
  newAccountName: document.getElementById('new-account-name'),
  createAccountBtn: document.getElementById('create-account'),
  deleteAccountBtn: document.getElementById('delete-account'),
  startingInput: document.getElementById('starting-balance'),
  saveStartingBtn: document.getElementById('save-starting'),
  txnForm: document.getElementById('txn-form'),
  txnList: document.getElementById('txn-list'),
  ledgerContainer: document.getElementById('ledger-container')
};

function createId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `txn-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function formatCurrency(value) {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD'
  }).format(value);
}

function formatDate(date) {
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC'
  }).format(date);
}

function parseDateInput(value) {
  const parts = value?.split('-');
  if (!parts || parts.length !== 3) return null;
  const [y, m, d] = parts.map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function toDateInputValue(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function addDays(date, days) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function addMonths(date, months) {
  const next = new Date(date);
  const day = next.getUTCDate();
  next.setUTCMonth(next.getUTCMonth() + months, 1);
  const month = next.getUTCMonth();
  next.setUTCDate(Math.min(day, daysInMonth(next.getUTCFullYear(), month)));
  return next;
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

function generateOccurrences(txn, rangeEnd) {
  const occurrences = [];
  let current = parseDateInput(txn.startDate);
  if (!current) return occurrences;

  const end = new Date(rangeEnd);
  while (current <= end) {
    occurrences.push(new Date(current));
    const step = frequencySteps[txn.frequency] || frequencySteps.single;
    if (step.type === 'single' || txn.frequency === 'single') break;
    if (step.days) {
      current = addDays(current, step.days);
    } else if (step.months) {
      current = addMonths(current, step.months);
    } else {
      break;
    }
  }

  return occurrences;
}

function buildTransactionList(txns) {
  if (!txns.length) {
    els.txnList.innerHTML = '<div class="empty-state">No transactions yet. Add your income and expenses above.</div>';
    return;
  }

  const fragment = document.createDocumentFragment();
  [...txns]
    .sort((a, b) => a.name.localeCompare(b.name))
    .forEach((txn) => {
      const item = document.createElement('div');
      item.className = 'txn-item';

      const meta = document.createElement('div');
      meta.className = 'meta';

      const name = document.createElement('strong');
      name.textContent = txn.name;
      meta.appendChild(name);

      const amount = document.createElement('span');
      amount.textContent = `${txn.type === 'expense' ? '-' : '+'}${formatCurrency(txn.amount)}`;
      meta.appendChild(amount);

      const schedule = document.createElement('span');
      schedule.className = 'muted small';
      const frequencyLabel = frequencyLabels[txn.frequency] || capitalize(txn.frequency);
      schedule.textContent = `${frequencyLabel} starting ${formatDate(parseDateInput(txn.startDate))}`;
      meta.appendChild(schedule);

      item.appendChild(meta);

      const tag = document.createElement('span');
      tag.className = `tag ${txn.type}`;
      tag.textContent = txn.type;
      item.appendChild(tag);

      const removeBtn = document.createElement('button');
      removeBtn.className = 'danger';
      removeBtn.type = 'button';
      removeBtn.textContent = 'Delete';
      removeBtn.addEventListener('click', async () => {
        const account = getCurrentAccount();
        if (!account) return;

        try {
          await api(`/transactions/${txn.id}`, { method: 'DELETE' });
          account.transactions = account.transactions.filter((t) => t.id !== txn.id);
          buildTransactionList(account.transactions);
          regenerateLedger();
        } catch (error) {
          console.error('Failed to delete transaction', error);
          window.alert('Could not delete the transaction. Please try again.');
        }
      });
      item.appendChild(removeBtn);

      fragment.appendChild(item);
    });

  els.txnList.innerHTML = '';
  els.txnList.appendChild(fragment);
}

function capitalize(value) {
  if (!value) return '';
  return value.charAt(0).toUpperCase() + value.slice(1).replace(/([a-z])([A-Z])/g, '$1 $2');
}

function getCurrentAccount() {
  if (!state.currentAccountId) return null;
  return state.accounts[state.currentAccountId] || null;
}

function renderAccountOptions() {
  const { accountSelect, deleteAccountBtn } = els;
  accountSelect.innerHTML = '';

  state.accountOrder.forEach((id) => {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = state.accounts[id].name;
    accountSelect.appendChild(option);
  });

  const hasAccounts = state.accountOrder.length > 0;
  accountSelect.disabled = !hasAccounts;

  if (hasAccounts && state.currentAccountId) {
    accountSelect.value = state.currentAccountId;
  }

  deleteAccountBtn.disabled = state.accountOrder.length <= 1;
}

function setCurrentAccount(id) {
  if (!id || !state.accounts[id]) {
    state.currentAccountId = null;
    buildTransactionList([]);
    els.startingInput.value = '';
    els.ledgerContainer.innerHTML = '<div class="empty-state">Create an account to view the ledger.</div>';
    renderAccountOptions();
    return;
  }

  state.currentAccountId = id;
  renderAccountOptions();

  const account = getCurrentAccount();
  els.startingInput.value = Number.isFinite(account.startingBalance)
    ? String(account.startingBalance)
    : '';
  buildTransactionList(account.transactions);
  regenerateLedger();
}

async function createAccount(name) {
  const label = typeof name === 'string' ? name.trim() : '';
  const fallback = `Account ${state.accountOrder.length + 1}`;

  try {
    const response = await api('/accounts', {
      method: 'POST',
      body: { name: label || fallback }
    });

    const account = normalizeAccount(response?.account || response);
    if (!account) {
      throw new Error('Invalid account response from server');
    }

    state.accounts[account.id] = account;
    state.accountOrder.push(account.id);
    return account.id;
  } catch (error) {
    console.error('Failed to create account', error);
    throw error;
  }
}

function computeLedger(startDate, endDate, startingBalance, txns) {
  const ledger = [];
  const startUTC = parseDateInput(toDateInputValue(startDate));
  const endUTC = parseDateInput(toDateInputValue(endDate));

  const dailyIncome = new Map();
  const dailyExpenses = new Map();
  let balance = startingBalance;

  // Apply occurrences prior to start date
  txns.forEach((txn) => {
    const occurrences = generateOccurrences(txn, endUTC);
    occurrences.forEach((occurrence) => {
      const key = occurrence.getTime();
      if (occurrence < startUTC) {
        balance += txn.type === 'income' ? txn.amount : -txn.amount;
        balance = Math.round(balance * 100) / 100;
      } else if (occurrence >= startUTC && occurrence <= endUTC) {
        if (txn.type === 'income') {
          const list = dailyIncome.get(key) || [];
          list.push(txn);
          dailyIncome.set(key, list);
        } else {
          const list = dailyExpenses.get(key) || [];
          list.push(txn);
          dailyExpenses.set(key, list);
        }
      }
    });
  });

  const current = new Date(startUTC);
  while (current <= endUTC) {
    const key = current.getTime();
    const startBal = Math.round(balance * 100) / 100;

    const incomes = (dailyIncome.get(key) || []).map((txn) => txn.amount);
    const totalIncome = Math.round(incomes.reduce((sum, val) => sum + val, 0) * 100) / 100;

    const expenses = (dailyExpenses.get(key) || [])
      .map((txn) => ({ name: txn.name, amount: txn.amount }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const totalExpenses = Math.round(expenses.reduce((sum, txn) => sum + txn.amount, 0) * 100) / 100;

    balance = Math.round((startBal + totalIncome - totalExpenses) * 100) / 100;

    ledger.push({
      date: new Date(current),
      startingBalance: startBal,
      totalIncome,
      endingBalance: balance,
      expenses
    });

    current.setUTCDate(current.getUTCDate() + 1);
  }

  return ledger;
}

function renderLedgerTable(ledger) {
  if (!ledger.length) {
    els.ledgerContainer.innerHTML = '<div class="empty-state">Add transactions to see daily balances here.</div>';
    return;
  }

  const table = document.createElement('table');
  table.className = 'ledger-table';

  const thead = document.createElement('thead');
  thead.innerHTML = `
    <tr>
      <th>Date</th>
      <th>Balances</th>
      <th>Expense</th>
      <th>Amount</th>
    </tr>`;
  table.appendChild(thead);

  const tbody = document.createElement('tbody');

  ledger.forEach((entry) => {
    const rowCount = Math.max(entry.expenses.length, 3);

    const dateCell = document.createElement('td');
    dateCell.rowSpan = rowCount;
    dateCell.textContent = formatDate(entry.date);

    const balanceCell = document.createElement('td');
    balanceCell.rowSpan = rowCount;

    const balanceContent = document.createElement('div');
    balanceContent.style.display = 'grid';
    balanceContent.style.gap = '0.35rem';
    balanceCell.appendChild(balanceContent);

    const makeBalanceRow = (label, value) => {
      const wrapper = document.createElement('div');
      wrapper.innerHTML = `<span class="balance-label">${label}:</span> ${formatCurrency(value)}`;
      return wrapper;
    };

    balanceContent.appendChild(makeBalanceRow('Starting Balance', entry.startingBalance));
    balanceContent.appendChild(makeBalanceRow('Income', entry.totalIncome));
    balanceContent.appendChild(makeBalanceRow('Ending Balance', entry.endingBalance));

    for (let i = 0; i < rowCount; i += 1) {
      const row = document.createElement('tr');
      if (i === 0) {
        row.appendChild(dateCell);
        row.appendChild(balanceCell);
      }

      const expense = entry.expenses[i];
      if (expense) {
        const expenseName = document.createElement('td');
        expenseName.textContent = expense.name;
        row.appendChild(expenseName);

        const expenseAmount = document.createElement('td');
        expenseAmount.textContent = formatCurrency(expense.amount);
        row.appendChild(expenseAmount);
      } else {
        const emptyName = document.createElement('td');
        emptyName.className = 'muted';
        emptyName.textContent = entry.expenses.length === 0 && i === 0 ? 'No expenses' : '—';
        row.appendChild(emptyName);

        const emptyAmount = document.createElement('td');
        emptyAmount.className = 'muted';
        emptyAmount.textContent = '—';
        row.appendChild(emptyAmount);
      }

      tbody.appendChild(row);
    }
  });

  table.appendChild(tbody);
  els.ledgerContainer.innerHTML = '';
  els.ledgerContainer.appendChild(table);
}

function initStartingBalance() {
  els.saveStartingBtn.addEventListener('click', async () => {
    const account = getCurrentAccount();
    if (!account) return;

    const value = parseFloat(els.startingInput.value || '0');
    if (Number.isNaN(value)) return;

    const nextValue = Math.round(value * 100) / 100;

    try {
      await api(`/accounts/${account.id}`, {
        method: 'PUT',
        body: { startingBalance: nextValue }
      });

      account.startingBalance = nextValue;
      els.startingInput.value = String(nextValue);
      regenerateLedger();
    } catch (error) {
      console.error('Failed to save starting balance', error);
      window.alert('Could not save the starting balance. Please try again.');
    }
  });
}

function initTransactionForm() {
  els.txnForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const account = getCurrentAccount();
    if (!account) return;

    const formData = new FormData(els.txnForm);
    const type = formData.get('txn-type') || document.getElementById('txn-type').value;
    const name = formData.get('txn-name')?.trim() || document.getElementById('txn-name').value.trim();
    const amountValue = parseFloat(formData.get('txn-amount') || document.getElementById('txn-amount').value);
    const startDate = formData.get('txn-date') || document.getElementById('txn-date').value;
    const frequency = formData.get('txn-frequency') || document.getElementById('txn-frequency').value;

    if (!name || Number.isNaN(amountValue) || !startDate) {
      return;
    }

    const payload = {
      type,
      name,
      amount: Math.round(Number(amountValue) * 100) / 100,
      startDate,
      frequency
    };

    try {
      const response = await api(`/accounts/${account.id}/transactions`, {
        method: 'POST',
        body: payload
      });

      const saved = normalizeTransaction(response?.transaction || response);
      if (!saved) {
        throw new Error('Invalid transaction response from server');
      }

      account.transactions.push(saved);

      els.txnForm.reset();
      document.getElementById('txn-type').value = payload.type;
      document.getElementById('txn-frequency').value = payload.frequency;

      buildTransactionList(account.transactions);
      regenerateLedger();
    } catch (error) {
      console.error('Failed to add transaction', error);
      window.alert('Could not add the transaction. Please try again.');
    }
  });
}

function getLedgerRange() {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const end = new Date(Date.UTC(now.getUTCFullYear() + 1, now.getUTCMonth(), now.getUTCDate()));
  return { start, end };
}

function regenerateLedger() {
  const account = getCurrentAccount();
  if (!account) {
    els.ledgerContainer.innerHTML = '<div class="empty-state">Create an account to view the ledger.</div>';
    return;
  }

  const hasData = (account.startingBalance && account.startingBalance !== 0) || account.transactions.length > 0;
  if (!hasData) {
    els.ledgerContainer.innerHTML = '<div class="empty-state">Add a starting balance or transactions to see the ledger.</div>';
    return;
  }

  const { start, end } = getLedgerRange();
  const ledger = computeLedger(start, end, account.startingBalance || 0, account.transactions);
  renderLedgerTable(ledger);
}

function initAccountControls() {
  els.createAccountBtn.addEventListener('click', async () => {
    const name = (els.newAccountName.value || '').trim();

    try {
      const id = await createAccount(name);
      els.newAccountName.value = '';
      setCurrentAccount(id);
    } catch (error) {
      window.alert('Could not create the account. Please try again.');
    }
  });

  els.accountSelect.addEventListener('change', (event) => {
    const selectedId = event.target.value;
    setCurrentAccount(selectedId);
  });

  els.deleteAccountBtn.addEventListener('click', async () => {
    if (state.accountOrder.length <= 1 || !state.currentAccountId) {
      return;
    }

    const idToRemove = state.currentAccountId;

    try {
      await api(`/accounts/${idToRemove}`, { method: 'DELETE' });
      delete state.accounts[idToRemove];
      state.accountOrder = state.accountOrder.filter((id) => id !== idToRemove);

      const nextId = state.accountOrder[0] || null;
      setCurrentAccount(nextId);
    } catch (error) {
      console.error('Failed to delete account', error);
      window.alert('Could not delete the account. Please try again.');
    }
  });
}

async function hydrateInitialState() {
  const previousId = state.currentAccountId;

  try {
    await loadAccounts();
  } catch (error) {
    window.alert('Unable to load budget data from the server. Please try again later.');
    state.currentAccountId = null;
    renderAccountOptions();
    buildTransactionList([]);
    els.ledgerContainer.innerHTML = '<div class="empty-state">Server data is unavailable right now.</div>';
    return;
  }

  if (previousId && state.accounts[previousId]) {
    state.currentAccountId = previousId;
  }

  if (!state.accountOrder.length) {
    try {
      const id = await createAccount('Account 1');
      state.currentAccountId = id;
    } catch (error) {
      console.error('Failed to create default account', error);
      window.alert('The app could not create a default account. Please try again.');
      setCurrentAccount(null);
      return;
    }
  }

  if (!state.currentAccountId || !state.accounts[state.currentAccountId]) {
    state.currentAccountId = state.accountOrder[0] || null;
  }

  setCurrentAccount(state.currentAccountId);
}

async function init() {
  initAccountControls();
  initStartingBalance();
  initTransactionForm();
  await hydrateInitialState();
}

document.addEventListener('DOMContentLoaded', () => {
  init().catch((error) => {
    console.error('Failed to initialise the budget app', error);
    window.alert('Failed to start the budget app. Please refresh to try again.');
  });
});

