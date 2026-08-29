import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

/**
 * Append-only audit ledger.
 *
 * One row per client per fill. This is the record you owe the people whose money
 * you are trading: what was decided, what each account was allocated and why,
 * what actually filled, and what it cost. Nothing here is ever updated in place
 * except the terminal status of a leg.
 */

fs.mkdirSync(config.dataDir, { recursive: true });
const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS block_trades (
  id            TEXT PRIMARY KEY,
  created_at    TEXT NOT NULL,
  side          TEXT NOT NULL,
  mint          TEXT NOT NULL,
  basis         TEXT NOT NULL,
  min_sol       REAL,
  max_sol       REAL,
  sell_pct      REAL,
  slippage_bps  INTEGER NOT NULL,
  priority_fee  REAL NOT NULL,
  total_sol     REAL NOT NULL,
  note          TEXT
);

CREATE TABLE IF NOT EXISTS legs (
  id             TEXT PRIMARY KEY,
  block_trade_id TEXT NOT NULL REFERENCES block_trades(id),
  account_id     TEXT NOT NULL,
  label          TEXT NOT NULL,
  pubkey         TEXT NOT NULL,
  client_name    TEXT NOT NULL,
  agreement_ref  TEXT NOT NULL,
  side           TEXT NOT NULL,
  mint           TEXT NOT NULL,
  amount         REAL NOT NULL,
  amount_unit    TEXT NOT NULL,
  reason         TEXT NOT NULL,
  status         TEXT NOT NULL,
  signature      TEXT,
  error          TEXT,
  submitted_at   TEXT,
  settled_at     TEXT
);

CREATE INDEX IF NOT EXISTS legs_by_trade   ON legs(block_trade_id);
CREATE INDEX IF NOT EXISTS legs_by_account ON legs(account_id);
`);

/** node:sqlite binds null but not undefined — normalize optional columns. */
const n = (v) => (v === undefined ? null : v);

export function recordBlockTrade(t) {
  db.prepare(
    `INSERT INTO block_trades
     (id, created_at, side, mint, basis, min_sol, max_sol, sell_pct, slippage_bps, priority_fee, total_sol, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    t.id, t.createdAt, t.side, t.mint, t.basis,
    n(t.minSol), n(t.maxSol), n(t.sellPct),
    t.slippageBps, t.priorityFee, t.totalSol, n(t.note)
  );
}

export function recordLeg(l) {
  db.prepare(
    `INSERT INTO legs
     (id, block_trade_id, account_id, label, pubkey, client_name, agreement_ref, side, mint,
      amount, amount_unit, reason, status, signature, error, submitted_at, settled_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    l.id, l.blockTradeId, l.accountId, l.label, l.pubkey, l.clientName, l.agreementRef,
    l.side, l.mint, l.amount, l.amountUnit, l.reason, l.status,
    n(l.signature), n(l.error), n(l.submittedAt), n(l.settledAt)
  );
}

export function settleLeg(id, { status, signature = null, error = null }) {
  db.prepare(`UPDATE legs SET status = ?, signature = ?, error = ?, settled_at = ? WHERE id = ?`)
    .run(status, n(signature), n(error), new Date().toISOString(), id);
}

export function markSubmitted(id) {
  db.prepare(`UPDATE legs SET status = 'submitted', submitted_at = ? WHERE id = ?`)
    .run(new Date().toISOString(), id);
}

export function recentBlockTrades(limit = 25) {
  const trades = db.prepare(`SELECT * FROM block_trades ORDER BY created_at DESC LIMIT ?`).all(limit);
  const byTrade = db.prepare(`SELECT * FROM legs WHERE block_trade_id = ? ORDER BY rowid`);
  return trades.map((t) => ({ ...t, legs: byTrade.all(t.id) }));
}

export function legsForAccount(accountId, limit = 200) {
  return db
    .prepare(`SELECT * FROM legs WHERE account_id = ? ORDER BY rowid DESC LIMIT ?`)
    .all(accountId, limit);
}

export default db;
