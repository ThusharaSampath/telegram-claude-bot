# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Telegram bot + bank-SMS ingester that parses free-text expenses/income with the Claude Code CLI (`claude -p`) and appends rows to a Google Sheets budget workbook. All application code is a single file: `cloud-run/server.mjs` (Node 20, ESM, no framework — plain `node:http`). User-facing setup docs live in `cloud-run/README.md`.

## Commands

All run from `cloud-run/`. There is no build step, linter, or test suite.

```bash
npm install                      # deps: googleapis, @google-cloud/firestore, @anthropic-ai/claude-code (provides the `claude` binary)
./deploy.sh                      # gcloud run deploy --source . (project serendib-custom, us-central1); reads .env; override via PROJECT/REGION/SERVICE env
./set-webhook.sh <CLOUD_RUN_URL> # register Telegram webhook at <url>/telegram with the secret token
gcloud run services logs read telegram-expense-bot --region us-central1
```

Running locally (`npm start`) needs `TELEGRAM_BOT_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `SPREADSHEET_ID` (startup throws without them), `GOOGLE_APPLICATION_CREDENTIALS` for Sheets/Firestore ADC, `claude` on PATH (`node_modules/.bin`), and `WORK_DIR=./tmp` (default is `/app/tmp`). Exercise it by POSTing a Telegram update JSON to `/telegram` or `{"text": "..."}` to `/ingest` with `X-Ingest-Secret`.

## Architecture

Endpoints: `GET /health`, `POST /telegram` (checked against `X-Telegram-Bot-Api-Secret-Token`), `POST /ingest` (checked against `X-Ingest-Secret`; disabled if `INGEST_SECRET` is empty).

**Await-then-ack is required.** Both handlers fully finish the Claude parse and sheet write *before* sending the HTTP 200. Cloud Run throttles CPU after the response, so moving work into the background after `send()` silently breaks it. Don't "optimize" this.

**Two parse paths, both via `runClaude()`** (spawns `claude -p --model $MODEL --output-format json <prompt>` with `HOME=/tmp`):
- `buildPrompt` / `parseMessage` — typed Telegram messages → `{type: expense|income, date, amount, currency, description, category}`.
- `buildSmsPrompt` / `parseSms` — raw bank SMS → adds `type: ignore|unclear`, `confidence`, `reason`. The prompt encodes money direction (debit vs credit) as the main signal and lists what is safe to ignore (FD renewals, inward card-bill payments, OTPs). Outward transfers are expenses and must go to `unclear`, not `ignore`.
- `parseJsonResult` strips ```` ```json ```` fences/prose before `JSON.parse` because Claude sometimes adds them.
- `CATEGORIES` / `INCOME_CATEGORIES` must match the workbook's category lists exactly.

**SMS flow (`ingestSms`)**: `ignore` → short "Skipped" note; `unclear`, low confidence, or no amount → bot asks a question and stores a pending question; otherwise write. SMS have no chat, so replies go to the last chat that messaged the bot (`bot_meta/last_chat`, falling back to `ALLOWED_CHAT_IDS[0]`).

**Clarification via quote-reply**: pending questions are keyed by the Telegram `message_id` of the bot's question (`pending_questions/<msgId>`). A user message counts as an answer only if `reply_to_message.message_id` matches a pending doc. It is then re-parsed with `parseMessage(text, smsContext)`, which passes the original SMS along. A non-quoted message is always a new entry. A reply of `ignore`/`skip`/`no` clears the pending question.

**Sheet writes (`appendTransaction`)**: Tab `SHEET_NAME` (default `Transactions`), data from row 4. Expenses go in `B:E`, income in `G:J` (`BLOCKS`). The target row comes after the *last* non-empty amount cell in the block, not the first gap, so blank spacer rows are kept. Writes use `USER_ENTERED`, so formulas are evaluated.

**Currency**: `applyCurrencyConversion` (called in `writeAndNotify`, which covers every write path) turns any non-`SHEET_CURRENCY` amount into `=<amt>*GOOGLEFINANCE("CURRENCY:XXXLKR")` via `tx.amountCell`, and appends the original amount to the description. The comment on `SHEET_CURRENCY` near the top of `server.mjs` ("not auto-written; the bot asks you instead") is stale.

**Firestore collections**: `bot_targets/<chatId>` holds the active spreadsheet per chat. It is set by `/sheet <link|id>` after `validateSheet` checks access and that the tab exists, and falls back to `SPREADSHEET_ID`. Also used: `bot_meta/last_chat` and `pending_questions/<msgId>`.

## Deployment notes

- `deploy.sh` passes config as `--set-env-vars` (secrets in a second flag using the `^@@^` delimiter so values can hold commas). New env vars must be added there as well as in `.env.example`.
- The service account `telegram-expense-bot@serendib-custom.iam.gserviceaccount.com` needs Editor access to each target sheet and `roles/datastore.user`. The Sheets API must be enabled.
- `.dockerignore` excludes `*.md` and `.env`. The Dockerfile copies only `package.json` and `server.mjs`, so any new source file must be added to the Dockerfile.
- `*.xlsx` is git-ignored because it holds real financial data. Never commit the budget workbook.
