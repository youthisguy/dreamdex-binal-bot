# Binal Bot

**A validated, autonomous, and copyable trading agent for DreamDEX Event Contracts.**

 Every decision (trade or skip) is logged in it's journal with full reasoning. Every result is posted publicly and linked back to the call that produced it. And anyone can follow the bot's exact trades with their own funds, non-custodially, with a withdrawal path under their control.

**Live:** [Dashboard](https://dreamdex-binal-bot-ftt9.onrender.com) · [Copy Trade](https://dreamdex-binal-bot-ftt9.onrender.com/copy-trade.html) · [Telegram](https://t.me/binal_bot_signals)

---

## What it is

Binal Bot is an automated signal bot trading binary Up/Down event contracts on [DreamDEX](https://docs.dreamdex.io) (Somnia). It watches short-window markets, computes a fair probability against the market's own price, and takes a directional position (`BUY_YES`/`BUY_NO`) whenever its edge clears a threshold, never outside the odds regime its edge was proven in.

Every signal is logged, posted to the Binal Bot Signals Telegram channel as a stat-card image, and shown on the [agent dashboard](https://dreamdex-binal-bot-ftt9.onrender.com) in real time. On top of that, a copy-trade system lets any wallet holder mirror Binal's signals automatically with their own funds, sized to their own risk tolerance.

---

## The signal

DreamDEX's own reference implementation for Event Contract trading explicitly documents its forecasting model as a placeholder. Binal Bot fills that gap with a real one: an EMA(3)/EMA(12) momentum crossover, validated through a full research pipeline — 180 days of BTC/ETH price history, a 36-combination grid search with Bonferroni-corrected significance testing, and a chronological walk-forward split that never let the model see its own test data. The result held up out-of-sample: a **56.8% win rate on fully unseen data, statistically significant at p=0.00033**.

That signal now runs live, gated by risk controls tuned against real production behavior:

- **Window filter** — restricts trading to the validated 15-minute horizon (`OF_ALLOWED_WINDOWS_MIN`), since the signal was never backtested on longer windows the platform also offers
- **Momentum-required gate** — a trade only fires when the validated EMA signal actually contributed (`OF_REQUIRE_MOMENTUM`), not when the platform's own unvalidated strike/moneyness pricing alone would trigger one
- **Entry-price ceiling** — refuses entries priced above a configurable threshold (`OF_MAX_ENTRY_PRICE`), keeping the bot inside the odds regime its win rate was actually proven at rather than laying unfavorable prices on deep favorites

---

## The transparency layer

Every trade is written to a structured, append-only journal the moment it happens — reasoning, entry odds, the reference price it's trading against, and a direct link to the market on-chain. A live dashboard reads that journal in real time: running win rate, cumulative PnL, and — just as importantly — why the bot chose *not* to trade on every pass it sat out, so its discipline is as visible as its wins.

The same data feeds a public Telegram channel. Every signal posts as a rich card — direction, edge, entry price, stake size, time remaining, and the bot's running track record — with a one-tap link straight into the DreamDEX market. When that market settles, the result posts as a reply to the original call, so the outcome is permanently and visibly tied to the reasoning that produced it. Nothing gets edited away, nothing gets cherry-picked.

## The persistence layer

Because the bot runs on infrastructure with ephemeral disk, trade history is checkpointed to GitHub automatically — every decision and every settlement commits and pushes in the background, and a fresh deployment restores full history before the bot ever takes its first action. A redeploy, a crash, a platform migration: the track record survives all of it, verifiable in the same repository the code lives in.

## Copy trading

Binal Bot's signals aren't just observable — they're actionable. `CopyVault` is a non-custodial, per-user smart contract that lets anyone follow the bot's exact trades with their own funds: deposit, set a per-trade size cap, opt in, and every signal the bot takes is mirrored into your own position automatically.

- **Not pooled.** Every user's balance and every position is tracked individually — no shared pool, no share-price math, no cross-user contamination.
- **Withdrawal always works**, independent of operator or copy-toggle state. That's the real kill switch.
- **Fees apply only to realized profit**, hard-capped in the contract itself — never on deposits, never on losses.
- **The operator can only act for users who explicitly opted in**, capped per-trade by each user's own self-set size limit. It can never touch a non-opted-in user, and can never withdraw anyone's funds.

---

## Architecture

Two independent deployments, deliberately decoupled — the copy-trade service can be down, slow, or mid-redeploy without ever affecting the main bot's own trading loop.

**1. Main bot** — runs the trading loop and serves the live dashboard.
**2. Copy-trade service** — a fully standalone Node service (only `ethers` + `better-sqlite3`, no shared code with the main bot's monorepo). Talks to the bot only via two webhooks (push, not poll), and to the blockchain directly.

### Main bot components

| File | Role |
|---|---|
| `index.ts` | Main loop: scans markets, computes edge, places the bot's own trade via `ec-core`'s `placeLimit`, writes the journal entry, fires the copy-signal webhook, posts to Telegram |
| `signal.ts` | Signal/edge computation logic |
| `journal.ts` | Append-only JSONL trade history (`logs/decisions.jsonl`); `backfillSettlements()` polls for resolved markets and fires the copy-settlement webhook |
| `telegram.ts` / `card.ts` / `embedded-fonts.ts` / `social-format.ts` | Posts each signal to Telegram as a rendered stat-card image with inline buttons |
| `checkpoint.ts` | Commits the journal to GitHub on every write, since Render's disk is ephemeral |
| `position.ts` | Net/gross exposure accounting (YES vs NO offsetting) |
| `timeout.ts` | Wraps SDK calls in a timeout so a hung network call can't freeze the sequential main loop |
| `copy-signal.ts` | Fire-and-forget POSTs to the copy-service — `notifyCopyService()` on every signal, `notifyCopySettlement()` on every resolution. No-op unless `COPY_SERVICE_URL` is set |
| `index.html` + `server.mjs` / `prod-server.mjs` | Static dashboard showing the live decision feed; serves any file dropped in the same directory, including the copy-trade page |

### Copy-trade components

| File | Role |
|---|---|
| `CopyVault.sol` | Deployed contract. Per-user tracked balances (not pooled). `deposit`/`withdraw` always available to the user. Operator can only `openPositionFor`/`settlePosition` on users who opted in (`copyEnabled`), capped per-trade by each user's own `tradeSize`. Fee taken only on realized profit, hard-capped at 20% in code |
| `local-server.mjs` | Standalone backend. Receives signal/settlement webhooks, opens/settles vault positions as the operator, tracks trade history + leaderboard in SQLite, serves the dashboard's API |
| `copy-trade.html` | Dashboard page: wallet connect (MetaMask, auto-prompts adding Somnia Shannon Testnet), deposit/withdraw, set trade-size cap, enable/disable copying, live leaderboard and personal trade history |

---

## Execution flow, end to end

**Signal → trade → copy:**

1. `index.ts` finds a tradable market with sufficient edge and places its own order via `ec-core`.
2. Writes a `decision` record to the journal (the dashboard picks this up immediately).
3. Fires `notifyCopyService()` — fire-and-forget, 5s timeout — with `{ marketId, symbol, side, price, pool, expiryMs }`. `pool` is included specifically so the copy-service never needs `ec-core` access of its own.
4. Posts the signal to Telegram (independent of step 3 — one failing doesn't block the other).
5. `local-server.mjs` receives the signal, loops over every registered wallet, checks `getAccount()` on-chain for `copyEnabled` and available balance, sizes each user's trade at `min(tradeSize, idleBalance)`, and calls `openPositionFor` as the operator for each opted-in user.
6. Each open position is recorded in SQLite with its transaction hash.

**Settlement → payout:**

7. The bot's existing `backfillSettlements()` loop detects a resolved market, computes its own payout/outcome, logs it, and fires `notifyCopySettlement()` with `{ marketId, outcome, payoutPerShare }`.
8. `local-server.mjs` finds every `OPEN` copy-position on that market, scales `payoutPerShare` to each user's own share count, and calls `settlePosition` per user — the contract computes and deducts its fee on realized profit only.
9. The leaderboard and each user's PnL update from this settled data.

**User-facing flow:**

- Connect wallet → approve + `deposit()` → `setTradeSize()` (per-trade cap) → `setCopyEnabled(true)`.
- `withdraw()` always works regardless of operator or copy state — the real kill switch.
- Leaderboard and personal trade history poll `local-server.mjs`'s API every 5 seconds.

---

## Setup

```bash
git clone <this repo> && cd dreamdex-bot-kit
npm install
cp .env.example .env    # PRIVATE_KEY, NETWORK=testnet, VENUE_ID
npm start -w ec-oracle-follow
```

The bot defaults to `DRY_RUN=true` — it logs exactly what it would do without signing anything. See `strategies/ec-oracle-follow/README.md` for the full signal/config reference.

### Key environment variables

| Variable | Default | Meaning |
|---|---|---|
| `OF_ALLOWED_WINDOWS_MIN` | `15` | Only trade windows this length (minutes) — matches the validated backtest |
| `OF_REQUIRE_MOMENTUM` | `true` | Only trade when the validated EMA signal contributed |
| `OF_MAX_ENTRY_PRICE` | `0.7` | Refuse entries priced above this, regardless of raw edge size |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | — | Enables the public signal feed (opt-in, no-op unset) |
| `GITHUB_REPO` / `GITHUB_TOKEN` | — | Enables automatic journal checkpointing to git (opt-in, no-op unset) |
| `DASHBOARD_URL` | — | Public dashboard URL, linked from every Telegram post |
| `COPY_SERVICE_URL` | — | Enables the copy-trade webhook integration (opt-in, no-op unset) |

Copy-trade service setup (separate deployment):

```bash
cd copy-service
npm install
# Required: COPY_RPC_URL, COPY_VAULT_ADDRESS, COPY_BOT_OPERATOR_PRIVATE_KEY
node --env-file=.env local-server.mjs
```

---

## Status

**Confirmed working on testnet:** the full signal → validated backtest → live trading pipeline; the journal/dashboard/Telegram transparency layer, including reply-based settlement and automatic git checkpointing; and the full copy-trade path — deposit, set trade-size cap, enable/disable copying, withdraw, and the push-based signal → open-position → settle → leaderboard pipeline.

**Notes for anyone deploying this further:**
- Node is pinned to `20.18.1` for the copy-service (`better-sqlite3` has no prebuilt binary for newer Node releases and fails to compile from source against changed V8 APIs).
- The copy-service's SQLite database lives on ephemeral disk by default — a Render Persistent Disk (or equivalent) is recommended before relying on long-term trade history through redeploys.
- Both services benefit from a paid hosting tier rather than a free tier with external uptime pinging — a cold start on a free tier can occasionally exceed the signal webhook's timeout window.

---

## License & disclaimer

Built on the [DreamDEX Bot Kit](https://github.com/somnia-chain/dreamdex-bot-kit) (MIT License, © DreamDEX S.A.) — see repository for the underlying SDK, execution primitives, and event-contract mechanics this project extends.

This is educational/hackathon reference code — **not financial advice, and not audited.** Any strategy can lose funds. You are responsible for the keys you load, the parameters you set, and the funds you commit.