import crypto from 'node:crypto';
import { config } from './config.js';
import { withKeypair } from './keystore.js';
import { buildTradeTx, signAndSend, confirm } from './pumpfun.js';
import { recordBlockTrade, recordLeg, markSubmitted, settleLeg } from './ledger.js';

/**
 * Execute a plan produced by the allocator.
 *
 * Legs run at low concurrency and each account signs and submits its own
 * transaction independently. There is deliberately no bundling and no timing
 * jitter: fills land in whatever order the network gives them, which is what an
 * allocation is, and the ledger records the real sequence.
 *
 * A failed leg does not abort the run — the other clients' orders still execute
 * and the failure is recorded against that client alone.
 */
export async function executePlan(plan, { slippagePct, priorityFee, passphrase, note }) {
  const blockTradeId = crypto.randomUUID();
  const createdAt = new Date().toISOString();

  recordBlockTrade({
    id: blockTradeId,
    createdAt,
    side: plan.side,
    mint: plan.mint,
    basis: String(plan.basis),
    minSol: plan.minSol ?? null,
    maxSol: plan.maxSol ?? null,
    sellPct: plan.sellPct ?? null,
    slippageBps: Math.round(slippagePct * 100),
    priorityFee,
    totalSol: plan.totalSol,
    note: note || null,
  });

  const legs = plan.orders.map((o) => ({
    id: crypto.randomUUID(),
    blockTradeId,
    accountId: o.accountId,
    label: o.label,
    pubkey: o.pubkey,
    clientName: o.clientName,
    agreementRef: o.agreementRef,
    side: plan.side,
    mint: plan.mint,
    amount: o.amount,
    amountUnit: o.amountUnit,
    reason: o.reason,
    status: 'pending',
    order: o,
  }));

  for (const leg of legs) {
    const { order, ...row } = leg;
    recordLeg(row);
  }

  const results = [];
  const queue = [...legs];

  const worker = async () => {
    while (queue.length) {
      const leg = queue.shift();
      try {
        const signature = await withKeypair(leg.accountId, passphrase, async (kp) => {
          const tx = await buildTradeTx({
            publicKey: leg.pubkey,
            action: plan.side,
            mint: plan.mint,
            amount: leg.order.amount,
            denominatedInSol: leg.order.denominatedInSol,
            slippagePct,
            priorityFee,
          });
          const sig = await signAndSend(tx, kp);
          markSubmitted(leg.id);
          return sig;
        });

        await confirm(signature);
        settleLeg(leg.id, { status: 'confirmed', signature });
        results.push({ legId: leg.id, label: leg.label, status: 'confirmed', signature });
      } catch (err) {
        const message = String(err?.message || err);
        settleLeg(leg.id, { status: 'failed', error: message });
        results.push({ legId: leg.id, label: leg.label, status: 'failed', error: message });
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(config.maxConcurrency, legs.length) }, worker)
  );

  return {
    blockTradeId,
    submitted: legs.length,
    confirmed: results.filter((r) => r.status === 'confirmed').length,
    failed: results.filter((r) => r.status === 'failed').length,
    skipped: plan.skipped,
    results,
  };
}
