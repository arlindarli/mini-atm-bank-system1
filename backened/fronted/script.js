/* ============ STATE ============ */
const state = {
  apiBase: 'http://localhost:3000',
  token: null,
  user: null,
  account: null,
  transactions: [],
  period: 'day',
  periodStats: { in: 0, out: 0 },
  txPanelOpen: false,
  modalType: null,
};

/* ============ HELPERS ============ */
function apiUrl(path){ return state.apiBase.replace(/\/$/, '') + path; }

async function apiFetch(path, options = {}){
  const headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});
  if (state.token) headers['Authorization'] = 'Bearer ' + state.token;
  const res = await fetch(apiUrl(path), Object.assign({}, options, { headers }));
  let data = null;
  try { data = await res.json(); } catch(e) {}
  if (!res.ok) {
    const msg = (data && (data.message || data.error)) || ('Request failed (' + res.status + ')');
    throw new Error(msg);
  }
  return data;
}

function showToast(msg, type){
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show' + (type ? ' ' + type : '');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => { t.className = 'toast'; }, 3200);
}

function fmt(n){
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/* ============ AUTH TABS ============ */
function switchAuthTab(tab){
  document.getElementById('tabLogin').classList.toggle('active', tab === 'login');
  document.getElementById('tabRegister').classList.toggle('active', tab === 'register');
  document.getElementById('loginForm').style.display = tab === 'login' ? 'block' : 'none';
  document.getElementById('registerForm').style.display = tab === 'register' ? 'block' : 'none';
  document.getElementById('authSubtitle').textContent = tab === 'login' ? 'Sign in to your account' : 'Open a new account';
  document.getElementById('authMsg').textContent = '';
}

/* ============ LOGIN / REGISTER ============ */
async function handleLogin(e){
  e.preventDefault();
  state.apiBase = document.getElementById('apiBase').value.trim() || state.apiBase;
  const btn = document.getElementById('loginBtn');
  const msgEl = document.getElementById('authMsg');
  msgEl.className = 'auth-msg'; msgEl.textContent = '';
  btn.disabled = true; btn.textContent = 'Signing in…';

  try {
    const payload = {
      email: document.getElementById('loginEmail').value.trim(),
      password: document.getElementById('loginPassword').value,
      pin: document.getElementById('loginPin').value,
    };
    const data = await apiFetch('/login', { method: 'POST', body: JSON.stringify(payload) });

    state.token = data.token;
    state.user = data.user;
    const acct = data.account || {};
    state.account = {
      account_number: data.accountNumber || data.account_number || acct.accountNumber || acct.account_number,
      balance: data.balance !== undefined ? data.balance
        : acct.balance !== undefined ? acct.balance
        : 0,
    };
    enterDashboard();
  } catch (err) {
    msgEl.textContent = err.message;
    msgEl.className = 'auth-msg error';
  } finally {
    btn.disabled = false; btn.textContent = 'Sign In';
  }
  return false;
}

async function handleRegister(e){
  e.preventDefault();
  state.apiBase = document.getElementById('apiBase').value.trim() || state.apiBase;
  const btn = document.getElementById('registerBtn');
  const msgEl = document.getElementById('authMsg');
  msgEl.className = 'auth-msg'; msgEl.textContent = '';
  btn.disabled = true; btn.textContent = 'Creating…';

  try {
    const payload = {
      fullName: document.getElementById('regFullName').value.trim(),
      email: document.getElementById('regEmail').value.trim(),
      password: document.getElementById('regPassword').value,
      pin: document.getElementById('regPin').value,
    };
    await apiFetch('/register', { method: 'POST', body: JSON.stringify(payload) });
    msgEl.textContent = 'Account created. You can sign in now.';
    msgEl.className = 'auth-msg success';
    switchAuthTab('login');
    document.getElementById('loginEmail').value = payload.email;
  } catch (err) {
    msgEl.textContent = err.message;
    msgEl.className = 'auth-msg error';
  } finally {
    btn.disabled = false; btn.textContent = 'Create Account';
  }
  return false;
}

function handleLogout(){
  state.token = null; state.user = null; state.account = null; state.transactions = [];
  document.getElementById('dashboardView').style.display = 'none';
  document.getElementById('authView').style.display = 'block';
  document.getElementById('loginForm').reset();
}

/* ============ DASHBOARD ============ */
function enterDashboard(){
  document.getElementById('authView').style.display = 'none';
  document.getElementById('dashboardView').style.display = 'block';
  document.getElementById('acctNumber').textContent = state.account.account_number || '—';
  document.getElementById('balanceAmt').textContent = fmt(state.account.balance);
  loadTransactions();
}

async function refreshAll(){
  await loadTransactions();
  showToast('Refreshed', 'success');
}

async function loadTransactions(){
  try {
    const data = await apiFetch('/transactions/' + encodeURIComponent(state.account.account_number));
    state.transactions = Array.isArray(data) ? data : (data.transactions || []);
    // keep balance in sync with most recent transaction if available
    if (state.transactions.length) {
      const sorted = [...state.transactions].sort((a,b) => new Date(b.timestamp) - new Date(a.timestamp));
      if (sorted[0].balance_after !== undefined) {
        state.account.balance = sorted[0].balance_after;
        document.getElementById('balanceAmt').textContent = fmt(state.account.balance);
      }
    }
    renderTransactions();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function periodStart(period){
  const now = new Date();
  const d = new Date(now);
  if (period === 'day') { d.setHours(0,0,0,0); }
  else if (period === 'week') { d.setDate(d.getDate() - 7); }
  else if (period === 'month') { d.setMonth(d.getMonth() - 1); }
  else if (period === 'year') { d.setFullYear(d.getFullYear() - 1); }
  return d;
}

function setPeriod(period){
  state.period = period;
  document.querySelectorAll('#periodTabs button').forEach(b => {
    b.classList.toggle('active', b.dataset.period === period);
  });
  renderTransactions();
}

function renderTransactions(){
  const start = periodStart(state.period);
  const filtered = state.transactions
    .filter(tx => new Date(tx.timestamp) >= start)
    .sort((a,b) => new Date(b.timestamp) - new Date(a.timestamp));

  let inTotal = 0, outTotal = 0;
  const listEl = document.getElementById('txList');
  listEl.innerHTML = '';

  if (!filtered.length) {
    listEl.innerHTML = '<div class="tx-empty">No transactions in this period</div>';
  }

  filtered.forEach(tx => {
    const rawType = (tx.type || '');
    const type = normalizeType(rawType);
    const isIn = type === 'deposit' || type === 'transfer_received';
    if (isIn) inTotal += Number(tx.amount); else outTotal += Number(tx.amount);

    const row = document.createElement('div');
    row.className = 'tx-row';
    row.innerHTML = `
      <div class="tx-ic ${type}">${txIcon(type)}</div>
      <div class="tx-info">
        <div class="t">${type.replace(/_/g, ' ')}</div>
        <div class="d">${new Date(tx.timestamp).toLocaleString()}</div>
      </div>
      <div class="tx-amt ${isIn ? 'pos' : 'neg'}">${isIn ? '+' : '-'}$${fmt(tx.amount)}</div>
    `;
    listEl.appendChild(row);
  });

  state.periodStats = { in: inTotal, out: outTotal };
  document.getElementById('sumIn').textContent = '$' + fmt(inTotal);
  document.getElementById('sumOut').textContent = '$' + fmt(outTotal);
}

// Normalizes backend type strings like "transfer received", "transfer-received",
// "Transfer_Received" all down to a single consistent form: "transfer_received"
function normalizeType(rawType){
  return String(rawType).trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function txIcon(type){
  if (type === 'deposit' || type === 'transfer_received') return '↓';
  if (type === 'withdraw' || type === 'transfer_sent') return '↑';
  return '•';
}

function toggleTxPanel(forceOpen){
  state.txPanelOpen = forceOpen === true ? true : !state.txPanelOpen;
  document.getElementById('txPanel').classList.toggle('open', state.txPanelOpen);
  document.getElementById('txToggleBtn').classList.toggle('active', state.txPanelOpen);
}

/* ============ MODAL: deposit / withdraw / transfer ============ */
function openModal(type){
  state.modalType = type;
  document.getElementById('modalTitle').textContent = type;
  document.getElementById('toAccountField').style.display = type === 'transfer' ? 'block' : 'none';
  document.getElementById('modalToAccount').required = type === 'transfer';
  document.getElementById('modalAmount').value = '';
  document.getElementById('modalToAccount').value = '';
  document.getElementById('modalSubmitBtn').textContent = 'Confirm ' + type.charAt(0).toUpperCase() + type.slice(1);
  document.getElementById('modalOverlay').classList.add('open');
}

function closeModal(){
  document.getElementById('modalOverlay').classList.remove('open');
  state.modalType = null;
}

async function handleModalSubmit(e){
  e.preventDefault();
  const type = state.modalType;
  const amount = parseFloat(document.getElementById('modalAmount').value);
  const btn = document.getElementById('modalSubmitBtn');
  btn.disabled = true; btn.textContent = 'Processing…';

  try {
    if (type === 'deposit') {
      await apiFetch('/deposit', {
        method: 'POST',
        body: JSON.stringify({ accountNumber: state.account.account_number, amount }),
      });
    } else if (type === 'withdraw') {
      await apiFetch('/withdraw', {
        method: 'POST',
        body: JSON.stringify({ accountNumber: state.account.account_number, amount }),
      });
    } else if (type === 'transfer') {
      const toAccount = document.getElementById('modalToAccount').value.trim();
      await apiFetch('/transfer', {
        method: 'POST',
        body: JSON.stringify({
          fromAccountNumber: state.account.account_number,
          toAccountNumber: toAccount,
          amount,
        }),
      });
    }
    showToast(type.charAt(0).toUpperCase() + type.slice(1) + ' successful', 'success');
    closeModal();
    await loadTransactions();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Confirm ' + (type ? type.charAt(0).toUpperCase() + type.slice(1) : '');
  }
  return false;
}

document.getElementById('modalOverlay').addEventListener('click', (e) => {
  if (e.target.id === 'modalOverlay') closeModal();
});