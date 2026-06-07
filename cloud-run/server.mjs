import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir } from "node:fs/promises";
import { google } from "googleapis";
import { Firestore } from "@google-cloud/firestore";

const WORK_DIR = process.env.WORK_DIR || "/app/tmp";
await mkdir(WORK_DIR, { recursive: true });

const run = promisify(execFile);

const PORT = process.env.PORT || 8080;
const MODEL = process.env.MODEL || "sonnet";
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET; // validates X-Telegram-Bot-Api-Secret-Token
// SPREADSHEET_ID is the *default* target, used until a /sheet command overrides it.
// The active target is stored per-chat in Firestore so it survives restarts and you
// can switch to each month's new sheet from Telegram without redeploying.
const DEFAULT_SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || "Transactions";
// Only messages from these Telegram numeric chat IDs are accepted (comma-separated).
const ALLOWED_CHAT_IDS = (process.env.ALLOWED_CHAT_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (!TELEGRAM_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN env var is required");
if (!process.env.CLAUDE_CODE_OAUTH_TOKEN)
  throw new Error("CLAUDE_CODE_OAUTH_TOKEN env var is required");
if (!DEFAULT_SPREADSHEET_ID) throw new Error("SPREADSHEET_ID env var is required");

// Categories from the budget sheet — keeps Claude's output aligned with the workbook.
const CATEGORIES = [
  "Food",
  "Savings",
  "Gifts",
  "Health/medical",
  "Home",
  "Transportation",
  "Personal",
  "Utilities",
  "Investments",
  "Travel",
  "Loan",
  "Charity",
  "Vehicle",
  "Business",
  "House Hold",
  "Other",
];
const INCOME_CATEGORIES = ["Paycheck", "Bonus", "Interest", "Other"];

// ---------------------------------------------------------------------------
// Google Sheets — service account via Application Default Credentials.
// On Cloud Run, attach the service account; locally set GOOGLE_APPLICATION_CREDENTIALS.
// ---------------------------------------------------------------------------
const sheetsAuth = new google.auth.GoogleAuth({
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
let sheetsClient;
async function getSheets() {
  if (!sheetsClient) {
    const auth = await sheetsAuth.getClient();
    sheetsClient = google.sheets({ version: "v4", auth });
  }
  return sheetsClient;
}

// ---------------------------------------------------------------------------
// Firestore — remembers the active target spreadsheet per Telegram chat, so a
// /sheet command sticks across container restarts. Collection: bot_targets,
// doc id = chat id, field: spreadsheetId.
// ---------------------------------------------------------------------------
const db = new Firestore();
const targetDoc = (chatId) => db.collection("bot_targets").doc(String(chatId));

async function getTargetId(chatId) {
  try {
    const snap = await targetDoc(chatId).get();
    if (snap.exists && snap.data().spreadsheetId) return snap.data().spreadsheetId;
  } catch (err) {
    console.error("firestore read failed, falling back to default:", err.message);
  }
  return DEFAULT_SPREADSHEET_ID;
}

async function setTargetId(chatId, spreadsheetId) {
  await targetDoc(chatId).set(
    { spreadsheetId, updatedAt: new Date().toISOString() },
    { merge: true },
  );
}

// Accept either a full Sheets URL or a bare spreadsheet ID.
function parseSpreadsheetId(input) {
  const s = input.trim();
  const m = /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/.exec(s);
  if (m) return m[1];
  // Bare ID: Google sheet IDs are long alphanumeric/-/_ strings.
  if (/^[a-zA-Z0-9-_]{20,}$/.test(s)) return s;
  return null;
}

// Expenses live in B:E, Income in G:J. Header row is row 3; data starts at row 4.
const BLOCKS = {
  expense: { date: "B", amount: "C", description: "D", category: "E" },
  income: { date: "G", amount: "H", description: "I", category: "J" },
};

// Find the row to write into: the row after the LAST filled amount cell in the
// block. Appending after the last entry (rather than filling the first interior
// gap) keeps transactions in chronological order and tolerates blank spacer rows
// that already exist in the sheet.
async function nextEmptyRow(sheets, spreadsheetId, block) {
  const col = BLOCKS[block];
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${SHEET_NAME}!${col.amount}4:${col.amount}10000`,
  });
  const rows = resp.data.values || [];
  // values.get drops trailing empties, so scan for the last non-empty cell.
  let last = -1;
  for (let i = 0; i < rows.length; i++) {
    const v = rows[i] && rows[i][0];
    if (v !== "" && v != null) last = i;
  }
  return 4 + last + 1; // empty block -> 4; last filled at index n -> 4+n+1
}

// Confirm the bot can actually open the sheet and that the target tab exists.
// Returns the spreadsheet title on success; throws a friendly error otherwise.
async function validateSheet(spreadsheetId) {
  const sheets = await getSheets();
  let meta;
  try {
    meta = await sheets.spreadsheets.get({
      spreadsheetId,
      fields: "properties.title,sheets.properties.title",
    });
  } catch (err) {
    const status = err.code || err.response?.status;
    if (status === 403)
      throw new Error("I can't access that sheet. Share it with the bot's service account as Editor.");
    if (status === 404) throw new Error("No sheet found for that link/ID.");
    throw new Error(err.message);
  }
  const tabs = (meta.data.sheets || []).map((s) => s.properties.title);
  if (!tabs.includes(SHEET_NAME)) {
    throw new Error(`That sheet has no "${SHEET_NAME}" tab. Tabs found: ${tabs.join(", ")}`);
  }
  return meta.data.properties.title;
}

async function appendTransaction(spreadsheetId, tx) {
  const sheets = await getSheets();
  const block = tx.type === "income" ? "income" : "expense";
  const col = BLOCKS[block];
  const row = await nextEmptyRow(sheets, spreadsheetId, block);

  const data = [
    { range: `${SHEET_NAME}!${col.date}${row}`, values: [[tx.date]] },
    { range: `${SHEET_NAME}!${col.amount}${row}`, values: [[tx.amount]] },
    { range: `${SHEET_NAME}!${col.description}${row}`, values: [[tx.description]] },
    { range: `${SHEET_NAME}!${col.category}${row}`, values: [[tx.category]] },
  ];

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: { valueInputOption: "USER_ENTERED", data },
  });
  return { block, row };
}

// ---------------------------------------------------------------------------
// Claude — parse a free-text message into a structured transaction.
// ---------------------------------------------------------------------------
function buildPrompt(message, today) {
  return `You are a personal-finance parser. Convert the user's message into a single transaction.

User message: """${message}"""

Return ONLY a JSON object (no prose, no markdown fences) with this exact shape:
{
  "type": "expense" | "income",
  "date": "YYYY-MM-DD",
  "amount": number,
  "description": string,
  "category": string
}

Rules:
- Decide "type": income if the message describes money received (salary, paycheck, bonus, interest, refund, "got", "received"); otherwise expense.
- "date": if no date is mentioned, use today's date ${today}. Resolve relative dates ("yesterday", "last friday") against ${today}.
- "amount": a plain positive number, no currency symbol, no commas/thousands separators.
- "description": a short human label for the transaction (the item/purpose), not the whole sentence.
- "category" for an expense MUST be exactly one of: ${CATEGORIES.join(", ")}.
- "category" for income MUST be exactly one of: ${INCOME_CATEGORIES.join(", ")}.
- Pick the closest category. If nothing fits, use "Other".
- If the message clearly contains no spendable/received amount, return {"type":"expense","date":"${today}","amount":0,"description":"","category":"Other"}.`;
}

async function parseMessage(message) {
  const today = new Date().toISOString().slice(0, 10);
  const prompt = buildPrompt(message, today);

  let stdout, stderr;
  try {
    const result = await run(
      CLAUDE_BIN,
      ["-p", "--model", MODEL, "--output-format", "json", prompt],
      { maxBuffer: 20_000_000, env: { ...process.env, HOME: "/tmp" } },
    );
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (err) {
    console.error("claude CLI failed:", { code: err.code, stderr: err.stderr, stdout: err.stdout });
    throw new Error(`claude CLI failed (exit ${err.code}): ${err.stderr || err.stdout || err.message}`);
  }

  let envelope;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    console.error("non-JSON stdout from claude:", { stdout, stderr });
    throw new Error(`claude returned non-JSON: ${stdout.slice(0, 500)}`);
  }
  if (envelope.is_error || envelope.subtype !== "success") {
    console.error("claude returned error envelope:", envelope);
    throw new Error(`claude error: ${envelope.subtype}`);
  }

  const tx = JSON.parse(envelope.result);
  return {
    tx,
    meta: { model: MODEL, durationMs: envelope.duration_ms, costUsd: envelope.total_cost_usd },
  };
}

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------
async function sendTelegram(chatId, text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
  });
  if (!resp.ok) {
    console.error("telegram sendMessage failed:", resp.status, await resp.text());
  }
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------
async function readBody(req, limit = 2 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) throw new Error("payload too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(json),
  });
  res.end(json);
}

async function handleUpdate(update) {
  const msg = update.message || update.edited_message;
  if (!msg || !msg.text) return; // ignore non-text updates
  const chatId = String(msg.chat.id);

  if (ALLOWED_CHAT_IDS.length && !ALLOWED_CHAT_IDS.includes(chatId)) {
    console.warn("rejected chat id:", chatId);
    await sendTelegram(chatId, "Not authorized.");
    return;
  }

  const text = msg.text.trim();
  if (text === "/start" || text === "/help") {
    await sendTelegram(
      chatId,
      "Send me an expense or income in plain language, e.g.\n" +
        "`lunch 850 food`\n`got salary 250000`\n`yesterday fuel 16000`\n\n" +
        "I'll parse it and add it to your budget sheet.\n\n" +
        "*Switch sheets each month:*\n" +
        "`/sheet <link or id>` — point me at a new sheet\n" +
        "`/sheet` — show the current sheet",
    );
    return;
  }

  // /sheet — show or change the active target spreadsheet for this chat.
  if (text === "/sheet" || text.startsWith("/sheet ") || text.startsWith("/sheet@")) {
    const arg = text.replace(/^\/sheet(@\S+)?\s*/, "");
    if (!arg) {
      const current = await getTargetId(chatId);
      await sendTelegram(
        chatId,
        `Current sheet:\n\`${current}\`\nhttps://docs.google.com/spreadsheets/d/${current}/edit\n\n` +
          "To switch: `/sheet <link or id>`",
      );
      return;
    }
    const id = parseSpreadsheetId(arg);
    if (!id) {
      await sendTelegram(chatId, "That doesn't look like a Sheets link or ID. Paste the full URL or the ID.");
      return;
    }
    try {
      const title = await validateSheet(id); // throws if inaccessible or missing tab
      await setTargetId(chatId, id);
      await sendTelegram(chatId, `✅ Now logging to *${title}*\n\`${id}\``);
    } catch (err) {
      await sendTelegram(chatId, `⚠️ ${err.message}`);
    }
    return;
  }

  try {
    const { tx, meta } = await parseMessage(text);

    if (!tx.amount || tx.amount <= 0) {
      await sendTelegram(chatId, "I couldn't find an amount in that message. Try e.g. `lunch 850 food`.");
      return;
    }

    const spreadsheetId = await getTargetId(chatId);
    const { block, row } = await appendTransaction(spreadsheetId, tx);
    const icon = block === "income" ? "💰" : "🧾";
    await sendTelegram(
      chatId,
      `${icon} *${block === "income" ? "Income" : "Expense"} added* (row ${row})\n` +
        `• Date: ${tx.date}\n• Amount: ${tx.amount}\n• Desc: ${tx.description}\n• Category: ${tx.category}`,
    );
    console.log("logged tx:", { tx, block, row, meta });
  } catch (err) {
    console.error("handleUpdate failed:", err);
    await sendTelegram(chatId, `⚠️ Failed to log that: ${err.message}`);
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    return send(res, 200, { ok: true });
  }

  if (req.method !== "POST" || req.url !== "/telegram") {
    return send(res, 404, { error: "not found" });
  }

  // Telegram sends our configured secret in this header on every webhook call.
  if (WEBHOOK_SECRET) {
    const got = req.headers["x-telegram-bot-api-secret-token"];
    if (got !== WEBHOOK_SECRET) {
      return send(res, 401, { error: "bad webhook secret" });
    }
  }

  let update;
  try {
    update = JSON.parse((await readBody(req)).toString("utf-8"));
  } catch {
    return send(res, 400, { error: "invalid json" });
  }

  // Process fully, THEN ack. Cloud Run throttles CPU once the response is sent,
  // so work backgrounded after send() never finishes. A Sonnet parse takes a few
  // seconds — well within Telegram's ~60s webhook timeout — so awaiting is safe.
  try {
    await handleUpdate(update);
  } catch (err) {
    console.error("handler error:", err);
  }
  send(res, 200, { ok: true });
});

server.listen(PORT, () => {
  console.log(`telegram-expense-bot listening on :${PORT} (model=${MODEL}, sheet=${SHEET_NAME})`);
});
