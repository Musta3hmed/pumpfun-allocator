/**
 * Token market data via DexScreener (no API key, no account).
 *
 * Covers a pump.fun token across its whole life: while it is still on the
 * bonding curve it appears under the 'pumpfun' dex, and after it graduates it
 * appears under 'pumpswap' or a Raydium pool. We pick the deepest pair, since
 * that is the one the trade will actually route through.
 *
 * Everything here is display-only. Nothing in the trading path reads it, so a
 * DexScreener outage degrades the preview card and does not affect execution.
 */

const ENDPOINT = 'https://api.dexscreener.com/latest/dex/tokens';
const TTL_MS = 15_000;
const cache = new Map();

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Deepest pair wins; bonding-curve pairs report no liquidity, so fall back to volume. */
function pickPair(pairs) {
  return [...pairs].sort((a, b) => {
    const liq = (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0);
    if (liq !== 0) return liq;
    return (b.volume?.h24 || 0) - (a.volume?.h24 || 0);
  })[0];
}

export async function getTokenMarket(mint) {
  const hit = cache.get(mint);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;

  const res = await fetch(`${ENDPOINT}/${encodeURIComponent(mint)}`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`DexScreener ${res.status}`);

  const body = await res.json();
  const pairs = (body.pairs || []).filter((p) => p.chainId === 'solana');

  if (pairs.length === 0) {
    const data = {
      mint,
      found: false,
      message:
        'No Solana pair found for this mint. It may be brand new, or the address may be wrong — check it before trading.',
    };
    cache.set(mint, { at: Date.now(), data });
    return data;
  }

  const p = pickPair(pairs);
  const graduated = p.dexId !== 'pumpfun';

  const data = {
    mint,
    found: true,
    name: p.baseToken?.name ?? null,
    symbol: p.baseToken?.symbol ?? null,
    dex: p.dexId,
    graduated,
    stage: graduated ? `trading on ${p.dexId}` : 'still on the pump.fun bonding curve',
    pairAddress: p.pairAddress,
    priceUsd: num(p.priceUsd),
    priceNative: num(p.priceNative),
    marketCap: num(p.marketCap),
    fdv: num(p.fdv),
    liquidityUsd: num(p.liquidity?.usd),
    volume24h: num(p.volume?.h24),
    change5m: num(p.priceChange?.m5),
    change1h: num(p.priceChange?.h1),
    change24h: num(p.priceChange?.h24),
    buys24h: p.txns?.h24?.buys ?? null,
    sells24h: p.txns?.h24?.sells ?? null,
    createdAt: p.pairCreatedAt ?? null,
    imageUrl: p.info?.imageUrl ?? null,
    chartUrl: `https://dexscreener.com/solana/${p.pairAddress}?embed=1&theme=dark&info=0&trades=0`,
    pairUrl: p.url ?? `https://dexscreener.com/solana/${p.pairAddress}`,
    pairCount: pairs.length,
    fetchedAt: new Date().toISOString(),
  };

  cache.set(mint, { at: Date.now(), data });
  return data;
}

/**
 * Candles from GeckoTerminal (also free, also no key).
 *
 * The DexScreener embed iframe is not used: it depends on a live socket session
 * that frequently never resolves when framed, leaving a permanent "Loading pair"
 * box. Fetching OHLCV and drawing the chart ourselves means the panel either
 * shows real data or says plainly that it could not get any.
 */
const GT = 'https://api.geckoterminal.com/api/v2/networks/solana';
const candleCache = new Map();
const CANDLE_TTL_MS = 30_000;

export const TIMEFRAMES = {
  '5m': { path: 'minute', aggregate: 5, limit: 72, label: '6h' },
  '1h': { path: 'hour', aggregate: 1, limit: 72, label: '3d' },
  '4h': { path: 'hour', aggregate: 4, limit: 72, label: '12d' },
  '1d': { path: 'day', aggregate: 1, limit: 90, label: '90d' },
};

export async function getCandles(pairAddress, tf = '1h') {
  const spec = TIMEFRAMES[tf];
  if (!spec) throw new Error(`unknown timeframe: ${tf}`);

  const key = `${pairAddress}:${tf}`;
  const hit = candleCache.get(key);
  if (hit && Date.now() - hit.at < CANDLE_TTL_MS) return hit.data;

  const url = `${GT}/pools/${encodeURIComponent(pairAddress)}/ohlcv/${spec.path}` +
              `?aggregate=${spec.aggregate}&limit=${spec.limit}`;

  let res;
  try {
    res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    // Network trouble: stale candles beat an empty chart, as long as we say so.
    if (hit) return { ...hit.data, stale: true, note: 'showing cached candles — the data feed is unreachable' };
    throw new Error(`could not reach the candle feed: ${err.message}`);
  }

  if (res.status === 429) {
    if (hit) return { ...hit.data, stale: true, note: 'showing cached candles — the free feed is rate limited' };
    throw new Error('the candle feed is rate limited right now; try again in a few seconds');
  }
  if (!res.ok) {
    if (hit) return { ...hit.data, stale: true, note: `showing cached candles — feed returned ${res.status}` };
    throw new Error(`GeckoTerminal ${res.status}`);
  }

  const body = await res.json();
  const list = body?.data?.attributes?.ohlcv_list || [];

  // GeckoTerminal returns newest first; charts read left to right.
  const candles = list
    .map(([t, o, h, l, c, v]) => ({ t, o: Number(o), h: Number(h), l: Number(l), c: Number(c), v: Number(v) }))
    .filter((c) => Number.isFinite(c.o) && Number.isFinite(c.c))
    .sort((a, b) => a.t - b.t);

  const data = { pairAddress, timeframe: tf, span: spec.label, candles };
  candleCache.set(key, { at: Date.now(), data });
  return data;
}
