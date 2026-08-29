import path from 'node:path';
import express from 'express';
import { config } from './config.js';
import {
  listAccounts, addAccount, setEnabled, removeAccount, verifyPassphrase,
} from './keystore.js';
import { planBlockTrade } from './allocator.js';
import { executePlan } from './executor.js';
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

app.get('/api/accounts', wrap(async (_req, res) => {
  const accounts = await Promise.all(
    listAccounts().map(async (a) => {
      try {
        return { ...a, solBalance: await solBalance(a.pubkey) };
      } catch (e) {
        return { ...a, solBalance: null, balanceError: String(e?.message || e) };
      }
    })
  );
  ok(res, { accounts });
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

  const pass = passphrase || config.passphrase;
  if (!pass) return fail(res, 400, 'keystore passphrase is required');
  if (!verifyPassphrase(pass)) return fail(res, 401, 'keystore passphrase is incorrect');

  // Re-plan against live balances rather than trusting a plan the client posted back.
  const plan = await planBlockTrade({
    side, mint, basis, minSol, maxSol, sellPct,
    accounts: listAccounts(),
  });
  if (plan.orders.length === 0) return fail(res, 400, 'plan produced no executable orders');

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
