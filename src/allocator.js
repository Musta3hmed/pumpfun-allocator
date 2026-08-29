import { config } from './config.js';
import { solBalance, tokenBalance } from './pumpfun.js';

/** Left in every account for fees and ATA rent; never allocated. */
export const SOL_RESERVE = 0.02;

const round = (n, dp = 6) => Number(n.toFixed(dp));

/**
 * Pure sizing. Takes positions already read from chain and returns the orders.
 * Separated from I/O so the allocation math can be tested without a network.
 *
 * Buys are sized within the [minSol, maxSol] range you set:
 *   - basis 'equal'    — every account gets maxSol, then clamped down.
 *   - basis 'pro-rata' — size scales linearly with each account's free capital,
 *                        so the largest account gets maxSol and the smallest minSol.
 *                        This is the honest default: a client with twice the money
 *                        under management takes twice the exposure, so everyone
 *                        ends up with a comparable percentage position.
 *
 * Sells take the same percentage of each account's existing position, so every
 * client exits at the same proportion of their holding.
 *
 * Each account is clamped by (a) its own mandate ceiling and (b) its actual
 * balance less the fee reserve. An account that cannot take the minimum is
 * skipped with a stated reason rather than silently under-filled.
 */
export function sizeOrders({ side, positions, basis = 'pro-rata', minSol = 0, maxSol = 0, sellPct = 100 }) {
  const orders = [];
  const skipped = [];

  if (side === 'sell') {
    const pct = Number(sellPct);
    if (!(pct > 0 && pct <= 100)) throw new Error('sellPct must be in (0, 100]');
    for (const p of positions) {
      if (p.tokens <= 0) {
        skipped.push({ ...summarize(p), reason: 'holds no position in this mint' });
        continue;
      }
      if (p.sol < SOL_RESERVE) {
        skipped.push({ ...summarize(p), reason: `needs ~${SOL_RESERVE} SOL for fees, has ${round(p.sol, 4)}` });
        continue;
      }
      orders.push({
        ...summarize(p),
        amount: round(p.tokens * (pct / 100)),
        amountUnit: 'tokens',
        denominatedInSol: false,
        reason: `${pct}% of a ${round(p.tokens)} token position`,
      });
    }
    return { basis: `${pct}% of position`, orders, skipped, totalSol: 0 };
  }

  const lo = Number(minSol);
  const hi = Number(maxSol);
  if (!(hi > 0)) throw new Error('maxSol must be greater than 0');
  if (lo < 0 || lo > hi) throw new Error('minSol must be between 0 and maxSol');

  const investable = positions.map((p) => Math.max(0, p.sol - SOL_RESERVE));
  const lowBal = Math.min(...investable);
  const highBal = Math.max(...investable);
  const spread = highBal - lowBal;

  for (const [i, p] of positions.entries()) {
    const free = investable[i];
    const mandateCap = p.account.mandate.maxPerTradeSol;

    let target;
    let reason;
    if (basis === 'equal') {
      target = hi;
      reason = `equal sizing at ${hi} SOL`;
    } else {
      const share = spread > 0 ? (free - lowBal) / spread : 1;
      target = lo + (hi - lo) * share;
      reason = `pro-rata: ${round(free, 4)} SOL free, ${(share * 100).toFixed(0)}% of the range`;
    }

    if (target > mandateCap) {
      target = mandateCap;
      reason += `; capped by mandate at ${mandateCap} SOL`;
    }
    if (target > free) {
      target = free;
      reason += `; capped by free balance at ${round(free, 4)} SOL`;
    }
    target = round(target);

    if (target <= 0 || target < lo) {
      skipped.push({
        ...summarize(p),
        reason:
          target <= 0
            ? `no free balance after the ${SOL_RESERVE} SOL fee reserve`
            : `sizes to ${target} SOL, below the ${lo} SOL minimum`,
      });
      continue;
    }

    orders.push({
      ...summarize(p),
      amount: target,
      amountUnit: 'SOL',
      denominatedInSol: true,
      reason,
    });
  }

  const totalSol = round(orders.reduce((s, o) => s + o.amount, 0));
  if (totalSol > config.maxBlockTradeSol) {
    throw new Error(
      `block trade totals ${totalSol} SOL, over the ${config.maxBlockTradeSol} SOL ceiling in MAX_BLOCK_TRADE_SOL`
    );
  }

  return { basis, orders, skipped, totalSol };
}

/** Read live balances for the enabled accounts, then size the block trade. */
export async function planBlockTrade({ side, mint, accounts, basis, minSol, maxSol, sellPct }) {
  if (side !== 'buy' && side !== 'sell') throw new Error("side must be 'buy' or 'sell'");
  if (!mint) throw new Error('mint is required');

  const active = accounts.filter((a) => a.enabled);
  if (active.length === 0) throw new Error('no enabled accounts');

  const positions = await Promise.all(
    active.map(async (a) => ({
      account: a,
      sol: await solBalance(a.pubkey),
      tokens: side === 'sell' ? await tokenBalance(a.pubkey, mint) : 0,
    }))
  );

  return { side, mint, ...sizeOrders({ side, positions, basis, minSol, maxSol, sellPct }) };
}

function summarize(p) {
  return {
    accountId: p.account.id,
    label: p.account.label,
    pubkey: p.account.pubkey,
    clientName: p.account.mandate.clientName,
    agreementRef: p.account.mandate.agreementRef,
    solBalance: round(p.sol, 4),
    tokenBalance: round(p.tokens),
  };
}
