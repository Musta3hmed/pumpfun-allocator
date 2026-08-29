import assert from 'node:assert/strict';
import test from 'node:test';
import { sizeOrders, SOL_RESERVE } from './src/allocator.js';

const acct = (id, cap) => ({ id, label: id, pubkey: `pk_${id}`, enabled: true, custody: 'keystore',
  mandate: { clientName: `${id} client`, agreementRef: `AGR-${id}`, maxPerTradeSol: cap } });
const pos = (id, sol, cap = 100, tokens = 0) => ({ account: acct(id, cap), sol, tokens });

test('pro-rata: biggest account gets maxSol, smallest gets minSol', () => {
  const { orders } = sizeOrders({
    side: 'buy', basis: 'pro-rata', minSol: 0.1, maxSol: 0.5,
    positions: [pos('small', 1.02), pos('mid', 3.02), pos('big', 5.02)],
  });
  assert.equal(orders.length, 3);
  assert.equal(orders[0].amount, 0.1);
  assert.equal(orders[2].amount, 0.5);
  assert.equal(orders[1].amount, 0.3); // exactly halfway on capital
});

test('pro-rata with identical balances gives everyone maxSol', () => {
  const { orders } = sizeOrders({
    side: 'buy', basis: 'pro-rata', minSol: 0.1, maxSol: 0.4,
    positions: [pos('a', 2), pos('b', 2)],
  });
  assert.deepEqual(orders.map((o) => o.amount), [0.4, 0.4]);
});

test('mandate ceiling clamps an account below the requested size', () => {
  const { orders } = sizeOrders({
    side: 'buy', basis: 'equal', minSol: 0.05, maxSol: 0.5,
    positions: [pos('rich', 10, 0.2), pos('normal', 10, 100)],
  });
  assert.equal(orders[0].amount, 0.2);
  assert.match(orders[0].reason, /capped by mandate/);
  assert.equal(orders[1].amount, 0.5);
});

test('free balance clamps, and the fee reserve is never spent', () => {
  const { orders } = sizeOrders({
    side: 'buy', basis: 'equal', minSol: 0.01, maxSol: 5,
    positions: [pos('thin', 0.3)],
  });
  assert.equal(orders[0].amount, Number((0.3 - SOL_RESERVE).toFixed(6)));
  assert.match(orders[0].reason, /capped by free balance/);
});

test('an account that cannot make the minimum is skipped with a reason', () => {
  const { orders, skipped } = sizeOrders({
    side: 'buy', basis: 'equal', minSol: 0.5, maxSol: 1,
    positions: [pos('ok', 5), pos('broke', 0.01)],
  });
  assert.equal(orders.length, 1);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].label, 'broke');
  assert.match(skipped[0].reason, /fee reserve/);
});

test('total is refused above the MAX_BLOCK_TRADE_SOL ceiling', () => {
  assert.throws(
    () => sizeOrders({ side: 'buy', basis: 'equal', minSol: 0, maxSol: 3,
      positions: [pos('a', 50), pos('b', 50)] }),
    /over the 5 SOL ceiling/
  );
});

test('sell takes the same percentage of every position', () => {
  const { orders, skipped } = sizeOrders({
    side: 'sell', sellPct: 25,
    positions: [pos('a', 1, 100, 1000), pos('b', 1, 100, 400), pos('none', 1, 100, 0)],
  });
  assert.deepEqual(orders.map((o) => o.amount), [250, 100]);
  assert.equal(orders[0].amountUnit, 'tokens');
  assert.match(skipped[0].reason, /no position/);
});

test('bad ranges are rejected', () => {
  assert.throws(() => sizeOrders({ side: 'buy', minSol: 1, maxSol: 0.5, positions: [pos('a', 5)] }), /minSol/);
  assert.throws(() => sizeOrders({ side: 'sell', sellPct: 0, positions: [pos('a', 5)] }), /sellPct/);
});

test('watch-only accounts are never sized, on either side', () => {
  const watcher = { ...pos('observer', 50, 100, 5000) };
  watcher.account.custody = 'watch';

  const buy = sizeOrders({ side: 'buy', basis: 'equal', minSol: 0.01, maxSol: 0.1,
    positions: [pos('tradeable', 50), watcher] });
  assert.deepEqual(buy.orders.map((o) => o.label), ['tradeable']);
  assert.match(buy.skipped.find((s) => s.label === 'observer').reason, /watch-only/);

  const sell = sizeOrders({ side: 'sell', sellPct: 50,
    positions: [pos('tradeable', 5, 100, 200), watcher] });
  assert.deepEqual(sell.orders.map((o) => o.label), ['tradeable']);
  assert.match(sell.skipped.find((s) => s.label === 'observer').reason, /watch-only/);
});

test('phantom accounts are sized and counted as needing approval', () => {
  const ph = pos('phantom-wallet', 10);
  ph.account.custody = 'phantom';
  const { orders, phantomLegs } = sizeOrders({
    side: 'buy', basis: 'equal', minSol: 0.01, maxSol: 0.2,
    positions: [pos('server-signed', 10), ph],
  });
  assert.equal(orders.length, 2);
  assert.equal(phantomLegs, 1);
  assert.equal(orders.find((o) => o.label === 'phantom-wallet').custody, 'phantom');
  assert.equal(orders.find((o) => o.label === 'server-signed').custody, 'keystore');
});

test("a phantom account's mandate ceiling still binds", () => {
  const ph = pos('phantom-wallet', 10, 0.05);
  ph.account.custody = 'phantom';
  const { orders } = sizeOrders({ side: 'buy', basis: 'equal', minSol: 0.01, maxSol: 1, positions: [ph] });
  assert.equal(orders[0].amount, 0.05);
  assert.match(orders[0].reason, /capped by mandate/);
});
