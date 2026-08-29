/**
 * Popup for the local allocator.
 *
 * This is a control panel, not the application. The trading engine is a Node
 * process — key decryption, transaction building and the SQLite ledger cannot
 * run inside an extension — so the popup reports status and looks tokens up,
 * and hands off to the dashboard tab for anything that signs.
 *
 * Phantom is the other reason for that split: a wallet extension injects itself
 * into ordinary web pages, not into another extension's popup, so `window.solana`
 * does not exist here and never will. Linking a wallet has to happen on the
 * dashboard page.
 */

const BASE = 'http://127.0.0.1:8787';
const $ = (id) => document.getElementById(id);

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const money = (n) => {
  if (n === null || n === undefined) return '—';
  const a = Math.abs(n);
  if (a >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
  return '$' + n.toFixed(a < 1 ? 6 : 2);
};

const pct = (n) => {
  if (n === null || n === undefined) return '—';
  const cls = n > 0 ? 'ok' : n < 0 ? 'bad' : '';
  return `<span class="${cls}">${n > 0 ? '+' : ''}${n.toFixed(2)}%</span>`;
};

async function api(path, ms = 6000) {
  const res = await fetch(BASE + path, { signal: AbortSignal.timeout(ms) });
  const body = await res.json();
  if (!body.ok) throw new Error(body.error || `request failed (${res.status})`);
  return body;
}

/* ---------------- status ---------------- */

async function loadStatus() {
  try {
    const cfg = await api('/api/config');
    $('dot').className = 'dot up';
    $('offline').hidden = true;
    $('online').hidden = false;

    $('rpc').textContent = cfg.rpcUrl.replace(/^https?:\/\//, '');
    $('rpc').title = cfg.rpcUrl;
    $('ceiling').textContent = `${cfg.maxBlockTradeSol} SOL / trade`;

    const { accounts } = await api('/api/accounts', 15000);
    if (accounts.length === 0) {
      $('accounts').textContent = 'none yet';
      $('sol').textContent = '—';
      return;
    }
    const byCustody = accounts.reduce((acc, a) => {
      acc[a.custody] = (acc[a.custody] || 0) + 1;
      return acc;
    }, {});
    $('accounts').textContent = Object.entries(byCustody).map(([k, v]) => `${v} ${k}`).join(', ');

    const known = accounts.filter((a) => typeof a.solBalance === 'number');
    const total = known.reduce((s, a) => s + a.solBalance, 0);
    $('sol').textContent = known.length === accounts.length
      ? `${total.toFixed(4)} SOL`
      : `${total.toFixed(4)} SOL (${accounts.length - known.length} unread)`;
  } catch {
    $('dot').className = 'dot down';
    $('offline').hidden = false;
    $('online').hidden = true;
  }
}

/* ---------------- token lookup ---------------- */

/** Closing prices as a sparkline; enough to see shape without a full chart. */
function sparkline(candles) {
  if (candles.length < 2) return '';
  const W = 296, H = 40;
  const closes = candles.map((c) => c.c);
  const lo = Math.min(...closes);
  const hi = Math.max(...closes);
  const span = hi - lo || hi || 1;
  const pts = closes.map((c, i) => {
    const x = (i / (closes.length - 1)) * W;
    const y = H - ((c - lo) / span) * (H - 4) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const up = closes[closes.length - 1] >= closes[0];
  const colour = up ? 'var(--ok)' : 'var(--bad)';
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" width="100%" height="40" aria-hidden="true">
    <polyline points="${pts}" fill="none" stroke="${colour}" stroke-width="1.5"
              stroke-linejoin="round" stroke-linecap="round" />
  </svg>`;
}

let lookupTimer = null;
let currentMint = null;

async function lookup(mint) {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) {
    $('token').innerHTML = mint ? '<p class="msg">That is not a Solana mint address.</p>' : '';
    return;
  }
  currentMint = mint;
  $('token').innerHTML = '<p class="msg">looking up…</p>';

  try {
    const { token: t } = await api(`/api/token/${encodeURIComponent(mint)}`, 12000);
    if (mint !== currentMint) return;
    if (!t.found) {
      $('token').innerHTML = `<p class="msg warn">${esc(t.message)}</p>`;
      return;
    }

    $('token').innerHTML = `
      <div class="tok">
        <div class="tokhead">
          <span class="sym">${esc(t.symbol || '?')}</span>
          <span class="nm">${esc(t.name || '')}</span>
        </div>
        <div class="grid">
          <div class="cell"><div class="ck">Market cap</div><div class="cv">${money(t.marketCap)}</div></div>
          <div class="cell"><div class="ck">Price</div><div class="cv">${t.priceUsd === null ? '—' : '$' + t.priceUsd.toPrecision(4)}</div></div>
          <div class="cell"><div class="ck">Liquidity</div><div class="cv">${money(t.liquidityUsd)}</div></div>
          <div class="cell"><div class="ck">24h</div><div class="cv">${pct(t.change24h)}</div></div>
        </div>
        <span class="stage ${t.graduated ? '' : 'curve'}">${esc(t.stage)}</span>
        <div id="spark"></div>
      </div>`;

    const { candles } = await api(`/api/token/${encodeURIComponent(t.pairAddress)}/candles?tf=1h`, 12000);
    if (mint === currentMint && $('spark')) $('spark').innerHTML = sparkline(candles.candles || []);
  } catch (e) {
    if (mint === currentMint) $('token').innerHTML = `<p class="msg bad">${esc(e.message)}</p>`;
  }
}

$('mint').addEventListener('input', () => {
  clearTimeout(lookupTimer);
  const mint = $('mint').value.trim();
  lookupTimer = setTimeout(() => lookup(mint), 350);
});

/* ---------------- actions ---------------- */

$('open').addEventListener('click', () => {
  chrome.tabs.create({ url: BASE });
  window.close();
});

$('copyCmd').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('startCmd').textContent);
  $('copyCmd').textContent = 'Copied';
  setTimeout(() => ($('copyCmd').textContent = 'Copy command'), 1500);
});

loadStatus();
