# Telegram → Budget Sheet bot

Log expenses/income to a Google budget sheet two ways:

1. **Type them** to your Telegram bot in plain language (`lunch 850 food`,
   `got salary 250000`, `yesterday fuel 16000`).
2. **Forward bank SMS** automatically from your phone (iPhone Shortcut → `/ingest`).

A Cloud Run backend parses each message with `claude -p --model sonnet`,
classifies it, and appends a row to the **Transactions** tab. Bank SMS that
aren't transactions (FD renewals, card-bill payments, OTPs) are skipped, and
anything ambiguous is bounced back to you in Telegram to confirm.

```
You ──type──▶ Telegram ─┐
                        ├─▶ Cloud Run (server.mjs) ─┬─ claude -p  (parse → JSON)
Bank SMS ──iPhone──▶ /ingest ─┘                     └─ Google Sheets API (append)
                                                    (Firestore: target sheet,
                                                     last chat, pending questions)
```

## Sheet layout it writes to
`Transactions` tab, data starts at **row 4**:
- Expenses: `B`=Date `C`=Amount `D`=Description `E`=Category
- Income:   `G`=Date `H`=Amount `I`=Description `J`=Category

New rows are appended after the last filled entry in the relevant block.

## One-time setup

### 1. Create the Telegram bot
1. In Telegram, message **@BotFather** → `/newbot` → follow prompts.
2. Copy the **bot token** it gives you → `TELEGRAM_BOT_TOKEN` in `.env`.
3. Get your numeric chat id: message **@userinfobot**, or send your bot a message
   after deploy and read it from the Cloud Run logs. Put it in `ALLOWED_CHAT_IDS`
   so only you can write to the sheet. (The bot separately auto-remembers the last
   chat that messaged it, which is where bank-SMS confirmations are sent.)

### 2. Upload the budget to Google Sheets
1. Upload `Monthly budget - 2026 May.xlsx` to Google Drive and open it as a
   **Google Sheet** (File → Save as Google Sheets).
2. Copy the spreadsheet ID from the URL
   (`https://docs.google.com/spreadsheets/d/<THIS_IS_THE_ID>/edit`)
   → `SPREADSHEET_ID` in `.env`.

### 3. Fill `.env`
```bash
cp .env.example .env
# Required: TELEGRAM_BOT_TOKEN, SPREADSHEET_ID, CLAUDE_CODE_OAUTH_TOKEN
# Recommended: ALLOWED_CHAT_IDS (else the bot accepts anyone)
# For bank-SMS ingestion: INGEST_SECRET, and SHEET_CURRENCY (default LKR)
openssl rand -hex 32        # use output as TELEGRAM_WEBHOOK_SECRET (and INGEST_SECRET)
```
Use the same `CLAUDE_CODE_OAUTH_TOKEN` as the invoice-maker project.

### 4. Deploy (creates the service account on first run)
```bash
./deploy.sh
```
The script prints the bot's **service-account email**
(`telegram-expense-bot@serendib-custom.iam.gserviceaccount.com`).

### 5. Share the sheet with the service account
In Google Sheets → **Share** → add that service-account email as **Editor**.
(Without this the bot can read/write nothing — service accounts only see sheets
explicitly shared with them.)

### 6. Register the webhook
```bash
./set-webhook.sh <CLOUD_RUN_URL>   # URL is printed at the end of deploy.sh
```

## Test it
Message your bot: `lunch 850 food` → it should reply with the row it added and the
value should appear in the sheet.

## Auto-logging bank SMS (iPhone Shortcut → `/ingest`)

Instead of typing each expense, forward your bank's transaction SMS to the bot
and it logs them automatically.

### Endpoint
```
POST https://<CLOUD_RUN_URL>/ingest
Header:  X-Ingest-Secret: <INGEST_SECRET>
Body:    { "text": "<the full raw SMS body>" }
```
Set `INGEST_SECRET` (e.g. `openssl rand -hex 32`) in `.env` before deploying;
if it's empty the endpoint is disabled. SMS has no Telegram chat of its own, so
confirmations go to whichever chat **last messaged the bot** — message it once
(e.g. `/start`) after deploy and it remembers you (in Firestore). No chat id to
configure.

### iPhone setup (Shortcuts + Automation)
1. **Shortcuts app → Automation → New → Message → contains** (e.g. your bank's
   sender ID) → **Run Immediately** (turn off "Ask Before Running").
2. Add action **Get Contents of URL**:
   - URL: `https://<CLOUD_RUN_URL>/ingest`
   - Method: `POST`
   - Headers: `X-Ingest-Secret` = your secret, `Content-Type` = `application/json`
   - Request Body: **JSON** → key `text` = the **Shortcut Input** (the message text).

### What the bot does with each SMS
Claude classifies it, then:
- **Confident expense/income in your sheet currency** → written to the sheet,
  you get a `✓ added` confirmation.
- **Non-transaction** (FD renewal, credit-card bill payment, OTP, balance alert)
  → skipped, with a short `⏭️ Skipped (reason)` note.
- **Foreign currency** (not `SHEET_CURRENCY`) → written with a live conversion
  formula, e.g. `=16.69*GOOGLEFINANCE("CURRENCY:USDLKR")`, so the sheet shows the
  correct converted amount and keeps it current. The original amount + currency
  are kept in the description.
- **Unclear / low confidence** → the bot shows what it read and asks.
  **Quote-reply** its question (swipe-reply in Telegram) with the correct details
  (e.g. `expense 5493 groceries food`) and it's logged; quote-reply `ignore` to
  skip. Your answer is parsed together with the original SMS, so you only supply
  what was missing. Because answers are matched to the exact quoted question,
  multiple open questions don't get mixed up, and a normal (non-quoted) message
  is always treated as a brand-new entry — never as an answer to an old question.

## Switching sheets each month
The bot remembers an active target spreadsheet per chat (stored in Firestore), so
you can repoint it without redeploying:

- `/sheet <link or id>` — switch to a new sheet. The bot first checks it can open
  the sheet and that the `Transactions` tab exists, then saves it. Share each new
  month's sheet with the service account (Editor) before switching.
- `/sheet` — show the sheet currently being written to.

`SPREADSHEET_ID` in `.env` is only the *default* used until the first `/sheet`.

## Notes
- The webhook handler finishes the Claude parse + sheet write **before** acking
  Telegram. (Cloud Run throttles CPU after the response is sent, so backgrounding
  the work would silently kill it.) A Sonnet parse is well within Telegram's ~60s
  webhook timeout.
- Requires the **Google Sheets API** enabled and the service account granted
  **roles/datastore.user** (for Firestore). Both are set up already.
- `ALLOWED_CHAT_IDS` gates who can write to your sheet. Leave it set.
- **Firestore collections used:** `bot_targets` (active sheet per chat),
  `bot_meta/last_chat` (where SMS confirmations go), `pending_questions` (open
  clarifications, keyed by the bot's question message id).
- Claude occasionally wraps its JSON reply in a ```` ```json ```` fence; the
  parser strips fences/prose before `JSON.parse`, so that doesn't break parsing.
- Re-deploy after editing `server.mjs`: just run `./deploy.sh` again.
- Logs: `gcloud run services logs read telegram-expense-bot --region us-central1`.
