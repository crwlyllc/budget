const STORAGE_KEYS = {
  starting: 'budget-app-starting-balance',
  transactions: 'budget-app-transactions'
};

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

const els = {
  startingInput: document.getElementById('starting-balance'),
  saveStartingBtn: document.getElementById('save-starting'),
  txnForm: document.getElementById('txn-form'),
  txnList: document.getElementById('txn-list'),
  rangeFrom: document.getElementById('range-from'),
  rangeTo: document.getElementById('range-to'),
  ledgerBtn: document.getElementById('generate-ledger'),
  ledgerContainer: document.getElementById('ledger-container')
};

function readStartingBalance() {
  const stored = localStorage.getItem(STORAGE_KEYS.starting);
  return stored ? parseFloat(stored) : 0;
}

function writeStartingBalance(value) {
  localStorage.setItem(STORAGE_KEYS.starting, String(value));
}

function readTransactions() {
  const raw = localStorage.getItem(STORAGE_KEYS.transactions);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error('Failed to parse transactions', err);
    return [];
  }
}

function writeTransactions(txns) {
  localStorage.setItem(STORAGE_KEYS.transactions, JSON.stringify(txns));
}

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
  txns
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
      removeBtn.addEventListener('click', () => {
        const filtered = readTransactions().filter((t) => t.id !== txn.id);
        writeTransactions(filtered);
        buildTransactionList(filtered);
        regenerateLedger();
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
    els.ledgerContainer.innerHTML = '<div class="empty-state">Adjust the date range and click "Generate Ledger" to view daily balances.</div>';
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
  const stored = localStorage.getItem(STORAGE_KEYS.starting);
  if (stored !== null) {
    els.startingInput.value = stored;
  }

  els.saveStartingBtn.addEventListener('click', () => {
    const value = parseFloat(els.startingInput.value || '0');
    if (Number.isNaN(value)) return;
    writeStartingBalance(value);
    const txns = readTransactions();
    buildTransactionList(txns);
    regenerateLedger();
  });
}

function initTransactionForm() {
  els.txnForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const formData = new FormData(els.txnForm);
    const txn = {
      id: createId(),
      type: formData.get('txn-type') || document.getElementById('txn-type').value,
      name: formData.get('txn-name')?.trim() || document.getElementById('txn-name').value.trim(),
      amount: parseFloat(formData.get('txn-amount') || document.getElementById('txn-amount').value),
      startDate: formData.get('txn-date') || document.getElementById('txn-date').value,
      frequency: formData.get('txn-frequency') || document.getElementById('txn-frequency').value
    };

    if (!txn.name || Number.isNaN(txn.amount) || !txn.startDate) {
      return;
    }

    txn.amount = Number(txn.amount);

    const txns = readTransactions();
    txns.push(txn);
    writeTransactions(txns);

    els.txnForm.reset();
    document.getElementById('txn-type').value = txn.type;
    document.getElementById('txn-frequency').value = txn.frequency;

    buildTransactionList(txns);
    regenerateLedger();
  });
}

function initLedgerControls() {
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const oneYearLater = new Date(Date.UTC(now.getUTCFullYear() + 1, now.getUTCMonth(), now.getUTCDate()));
  els.rangeFrom.value = toDateInputValue(today);
  els.rangeTo.value = toDateInputValue(oneYearLater);

  els.ledgerBtn.addEventListener('click', regenerateLedger);
}

function regenerateLedger() {
  const startValue = els.rangeFrom.value;
  const endValue = els.rangeTo.value;
  const now = new Date();
  const defaultStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const defaultEnd = new Date(Date.UTC(now.getUTCFullYear() + 1, now.getUTCMonth(), now.getUTCDate()));
  const startDate = parseDateInput(startValue) || defaultStart;
  const endDate = parseDateInput(endValue) || defaultEnd;
  if (endDate < startDate) {
    els.ledgerContainer.innerHTML = '<div class="empty-state">The end date must be after the start date.</div>';
    return;
  }

  const startingBalance = readStartingBalance();
  const txns = readTransactions();
  const ledger = computeLedger(startDate, endDate, startingBalance, txns);
  renderLedgerTable(ledger);
}

function init() {
  initStartingBalance();
  initTransactionForm();
  initLedgerControls();
  buildTransactionList(readTransactions());
  regenerateLedger();
}

document.addEventListener('DOMContentLoaded', init);

