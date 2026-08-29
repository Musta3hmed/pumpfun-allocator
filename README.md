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

## Setup

```bash
cd pumpfun-allocator && npm install
```

Copy `.env.example` to `.env` and set at minimum `RPC_URL` (use a private RPC — the
public endpoint will drop fills) and `MAX_BLOCK_TRADE_SOL`.

Add a client account:

```bash
npm run wallet -- add
```

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
