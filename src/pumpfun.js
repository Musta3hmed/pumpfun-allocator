import {
  Connection,
  PublicKey,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import { config } from './config.js';

export const connection = new Connection(config.rpcUrl, 'confirmed');

/**
 * Ask PumpPortal to build an unsigned trade transaction against the pump.fun
 * bonding curve (or PumpSwap once the token has graduated — `pool: 'auto'` picks).
 * We sign it here; the key never leaves this process.
 */
export async function buildTradeTx({
  publicKey,
  action,
  mint,
  amount,
  denominatedInSol,
  slippagePct,
  priorityFee,
}) {
  const res = await fetch(config.pumpPortalUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      publicKey,
      action,
      mint,
      amount,
      denominatedInSol: denominatedInSol ? 'true' : 'false',
      slippage: slippagePct,
      priorityFee,
      pool: 'auto',
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`PumpPortal ${res.status}: ${body.slice(0, 300)}`);
  }

  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length === 0) throw new Error('PumpPortal returned an empty transaction');
  return VersionedTransaction.deserialize(buf);
}

/** Sign with the client's key and submit. Returns the signature. */
export async function signAndSend(tx, keypair) {
  tx.sign([keypair]);
  return connection.sendTransaction(tx, {
    skipPreflight: false,
    maxRetries: 3,
    preflightCommitment: 'confirmed',
  });
}

export async function confirm(signature) {
  const latest = await connection.getLatestBlockhash('confirmed');
  const result = await connection.confirmTransaction(
    { signature, ...latest },
    'confirmed'
  );
  if (result.value.err) {
    throw new Error(`transaction failed on-chain: ${JSON.stringify(result.value.err)}`);
  }
  return signature;
}

/**
 * Bound an RPC call in wall-clock time.
 *
 * web3.js retries internally with backoff, so a rate-limited public endpoint can
 * leave a request outstanding for a very long time. Anything the dashboard waits
 * on needs a ceiling, or a slow RPC turns into a panel that says "loading" forever.
 */
export function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export async function solBalance(pubkey, timeoutMs = 8000) {
  const lamports = await withTimeout(
    connection.getBalance(new PublicKey(pubkey), 'confirmed'),
    timeoutMs,
    `balance lookup for ${pubkey.slice(0, 8)}…`
  );
  return lamports / LAMPORTS_PER_SOL;
}

/** UI-denominated token balance for `mint` held by `pubkey`, 0 if no account. */
export async function tokenBalance(pubkey, mint, timeoutMs = 10000) {
  const resp = await withTimeout(
    connection.getParsedTokenAccountsByOwner(
      new PublicKey(pubkey),
      { mint: new PublicKey(mint) },
      'confirmed'
    ),
    timeoutMs,
    `token balance lookup for ${pubkey.slice(0, 8)}…`
  );
  return resp.value.reduce(
    (sum, { account }) => sum + (account.data.parsed.info.tokenAmount.uiAmount || 0),
    0
  );
}
