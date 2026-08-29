# pump.fun Block Trade Allocator

Managed-account trading for pump.fun / PumpSwap. You make one investment decision;
it is allocated across the client accounts you manage, sized within a range you set,
and every fill is written to a per-client audit ledger.

## What it does

- **Encrypted keystore** — each client's secret key sealed individually with AES-256-GCM
  under a scrypt-derived passphrase. Decrypted per signature, zeroed immediately after.
  Keys are added via CLI, never typed into the browser.
- **Mandate record** — every account carries the client's name, the agreement reference,
  its signed date, and the per-trade ceiling that client authorized. The allocator will
  not size an order above that ceiling.
- **Allocator** — pro-rata (size scales with each client's free capital, so everyone
  ends up with a comparable percentage position) or equal notional. Clamped per account
  by mandate and by real balance less a fee reserve.
- **Executor** — each account builds, signs, and submits its own transaction at low
  concurrency. One client's failure does not abort the others.
- **Ledger** — append-only SQLite. What was decided, what each client got and why,
  what filled, what it cost.
- **Token preview** — paste a mint and get its market cap, price, liquidity, 24h
  volume and price changes, plus a candlestick chart at 5m/1h/4h/1d. Works both
  while a token is still on the bonding curve and after it graduates.
- **Phantom wallets** — link an account by public key, with no secret key on this
  machine at all.

## Account custody

Three kinds of account, and the difference decides what the allocator may do:

| Custody | Key lives | In block trades | Signing |
|---|---|---|---|
| `keystore` | encrypted on this machine | yes | server signs unattended |
| `phantom` | in the client's Phantom | yes | you approve each leg in the browser |
| `watch` | nowhere here | never | not traded, only tracked |

A Phantom account cannot be traded unattended — that is the point of it, not a
limitation to work around. Phantom signs interactively, so each block trade pauses
on its leg and waits for a human approval. The ledger records the leg as *awaiting
approval* until the browser reports back, so a leg nobody approved is never written
down as filled. If you want a client's orders to fill without someone clicking, that
client's key has to be in the keystore, and you should be certain your mandate
actually covers holding it.

Watch-only accounts are for reporting: balances and positions show in the dashboard,
and the allocator skips them with a stated reason on every trade.

## Install

Download **[install.ps1](https://raw.githubusercontent.com/Musta3hmed/pumpfun-allocator/main/install.ps1)**,
then run it from PowerShell:

```powershell
.\install.ps1
```

That fetches the repo into `%USERPROFILE%\pumpfun-allocator`, installs dependencies,
creates your `.env`, and runs the test suite. Re-running it updates an existing
install in place and leaves your `.env`, keystore, and ledger untouched.

Options: `-Path D:\trading` to install elsewhere, `-Start` to launch the dashboard
when it finishes, `-SkipTests` to skip verification.

Requires Node.js 24 or newer (the ledger uses the built-in `node:sqlite` module).

<details>
<summary>Manual install</summary>

```bash
git clone https://github.com/Musta3hmed/pumpfun-allocator.git
cd pumpfun-allocator && npm ci && cp .env.example .env
```
</details>

## Setup

Set at minimum `RPC_URL` in `.env` (use a private RPC — the public endpoint will
drop fills) and `MAX_BLOCK_TRADE_SOL`.

Add a client account whose key you hold:

```bash
npm run wallet -- add
```

Or link a wallet with no key on this machine: click **Connect Phantom** in the
dashboard, choose *Signs in browser* or *Watch only*, and approve the signature
request. That request proves control of the wallet — it authorizes no transfer and
moves no funds. The challenge is single-use, so a captured signature cannot be
replayed to register the wallet somewhere else.

Run the dashboard:

```bash
npm start
```

It binds loopback only. It has no authentication and can move client funds, so it
refuses to bind a public interface unless you set `ALLOW_REMOTE=yes` — do that only
behind a proxy that actually authenticates.

## Using it

1. Enter the mint, pick buy/sell, set the per-account SOL range and sizing basis.
2. **Preview allocation** — reads live balances and shows exactly what each client
   would get and why, including who is skipped and for what reason.
3. **Execute** — re-plans against live balances (it does not trust the previewed plan),
   then signs per account.

## Chrome extension

`extension/` is an unpacked MV3 extension: a toolbar popup showing server status,
an account summary by custody, total tracked SOL, and a token lookup with market
cap, price, liquidity, 24h change and a sparkline.

Install it:

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → select the `extension` folder
4. Pin it from the puzzle-piece menu

### What the extension is and is not

It is a control panel, not the program. The allocator is a Node process — scrypt
key derivation, AES-GCM decryption, transaction building, the SQLite ledger, RPC
calls — and none of that can run inside a Chrome extension. The popup talks to the
local server over `host_permissions` and hands off to the dashboard tab for
anything that signs.

Phantom is the second reason for that split, and the more important one: a wallet
extension injects `window.solana` into ordinary web pages, **not** into another
extension's popup. Putting the dashboard inside the extension would break Phantom
linking outright. The popup therefore opens the dashboard as a normal page, which
is where Phantom works.

The popup is read-only by design. It shows status and looks up tokens; it cannot
place, size, or approve a trade. Everything that moves money stays on the dashboard
behind the preview-then-execute flow.

Note the server deliberately sends no CORS headers. The extension reaches it
through `host_permissions`, which bypasses CORS for the granted host without
opening the API to web pages or to other installed extensions.

## Market data

Two free, key-less sources, both display-only — nothing in the trading path reads
them, so an outage degrades the preview and does not affect execution:

- **DexScreener** for price, market cap, liquidity, volume and the pair address.
- **GeckoTerminal** for OHLCV candles, drawn as an inline SVG chart.

The chart is drawn here rather than embedded from DexScreener: their embed iframe
depends on a socket session that often never resolves when framed, which leaves a
permanent "Loading pair" box. Fetching the candles means the panel either shows real
data or says plainly that it could not get any. GeckoTerminal's free tier is rate
limited, so cached candles are served with a note when the limit is hit.

## What this deliberately does not do

There is no Jito bundling and no randomized timing jitter between accounts. Both exist
to make coordinated wallets appear unrelated and to land them in the same block — useful
for simulating organic demand on a launch, not for allocating a real trade. Fills here
land in whatever order the network gives them, and the ledger records the true sequence.

## Before you run this with client money

This is trading software, not a compliance program. Managing other people's money is a
regulated activity in most jurisdictions — depending on where you and your clients are,
it can require registration as an investment adviser or fund manager, written
discretionary-authority agreements, custody arrangements, and disclosure. The mandate
fields in the keystore record that authority; they do not create it. Get a securities
lawyer in your jurisdiction to look at your structure before the first trade.

Also worth being blunt about the asset: pump.fun tokens are overwhelmingly short-lived
and most lose most of their value. Deploying client capital into them carries an
obligation to have said so plainly, in writing, before you start.
