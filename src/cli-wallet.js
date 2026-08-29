#!/usr/bin/env node
import readline from 'node:readline';
import { Writable } from 'node:stream';
import { listAccounts, addAccount, removeAccount, setEnabled } from './keystore.js';
import { config } from './config.js';

/**
 * Keystore CLI. Adding an account is done here rather than in the browser so a
 * client's secret key is never typed into a web form or posted over HTTP.
 *
 *   npm run wallet -- list
 *   npm run wallet -- add
 *   npm run wallet -- enable <id> | disable <id> | remove <id>
 */

function ask(question, { hidden = false } = {}) {
  const muted = new Writable({
    write(chunk, enc, cb) {
      if (!hidden) process.stdout.write(chunk, enc);
      cb();
    },
  });
  const rl = readline.createInterface({ input: process.stdin, output: muted, terminal: true });
  return new Promise((resolve) => {
    process.stdout.write(question);
    rl.question('', (answer) => {
      if (hidden) process.stdout.write('\n');
      rl.close();
      resolve(answer.trim());
    });
  });
}

const [cmd, arg] = process.argv.slice(2);

if (cmd === 'list' || !cmd) {
  const accounts = listAccounts();
  if (accounts.length === 0) console.log('keystore is empty — run: npm run wallet -- add');
  for (const a of accounts) {
    console.log(
      `${a.enabled ? '●' : '○'} ${a.label}  ${a.pubkey}\n` +
      `   client ${a.mandate.clientName} · agreement ${a.mandate.agreementRef} ` +
      `· signed ${a.mandate.signedAt} · cap ${a.mandate.maxPerTradeSol} SOL\n` +
      `   id ${a.id}`
    );
  }
} else if (cmd === 'add') {
  console.log(
    'Adding a managed account. The mandate fields record the written authority you\n' +
    'have to trade this person\'s money — fill them in truthfully.\n'
  );
  const label = await ask('label (e.g. "Dana R — growth"): ');
  const clientName = await ask('client legal name: ');
  const agreementRef = await ask('agreement reference (contract id / file path): ');
  const signedAt = await ask('agreement signed date (YYYY-MM-DD): ');
  const maxPerTradeSol = await ask('max SOL this client authorized per trade: ');
  const secretKeyBase58 = await ask('base58 secret key (hidden): ', { hidden: true });
  const passphrase = config.passphrase || (await ask('keystore passphrase (hidden): ', { hidden: true }));

  const account = addAccount({
    label,
    secretKeyBase58,
    passphrase,
    mandate: { clientName, agreementRef, signedAt, maxPerTradeSol },
  });
  console.log(`\nadded ${account.label} → ${account.pubkey}`);
} else if (cmd === 'enable' || cmd === 'disable') {
  console.log(setEnabled(arg, cmd === 'enable'));
} else if (cmd === 'remove') {
  console.log(removeAccount(arg));
} else {
  console.log('usage: npm run wallet -- [list|add|enable <id>|disable <id>|remove <id>]');
  process.exit(1);
}
