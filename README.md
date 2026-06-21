# telegram-claude-bot

A Telegram bot that turns plain-language messages into rows in your Google
budget sheet. Text it something like `lunch 850 food`, `got salary 250000`, or
`yesterday fuel 16000`; a Cloud Run backend parses it with Claude, classifies it
as expense or income, and appends a row to the **Transactions** tab of your
spreadsheet.

```
You ──Telegram──▶ Bot webhook ──▶ Cloud Run (server.mjs)
                                     ├─ claude -p --model sonnet  (parse → JSON)
                                     └─ Google Sheets API (append row)
```

## How it works

1. You send a free-text message to your Telegram bot.
2. Cloud Run (`cloud-run/server.mjs`) receives it via webhook.
3. Claude (`claude -p --model sonnet`) parses the text into structured data —
   `{ type, date, amount, description, category }` — choosing a category that
   matches the budget workbook.
4. The Google Sheets API appends the row to the `Transactions` tab:
   - Expenses → columns `B:E` (Date / Amount / Description / Category)
   - Income → columns `G:J`
   - Data starts at row 4; new rows go after the last filled entry in the block.

## Features

- **`/sheet <link or id>`** — repoint the bot to a new spreadsheet without
  redeploying. It validates that it can open the sheet and that the
  `Transactions` tab exists before saving. The active target is stored per chat
  in Firestore, so it survives restarts.
- **`/sheet`** — show which sheet is currently being written to.
- **`ALLOWED_CHAT_IDS`** — allowlist of Telegram chat IDs permitted to write.

## Setup & deployment

Full step-by-step instructions (creating the bot, Google Sheets setup, deploying
to Cloud Run, registering the webhook, and switching sheets monthly) are in
**[`cloud-run/README.md`](cloud-run/README.md)**.

## Stack

- **Runtime:** Node.js on Google Cloud Run
- **Parsing:** Claude Code CLI (`claude -p`)
- **Storage:** Google Sheets (data) + Firestore (per-chat active sheet target)

## Notes

- The webhook finishes the Claude parse and sheet write **before** acking
  Telegram — Cloud Run throttles CPU after the response is sent, so backgrounding
  the work would silently kill it.
- Secrets live only in `cloud-run/.env` (git-ignored). Copy
  `cloud-run/.env.example` and fill it in.
