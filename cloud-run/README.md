# Telegram → Budget Sheet bot

Send a plain-text message to your Telegram bot (e.g. `lunch 850 food`,
`got salary 250000`, `yesterday fuel 16000`); a Cloud Run backend parses it with
`claude -p --model sonnet`, classifies it as expense/income, and appends a row to
the **Transactions** tab of your Google budget sheet.

```
You ──Telegram──▶ Bot webhook ──▶ Cloud Run (server.mjs)
                                     ├─ claude -p  (parse → JSON)
                                     └─ Google Sheets API (append row)
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
   after deploy and read it from the Cloud Run logs. Put it in `ALLOWED_CHAT_IDS`.

### 2. Upload the budget to Google Sheets
1. Upload `Monthly budget - 2026 May.xlsx` to Google Drive and open it as a
   **Google Sheet** (File → Save as Google Sheets).
2. Copy the spreadsheet ID from the URL
   (`https://docs.google.com/spreadsheets/d/<THIS_IS_THE_ID>/edit`)
   → `SPREADSHEET_ID` in `.env`.

### 3. Fill `.env`
```bash
cp .env.example .env
# Fill: TELEGRAM_BOT_TOKEN, SPREADSHEET_ID, ALLOWED_CHAT_IDS, CLAUDE_CODE_OAUTH_TOKEN
openssl rand -hex 32        # use output as TELEGRAM_WEBHOOK_SECRET
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
- Re-deploy after editing `server.mjs`: just run `./deploy.sh` again.
- Logs: `gcloud run services logs read telegram-expense-bot --region us-central1`.
