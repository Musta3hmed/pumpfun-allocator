import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const config = {
  root,
  dataDir: path.join(root, 'data'),
  keystorePath: path.join(root, 'data', 'keystore.json'),
  dbPath: path.join(root, 'data', 'ledger.db'),

  rpcUrl: process.env.RPC_URL || 'https://api.mainnet-beta.solana.com',
  pumpPortalUrl: process.env.PUMPPORTAL_URL || 'https://pumpportal.fun/api/trade-local',

  host: process.env.HOST || '127.0.0.1',
  port: Number(process.env.PORT || 8787),

  maxBlockTradeSol: Number(process.env.MAX_BLOCK_TRADE_SOL || 5),
  maxConcurrency: Math.max(1, Number(process.env.MAX_CONCURRENCY || 3)),

  passphrase: process.env.KEYSTORE_PASSPHRASE || '',
};
