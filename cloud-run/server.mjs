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
// Shared secret for the /ingest endpoint (bank-SMS forwarding from iPhone Shortcuts).
// Sent by the phone in the X-Ingest-Secret header. Distinct from the Telegram secret.
const INGEST_SECRET = process.env.INGEST_SECRET;
// Currency your sheet is denominated in. Non-matching currencies are not
// auto-written; the bot asks you instead (no silent FX conversion).
const SHEET_CURRENCY = (process.env.SHEET_CURRENCY || "LKR").toUpperCase();
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

// The chat id of whoever last messaged the bot. SMS ingestion has no chat of
// its own, so confirmations/clarifications are sent here. Stored in Firestore
// so it survives restarts. Collection: bot_meta, doc "last_chat".
const lastChatDoc = () => db.collection("bot_meta").doc("last_chat");

async function rememberChat(chatId) {
  try {
    await lastChatDoc().set({ chatId: String(chatId), updatedAt: new Date().toISOString() });
  } catch (err) {
    console.error("firestore rememberChat failed:", err.message);
  }
}

async function getLastChat() {
  try {
    const snap = await lastChatDoc().get();
    if (snap.exists && snap.data().chatId) return snap.data().chatId;
  } catch (err) {
    console.error("firestore getLastChat failed:", err.message);
  }
  return ALLOWED_CHAT_IDS[0] || "";
}

// A "pending question" is stored when the bot asks the user to clarify an SMS it
// couldn't confidently classify. It is keyed by the Telegram message_id of the
// bot's question, so the user answers by QUOTE-REPLYING that question (Telegram
// puts the quoted message's id in reply_to_message.message_id). This links an
// answer to the exact SMS, supports multiple open questions, and means plain
// (non-quoted) messages are never mistaken for answers.
// Collection: pending_questions, doc id = question message id.
const pendingDoc = (msgId) => db.collection("pending_questions").doc(String(msgId));

async function setPending(msgId, sms) {
  await pendingDoc(msgId).set({ sms, createdAt: new Date().toISOString() });
}

async function getPending(msgId) {
  try {
    const snap = await pendingDoc(msgId).get();
    if (snap.exists) return snap.data();
  } catch (err) {
    console.error("firestore pending read failed:", err.message);
  }
  return null;
}

async function clearPending(msgId) {
  try {
    await pendingDoc(msgId).delete();
  } catch (err) {
    console.error("firestore pending delete failed:", err.message);
  }
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
    // amountCell lets callers write a formula (e.g. GOOGLEFINANCE FX conversion)
    // while tx.amount stays the raw number used for guards/confirmations.
    { range: `${SHEET_NAME}!${col.amount}${row}`, values: [[tx.amountCell ?? tx.amount]] },
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
function buildPrompt(message, today, smsContext) {
  const context = smsContext
    ? `\nThis is the user's clarification of a bank SMS the parser couldn't classify.
Original bank SMS: """${smsContext}"""
Combine the SMS (for amount/date/merchant) with the user's answer (for type/category/intent).\n`
    : "";
  return `You are a personal-finance parser. Convert the user's message into a single transaction.
${context}
User message: """${message}"""

Return ONLY a JSON object (no prose, no markdown fences) with this exact shape:
{
  "type": "expense" | "income",
  "date": "YYYY-MM-DD",
  "amount": number,
  "currency": string,
  "description": string,
  "category": string
}

Rules:
- Decide "type": income if the message describes money received (salary, paycheck, bonus, interest, refund, "got", "received"); otherwise expense.
- "date": if no date is mentioned, use today's date ${today}. Resolve relative dates ("yesterday", "last friday") against ${today}.
- "amount": a plain positive number, no currency symbol, no commas/thousands separators.
- "currency": ISO-ish code of the amount (e.g. "LKR", "USD"). Take it from the original bank SMS if provided, else infer; default "${SHEET_CURRENCY}" if none is stated.
- "description": a short human label for the transaction (the item/purpose), not the whole sentence.
- "category" for an expense MUST be exactly one of: ${CATEGORIES.join(", ")}.
- "category" for income MUST be exactly one of: ${INCOME_CATEGORIES.join(", ")}.
- Pick the closest category. If nothing fits, use "Other".
- If the message clearly contains no spendable/received amount, return {"type":"expense","date":"${today}","amount":0,"currency":"${SHEET_CURRENCY}","description":"","category":"Other"}.`;
}

// Invoke the Claude CLI with a prompt and return the parsed success envelope.
// Throws on CLI failure, non-JSON output, or an error envelope.
async function runClaude(prompt) {
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
  return envelope;
}

// Parse the JSON transaction from a Claude result. Claude sometimes wraps the
// object in a ```json … ``` markdown fence despite being told not to, so strip
// any fence (and stray prose) before parsing.
function parseJsonResult(result) {
  let s = String(result).trim();
  const fence = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(s);
  if (fence) s = fence[1].trim();
  // Fall back to the outermost {...} if there's leading/trailing prose.
  if (!s.startsWith("{")) {
    const brace = /\{[\s\S]*\}/.exec(s);
    if (brace) s = brace[0];
  }
  return JSON.parse(s);
}

async function parseMessage(message, smsContext) {
  const today = new Date().toISOString().slice(0, 10);
  const envelope = await runClaude(buildPrompt(message, today, smsContext));
  const tx = parseJsonResult(envelope.result);
  return {
    tx,
    meta: { model: MODEL, durationMs: envelope.duration_ms, costUsd: envelope.total_cost_usd },
  };
}

// ---------------------------------------------------------------------------
// Claude — parse a raw BANK SMS. These are terse, templated, and mixed: real
// spends/earnings, outward transfers with no merchant (real expense, but ask the
// owner what for), and true non-transactions (FD renewals, INWARD card-bill
// settlements, OTPs, balance alerts). Direction (money out vs in) is the key
// signal; anything ambiguous is flagged "unclear" for the owner to confirm.
// ---------------------------------------------------------------------------
function buildSmsPrompt(sms, today) {
  return `You classify a single bank SMS from a personal budget owner's phone.

Bank SMS: """${sms}"""

Return ONLY a JSON object (no prose, no markdown fences) with this exact shape:
{
  "type": "expense" | "income" | "ignore" | "unclear",
  "date": "YYYY-MM-DD",
  "amount": number,
  "currency": string,          // ISO-ish code as written in the SMS, e.g. "LKR", "USD"
  "description": string,       // merchant/payer/purpose, short
  "category": string,          // see allowed lists below; "" when type is ignore/unclear
  "confidence": "high" | "medium" | "low",
  "reason": string             // brief: why this type (esp. for ignore/unclear)
}

First decide DIRECTION: did money LEAVE the owner's account (debit / "Debited from
your A/c" / "Outward" / card "Auth Pmt") or ARRIVE (credit / "credited to" /
"Credited")? Direction is the strongest signal.

Definitions:
- "expense": money LEFT the owner's account as a real spend. This includes BOTH:
    * card/POS purchases at a merchant ("Auth Pmt at <MERCHANT>", "Debited <MERCHANT>")
      -> description = the merchant name; and
    * OUTWARD transfers you sent to someone (online transfer / "Outward CEFT" /
      SLIPS / "Debited from your A/c") -> this IS a real expense even though the
      SMS has no merchant. If you cannot tell what it was for or which category
      (which is normal for an outward transfer), use type "unclear" so the owner
      can say what it was — do NOT ignore it and do NOT guess a category.
- "income": money ARRIVED as real earnings/credits the owner keeps
  (salary, remittance received, FD interest paid, refunds).
- "ignore": a real bank event that is NOT a budget transaction. ONLY these:
    * Fixed-deposit renewals/rollovers ("FD ... renewed ... for N Month(s)").
    * INWARD credit-card bill settlement — money COMING IN that pays off the
      owner's own card ("PAYMENT RECEIVED", card "Credited ... for PAYMENT
      RECEIVED"). This is the owner paying their card, not a spend.
    * OTP messages, promotions, balance-only alerts, statement notices.
  Do NOT ignore an OUTWARD debit/transfer just because it says "CEFT" or "transfer"
  — money leaving the account is a real expense (see above).
  For ignores set amount to the number if present, category "", and explain in reason.
- "unclear": you cannot confidently decide type/category OR the message is
  ambiguous. Prefer "unclear" over guessing. An outward transfer with no clear
  payee/purpose is "unclear", not "ignore".

Rules:
- "date": parse the date in the SMS (formats like DD/MM/YYYY, DD-MMM, YYYY-MM-DD).
  If none, use today ${today}. Always output YYYY-MM-DD.
- "amount": plain positive number, no currency symbol, no thousands separators.
- "currency": exactly as written (e.g. LKR, USD). If none stated, "".
- Expense "category" MUST be one of: ${CATEGORIES.join(", ")}.
  Infer from the merchant (bakery/supermarket -> Food; fuel/petrol -> Transportation;
  university/school -> Personal or Other). If truly unsure which category, set
  type "unclear" rather than guessing a wrong category.
- Income "category" MUST be one of: ${INCOME_CATEGORIES.join(", ")}.
- "confidence": "high" only when type, amount, and category are all clear.`;
}

async function parseSms(sms) {
  const today = new Date().toISOString().slice(0, 10);
  const prompt = buildSmsPrompt(sms, today);
  const envelope = await runClaude(prompt);
  const tx = parseJsonResult(envelope.result);
  return {
    tx,
    meta: { model: MODEL, durationMs: envelope.duration_ms, costUsd: envelope.total_cost_usd },
  };
}

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------
// Send a Telegram message. Returns the sent message's numeric id (or null on
// failure) so callers can key follow-up state on it (e.g. quoted-reply Q&A).
async function sendTelegram(chatId, text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
  });
  if (!resp.ok) {
    console.error("telegram sendMessage failed:", resp.status, await resp.text());
    return null;
  }
  const body = await resp.json().catch(() => null);
  return body?.result?.message_id ?? null;
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

  // Remember this chat so SMS ingestion (which has no chat of its own) knows
  // where to send confirmations/clarifications.
  await rememberChat(chatId);

  const text = msg.text.trim();
  if (text === "/start" || text === "/help") {
    await sendTelegram(
      chatId,
      "Send me an expense or income in plain language, e.g.\n" +
        "`lunch 850 food`\n`got salary 250000`\n`yesterday fuel 16000`\n\n" +
        "I'll parse it and add it to your budget sheet.\n\n" +
        "Bank SMS forwarded from your phone is logged automatically. When I can't " +
        "tell what an SMS is, I'll ask — *quote-reply my question* with the details " +
        "(or `ignore`) and I'll log it. A normal message is always a new entry.\n\n" +
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

  // A message is treated as the answer to a clarification ONLY if it QUOTE-REPLIES
  // the bot's question. We look the question up by the quoted message's id. A
  // plain (non-quoted) message is always a fresh entry — a stale pending question
  // can never hijack it.
  const repliedId = msg.reply_to_message?.message_id;
  const pending = repliedId ? await getPending(repliedId) : null;
  const smsContext = pending ? pending.sms : undefined;

  // Quote-reply "ignore"/"skip"/"no" dismisses that clarification without logging.
  if (pending && /^(ignore|skip|no)$/i.test(text)) {
    await clearPending(repliedId);
    await sendTelegram(chatId, "👍 Skipped that one.");
    return;
  }

  try {
    const { tx, meta } = await parseMessage(text, smsContext);

    if (!tx.amount || tx.amount <= 0) {
      await sendTelegram(chatId, "I couldn't find an amount in that message. Try e.g. `lunch 850 food`.");
      return;
    }

    await writeAndNotify(chatId, tx, meta);
    if (pending) await clearPending(repliedId);
  } catch (err) {
    console.error("handleUpdate failed:", err);
    await sendTelegram(chatId, `⚠️ Failed to log that: ${err.message}`);
  }
}

// If a transaction is in a currency other than the sheet's, write the amount as
// a live GOOGLEFINANCE conversion formula (amountCell) and note the original
// amount + currency in the description. tx.amount stays the raw foreign number
// for the confirmation text. Idempotent and applied to every write path.
function applyCurrencyConversion(tx) {
  if (tx.amountCell) return; // already converted
  const cur = (tx.currency || "").toUpperCase();
  if (!cur || cur === SHEET_CURRENCY || !tx.amount || tx.amount <= 0) return;
  tx.amountCell = `=${tx.amount}*GOOGLEFINANCE("CURRENCY:${cur}${SHEET_CURRENCY}")`;
  tx.description = `${tx.description} (${cur} ${tx.amount})`;
}

// Append a parsed transaction to the active sheet and send a Telegram confirmation.
async function writeAndNotify(chatId, tx, meta) {
  applyCurrencyConversion(tx);
  const spreadsheetId = await getTargetId(chatId);
  const { block, row } = await appendTransaction(spreadsheetId, tx);
  const icon = block === "income" ? "💰" : "🧾";
  // For a converted amount, show the live formula so it's clear it's not a flat number.
  const amountLine = tx.amountCell ? `${tx.amount} → \`${tx.amountCell}\`` : `${tx.amount}`;
  await sendTelegram(
    chatId,
    `${icon} *${block === "income" ? "Income" : "Expense"} added* (row ${row})\n` +
      `• Date: ${tx.date}\n• Amount: ${amountLine}\n• Desc: ${tx.description}\n• Category: ${tx.category}`,
  );
  console.log("logged tx:", { tx, block, row, meta });
}

// Handle a raw bank SMS forwarded from the phone. Classifies it, then either
// writes it, silently-with-note skips it, or asks the user to clarify.
async function ingestSms(sms) {
  const chatId = await getLastChat();
  if (!chatId) {
    console.error("no chat known yet; message the bot once so it can reply. dropping SMS");
    return;
  }

  let tx, meta;
  try {
    ({ tx, meta } = await parseSms(sms));
  } catch (err) {
    console.error("parseSms failed:", err);
    // Send first, then store the pending keyed by this question's message id so
    // the user can quote-reply it.
    const qId = await sendTelegram(
      chatId,
      `⚠️ Couldn't parse a bank SMS:\n\`${sms}\`\n\n` +
        "*Quote-reply this message* with the details (e.g. `expense 5493 groceries food`), or `ignore` to skip.",
    );
    if (qId) await setPending(qId, sms);
    return;
  }
  console.log("sms parsed:", { tx, meta });

  const ask = async (headline) => {
    const qId = await sendTelegram(
      chatId,
      `${headline}\n\`${sms}\`\n\n` +
        `I read: type=${tx.type}, amount=${tx.amount || "?"} ${tx.currency || ""}, ` +
        `desc="${tx.description || "?"}", category="${tx.category || "?"}"\n` +
        `_${tx.reason || ""}_\n\n` +
        "*Quote-reply this message* with the correct details (e.g. `expense 5493 groceries food`), or `ignore` to skip.",
    );
    if (qId) await setPending(qId, sms);
  };

  // Non-transaction bank events: skip writing, send a short note (visibility).
  if (tx.type === "ignore") {
    await sendTelegram(chatId, `⏭️ Skipped (${tx.reason || "not a transaction"}):\n\`${sms}\``);
    return;
  }

  // Anything Claude wasn't sure about → ask.
  if (tx.type === "unclear" || tx.confidence === "low" || !tx.amount || tx.amount <= 0) {
    await ask("❓ Not sure how to classify this SMS:");
    return;
  }

  // Confident expense/income → write it (currency conversion happens in
  // writeAndNotify, so it applies to clarification replies too).
  try {
    await writeAndNotify(chatId, tx, meta);
  } catch (err) {
    console.error("ingestSms write failed:", err);
    await sendTelegram(chatId, `⚠️ Parsed but couldn't write it: ${err.message}\n\`${sms}\``);
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    return send(res, 200, { ok: true });
  }

  // --- Telegram webhook -----------------------------------------------------
  if (req.method === "POST" && req.url === "/telegram") {
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
    return send(res, 200, { ok: true });
  }

  // --- Bank-SMS ingestion (from iPhone Shortcuts) ---------------------------
  if (req.method === "POST" && req.url === "/ingest") {
    if (!INGEST_SECRET || req.headers["x-ingest-secret"] !== INGEST_SECRET) {
      return send(res, 401, { error: "bad ingest secret" });
    }

    let body;
    try {
      body = JSON.parse((await readBody(req)).toString("utf-8"));
    } catch {
      return send(res, 400, { error: "invalid json" });
    }
    const sms = typeof body.text === "string" ? body.text.trim() : "";
    if (!sms) return send(res, 400, { error: "missing text" });

    // Same await-then-ack reasoning as the Telegram path.
    try {
      await ingestSms(sms);
    } catch (err) {
      console.error("ingest handler error:", err);
    }
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { error: "not found" });
});

server.listen(PORT, () => {
  console.log(`telegram-expense-bot listening on :${PORT} (model=${MODEL}, sheet=${SHEET_NAME})`);
});
