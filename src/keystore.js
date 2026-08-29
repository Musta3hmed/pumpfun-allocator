import crypto from 'node:crypto';
import fs from 'node:fs';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { config } from './config.js';

/**
 * Encrypted client keystore.
 *
 * Every client account's secret key is sealed individually with AES-256-GCM under
 * a scrypt-derived key. Decryption happens per signing operation and the plaintext
 * key is zeroed immediately after — it is never held in a long-lived object and is
 * never written to the ledger, logs, or the dashboard API.
 */

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, keylen: 32 };

function deriveKey(passphrase, salt) {
  return crypto.scryptSync(passphrase, salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: 256 * 1024 * 1024,
  });
}

function seal(plaintext, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(passphrase, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  key.fill(0);
  return {
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ct.toString('base64'),
  };
}

function open(sealed, passphrase) {
  const key = deriveKey(passphrase, Buffer.from(sealed.salt, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
  try {
    const out = Buffer.concat([decipher.update(Buffer.from(sealed.ct, 'base64')), decipher.final()]);
    return out;
  } finally {
    key.fill(0);
  }
}

function readStore() {
  if (!fs.existsSync(config.keystorePath)) return { version: 1, accounts: [] };
  return JSON.parse(fs.readFileSync(config.keystorePath, 'utf8'));
}

function writeStore(store) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(config.keystorePath, JSON.stringify(store, null, 2), { mode: 0o600 });
}

/** Public account records — never includes key material. */
export function listAccounts() {
  return readStore().accounts.map((a) => ({
    id: a.id,
    label: a.label,
    pubkey: a.pubkey,
    enabled: a.enabled !== false,
    mandate: a.mandate,
    addedAt: a.addedAt,
  }));
}

export function getAccount(id) {
  return listAccounts().find((a) => a.id === id) || null;
}

/**
 * Add a client account.
 *
 * `mandate` records the authorization under which you are permitted to trade this
 * person's money — who they are, what they signed, its date, and the ceiling they
 * agreed to. It is required, and the allocator refuses to size an order above
 * `mandate.maxPerTradeSol`. This is the discretionary-authority record; if you
 * cannot fill it in truthfully for an account, you should not be trading it.
 */
export function addAccount({ label, secretKeyBase58, mandate, passphrase }) {
  if (!label) throw new Error('label is required');
  if (!passphrase) throw new Error('keystore passphrase is required');
  if (!mandate?.clientName || !mandate?.agreementRef || !mandate?.signedAt) {
    throw new Error('mandate requires clientName, agreementRef and signedAt');
  }
  const maxPerTradeSol = Number(mandate.maxPerTradeSol);
  if (!Number.isFinite(maxPerTradeSol) || maxPerTradeSol <= 0) {
    throw new Error('mandate.maxPerTradeSol must be a positive number of SOL');
  }

  const secret = bs58.decode(secretKeyBase58);
  const kp = Keypair.fromSecretKey(secret);
  const pubkey = kp.publicKey.toBase58();

  const store = readStore();
  if (store.accounts.some((a) => a.pubkey === pubkey)) {
    throw new Error(`account ${pubkey} is already in the keystore`);
  }

  const record = {
    id: crypto.randomUUID(),
    label,
    pubkey,
    enabled: true,
    addedAt: new Date().toISOString(),
    mandate: {
      clientName: mandate.clientName,
      agreementRef: mandate.agreementRef,
      signedAt: mandate.signedAt,
      maxPerTradeSol,
    },
    sealed: seal(Buffer.from(secret), passphrase),
  };
  store.accounts.push(record);
  writeStore(store);

  secret.fill(0);
  return { id: record.id, label, pubkey, mandate: record.mandate };
}

export function setEnabled(id, enabled) {
  const store = readStore();
  const acct = store.accounts.find((a) => a.id === id);
  if (!acct) throw new Error(`no such account: ${id}`);
  acct.enabled = Boolean(enabled);
  writeStore(store);
  return { id, enabled: acct.enabled };
}

export function removeAccount(id) {
  const store = readStore();
  const before = store.accounts.length;
  store.accounts = store.accounts.filter((a) => a.id !== id);
  if (store.accounts.length === before) throw new Error(`no such account: ${id}`);
  writeStore(store);
  return { id, removed: true };
}

/**
 * Decrypt one account's key, hand it to `fn`, and zero it on the way out.
 * Callers must not retain the Keypair past the callback.
 */
export async function withKeypair(id, passphrase, fn) {
  const store = readStore();
  const acct = store.accounts.find((a) => a.id === id);
  if (!acct) throw new Error(`no such account: ${id}`);
  let secret;
  try {
    secret = open(acct.sealed, passphrase);
  } catch {
    throw new Error('keystore passphrase is incorrect (GCM auth failed)');
  }
  const kp = Keypair.fromSecretKey(secret);
  try {
    return await fn(kp);
  } finally {
    secret.fill(0);
  }
}

/** Cheap check that the passphrase opens the store, before starting a trade run. */
export function verifyPassphrase(passphrase) {
  const store = readStore();
  if (store.accounts.length === 0) return true;
  try {
    open(store.accounts[0].sealed, passphrase).fill(0);
    return true;
  } catch {
    return false;
  }
}
