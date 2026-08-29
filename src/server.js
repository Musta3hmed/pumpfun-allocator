import path from 'node:path';
import express from 'express';
import { config } from './config.js';
import crypto from 'node:crypto';
import {
  listAccounts, addAccount, addExternalAccount, setEnabled, removeAccount, verifyPassphrase,
} from './keystore.js';
import { planBlockTrade } from './allocator.js';
import { executePlan, settlePhantomLeg } from './executor.js';
import { getTokenMarket, getCandles, TIMEFRAMES } from './market.js';
import { recentBlockTrades, legsForAccount } from './ledger.js';
import { solBalance } from './pumpfun.js';

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(config.root, 'public')));

// The dashboard can move client money. Refuse to serve it on a non-loopback
// interface unless the operator has explicitly opted in.
if (!['127.0.0.1', 'localhost', '::1'].includes(config.host) && process.env.ALLOW_REMOTE !== 'yes') {
  console.error(
    `Refusing to bind ${config.host}: this dashboard has no authentication and can move client funds.\n` +
    `Put a reverse proxy with real auth in front of it and set ALLOW_REMOTE=yes to override.`
  );
  process.exit(1);
}

const ok = (res, body) => res.json({ ok: true, ...body });
const fail = (res, code, message) => res.status(code).json({ ok: false, error: message });

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => fail(res, 400, String(e?.message || e)));

app.get('/api/config', (_req, res) =>
  ok(res, {
    rpcUrl: config.rpcUrl.replace(/api-key=[^&]+/i, 'api-key=***'),
    maxBlockTradeSol: config.maxBlockTradeSol,
    maxConcurrency: config.maxConcurrency,
    passphraseInEnv: Boolean(config.passphrase),
  })
);

/** Display-only market data for the mint preview card. */
app.get('/api/token/:mint', wrap(async (req, res) => {
  const mint = String(req.params.mint || '').trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) {
    return fail(res, 400, 'that does not look like a Solana mint address');
  }
  ok(res, { token: await getTokenMarket(mint) });
}));

/** OHLCV candles for the preview chart, drawn client-side. */
app.get('/api/token/:pair/candles', wrap(async (req, res) => {
  const tf = String(req.query.tf || '1h');
  if (!TIMEFRAMES[tf]) {
    return fail(res, 400, `unknown timeframe (want one of ${Object.keys(TIMEFRAMES).join(', ')})`);
  }
  ok(res, { candles: await getCandles(String(req.params.pair), tf) });
}));

/**
 * Issue a one-time challenge for a wallet to sign.
 *
 * The nonce is what stops a captured signature from being replayed later to
 * register the same wallet somewhere else; it is single-use and short-lived.
 */
const nonces = new Map();
const NONCE_TTL_MS = 5 * 60 * 1000;

function pruneNonces() {
  const now = Date.now();
  for (const [k, v] of nonces) if (now - v > NONCE_TTL_MS) nonces.delete(k);
}

app.post('/api/wallet/nonce', wrap(async (_req, res) => {
  pruneNonces();
  const nonce = crypto.randomBytes(16).toString('hex');
  nonces.set(nonce, Date.now());
  const message = [
    'Link this wallet to the pump.fun block trade allocator.',
    'This proves you control the wallet. It authorizes no transfer and moves no funds.',
    `Nonce: ${nonce}`,
  ].join('\n');
  ok(res, { message, nonce });
}));

/** Register a Phantom-connected or watch-only account. No secret key involved. */
app.post('/api/accounts/external', wrap(async (req, res) => {
  const { label, pubkey, custody, mandate, message, signature, nonce } = req.body || {};

  pruneNonces();
  if (!nonce || !nonces.has(nonce)) {
    return fail(res, 400, 'challenge expired or unknown — reconnect the wallet and try again');
  }
  if (typeof message !== 'string' || !message.includes(nonce)) {
    return fail(res, 400, 'the signed message does not carry the issued challenge');
  }
  nonces.delete(nonce); // single use

  const account = addExternalAccount({ label, pubkey, custody, mandate, message, signature });
  ok(res, { account });
}));

/** Record the result of a leg the browser signed with Phantom. */
app.post('/api/legs/:id/settle', wrap(async (req, res) => {
  const { signature, error } = req.body || {};
  ok(res, { leg: await settlePhantomLeg(req.params.id, { signature, error }) });
}));

/**
 * The account list itself, straight from the keystore — no network, always instant.
 *
 * Balances are a separate call on purpose. Folding them in here meant the whole
 * panel sat on "loading" whenever the RPC was slow, which on the public endpoint
 * is often. The list is local data and should never wait on a remote one.
 */
app.get('/api/accounts', wrap(async (_req, res) => {
  ok(res, { accounts: listAccounts() });
}));

/** Balances, fetched in parallel and individually bounded. Never throws as a whole. */
app.get('/api/accounts/balances', wrap(async (_req, res) => {
  const balances = await Promise.all(
    listAccounts().map(async (a) => {
      try {
        return { id: a.id, solBalance: await solBalance(a.pubkey) };
      } catch (e) {
        return { id: a.id, solBalance: null, balanceError: String(e?.message || e) };
      }
    })
  );
  ok(res, { balances });
}));

app.post('/api/accounts', wrap(async (req, res) => {
  const { label, secretKeyBase58, mandate, passphrase } = req.body || {};
  const pass = passphrase || config.passphrase;
  const account = addAccount({ label, secretKeyBase58, mandate, passphrase: pass });
  ok(res, { account });
}));

app.post('/api/accounts/:id/enabled', wrap(async (req, res) =>
  ok(res, setEnabled(req.params.id, req.body?.enabled))
));

app.delete('/api/accounts/:id', wrap(async (req, res) =>
  ok(res, removeAccount(req.params.id))
));

app.get('/api/accounts/:id/legs', wrap(async (req, res) =>
  ok(res, { legs: legsForAccount(req.params.id) })
));

/** Dry run. Always call this before /api/execute — the UI shows it for approval. */
app.post('/api/plan', wrap(async (req, res) => {
  const { side, mint, basis, minSol, maxSol, sellPct } = req.body || {};
  const plan = await planBlockTrade({
    side, mint, basis, minSol, maxSol, sellPct,
    accounts: listAccounts(),
  });
  ok(res, { plan: { ...plan, minSol, maxSol, sellPct } });
}));

app.post('/api/execute', wrap(async (req, res) => {
  const {
    side, mint, basis, minSol, maxSol, sellPct,
    slippagePct = 5, priorityFee = 0.00005, passphrase, note, confirm,
  } = req.body || {};

  if (confirm !== true) return fail(res, 400, 'execute requires an explicit confirm: true');

  // Re-plan against live balances rather than trusting a plan the client posted back.
  const plan = await planBlockTrade({
    side, mint, basis, minSol, maxSol, sellPct,
    accounts: listAccounts(),
  });
  if (plan.orders.length === 0) return fail(res, 400, 'plan produced no executable orders');

  // Only legs this machine signs for need the keystore passphrase. An all-Phantom
  // block trade is approved in the browser and needs no passphrase at all.
  const pass = passphrase || config.passphrase;
  const needsKeystore = plan.orders.some((o) => o.custody !== 'phantom');
  if (needsKeystore) {
    if (!pass) return fail(res, 400, 'keystore passphrase is required to sign for keystore accounts');
    if (!verifyPassphrase(pass)) return fail(res, 401, 'keystore passphrase is incorrect');
  }

  const result = await executePlan(
    { ...plan, minSol, maxSol, sellPct },
    { slippagePct: Number(slippagePct), priorityFee: Number(priorityFee), passphrase: pass, note }
  );
  ok(res, { result });
}));

app.get('/api/history', wrap(async (_req, res) =>
  ok(res, { trades: recentBlockTrades(25) })
));

app.listen(config.port, config.host, () => {
  console.log(`allocator dashboard  http://${config.host}:${config.port}`);
  console.log(`rpc                  ${config.rpcUrl}`);
  console.log(`ceiling              ${config.maxBlockTradeSol} SOL per block trade`);
});
