import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Firestore, FieldValue } from "@google-cloud/firestore";
import { google } from "googleapis";

const run = promisify(execFile);

const PORT = process.env.PORT || 8080;
const MODEL = process.env.MODEL || "sonnet";
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET; // validates X-Telegram-Bot-Api-Secret-Token
// Days roll over at local midnight in this zone.
const TZ = process.env.TZ_NAME || "Asia/Colombo";
// Nightly sheet sync: Cloud Scheduler POSTs /sync with X-Sync-Secret.
const SYNC_SECRET = process.env.SYNC_SECRET; // empty = /sync endpoint disabled
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || "daily-calories-protein-data";
// Only messages from these Telegram numeric chat IDs are accepted (comma-separated).
const ALLOWED_CHAT_IDS = (process.env.ALLOWED_CHAT_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (!WEBHOOK_SECRET) throw new Error("TELEGRAM_WEBHOOK_SECRET env var is required");
if (!process.env.CLAUDE_CODE_OAUTH_TOKEN)
  throw new Error("CLAUDE_CODE_OAUTH_TOKEN env var is required");

// ---------------------------------------------------------------------------
// Firestore collections:
//   calorie_days/<chatId>_<YYYY-MM-DD>  {chatId, date, calories, protein, meals}
//   calorie_meta/<chatId>               {last: {date, calories, protein}} for /undo
//   foods/<name>                        {kcal, protein (per 100 g), unit, perPiece, source}
//     source: "seed" (seed-foods.mjs), "claude" (learned estimate), "user" (/add).
//     /add overwrites anything; seed and Claude only create names that don't exist,
//     so they never clobber a user entry.
// ---------------------------------------------------------------------------
const db = new Firestore({ ignoreUndefinedProperties: true });
const dayRef = (chatId, date) => db.collection("calorie_days").doc(`${chatId}_${date}`);
const metaRef = (chatId) => db.collection("calorie_meta").doc(String(chatId));
const docId = (name) => name.replace(/\//g, "_");
const foodRef = (name) => db.collection("foods").doc(docId(name));

function localDate(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d); // YYYY-MM-DD
}

const round1 = (n) => Math.round(n * 10) / 10;

// ---------------------------------------------------------------------------
// Local parsing: "rice 100g, chicken 150g, 2 eggs" -> items with grams.
// ---------------------------------------------------------------------------
const UNIT = "kg|g|gm|gms|grams?|ml|l|ltr|litres?|liters?|pcs?|pieces?|x|slices?|scoops?|cups?|tbsp|tsp";
const QTY_FIRST = new RegExp(`^(\\d+(?:\\.\\d+)?)\\s*(${UNIT})?\\b\\s*(?:of\\s+)?(.+)$`);
const QTY_LAST = new RegExp(`^(.+?)\\s*(?:-|:)?\\s*(\\d+(?:\\.\\d+)?)\\s*(${UNIT})?$`);

function splitItems(text) {
  return text
    .toLowerCase()
    .split(/,|;|\n|\+|\band\b|&/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseItem(raw) {
  let m = QTY_FIRST.exec(raw);
  if (m) return { raw, qty: Number(m[1]), unit: m[2] || "", name: m[3].trim() };
  m = QTY_LAST.exec(raw);
  if (m) return { raw, qty: Number(m[2]), unit: m[3] || "", name: m[1].trim() };
  return { raw, qty: 1, unit: "", name: raw };
}

// Grams for a parsed item given its per-piece weight, or null if we can't tell
// locally (cups/spoons, or a count for a food with no known piece weight).
function toGrams({ qty, unit }, pieceGrams) {
  if (/^(g|gm|gms|grams?|ml)$/.test(unit)) return qty;
  if (/^(kg|l|ltr|litres?|liters?)$/.test(unit)) return qty * 1000;
  if (/^(|pcs?|pieces?|x|slices?|scoops?)$/.test(unit)) return pieceGrams ? qty * pieceGrams : null;
  return null;
}

const singular = (name) => name.replace(/e?s$/, "");
const validName = (name) => name && name.length <= 60;

// Look up every item of a meal in one Firestore round trip (exact name, then
// singular form). Returns Map name -> food entry.
async function lookupFoods(names) {
  const keys = [...new Set(names.flatMap((n) => [n, singular(n)]).filter(validName))];
  const found = new Map();
  if (!keys.length) return found;
  const snaps = await db.getAll(...keys.map(foodRef));
  snaps.forEach((snap, i) => snap.exists && found.set(keys[i], snap.data()));
  return new Map(names.map((n) => [n, found.get(n) || found.get(singular(n))]).filter(([, f]) => f));
}

// "/add chicken legs 100g 120cal 20g"   -> per 100 g
// "/add protein bar 1pc 200cal 20g"     -> per piece ("2 protein bar" works)
// "/add protein bar 200kcal 20g protein"-> per piece (no serving = one piece)
const ADD_RE =
  /^(.+?)\s+(?:(\d+(?:\.\d+)?)\s*(g|gm|gms|grams?|ml|pcs?|pieces?|x)?\s+)?(\d+(?:\.\d+)?)\s*(?:k?cals?|calories)\s+(\d+(?:\.\d+)?)\s*g?(?:\s*protein)?$/i;

function parseAddCommand(args) {
  const m = ADD_RE.exec(args.trim().toLowerCase());
  if (!m) return null;
  const [, name, qtyStr, unit = "", calStr, protStr] = m;
  const cal = Number(calStr);
  const prot = Number(protStr);
  if (qtyStr && /^(g|gm|gms|grams?|ml)$/.test(unit)) {
    const qty = Number(qtyStr);
    if (!(qty > 0)) return null;
    return { name: name.trim(), entry: { kcal: (cal * 100) / qty, protein: (prot * 100) / qty, unit: null } };
  }
  // Per piece: model it as a 100 g "piece" so counts multiply correctly.
  const pieces = qtyStr ? Number(qtyStr) : 1;
  if (!(pieces > 0)) return null;
  return { name: name.trim(), entry: { kcal: cal / pieces, protein: prot / pieces, unit: 100, perPiece: true } };
}

// ---------------------------------------------------------------------------
// Claude fallback for anything the table/cache can't resolve.
// ---------------------------------------------------------------------------
function buildPrompt(items) {
  return `You are a nutrition calculator. For each food item below, estimate the weight eaten and its nutrition.

Items (one per line, as the user typed them):
${items.map((s) => `- ${s}`).join("\n")}

Return ONLY a JSON object, no prose, no markdown fences:
{"items":[{"input":"<item as given>","food":"<short generic food name, lowercase, no quantity>","grams":<total grams eaten>,"kcal_per_100g":<number>,"protein_per_100g":<number>,"piece_grams":<grams of one typical piece/serving, or null>}]}

Rules:
- Assume cooked/as-eaten values unless the item says raw/dry. Sri Lankan foods are common (rice & curry, kottu, hoppers, etc.).
- If no quantity is given, assume one typical serving.
- Convert cups/spoons/pieces to grams using typical weights.
- Skip anything that is not food or drink (return it out of the list). If nothing is food, return {"items":[]}.`;
}

async function runClaude(prompt) {
  let stdout;
  try {
    ({ stdout } = await run(
      CLAUDE_BIN,
      ["-p", "--model", MODEL, "--output-format", "json", prompt],
      { maxBuffer: 20_000_000, env: { ...process.env, HOME: "/tmp" } },
    ));
  } catch (err) {
    console.error("claude CLI failed:", { code: err.code, stderr: err.stderr, stdout: err.stdout });
    throw new Error(`claude CLI failed (exit ${err.code})`);
  }
  const envelope = JSON.parse(stdout);
  if (envelope.is_error || envelope.subtype !== "success") {
    console.error("claude returned error envelope:", envelope);
    throw new Error(`claude error: ${envelope.subtype}`);
  }
  return envelope;
}

// Claude sometimes wraps JSON in a ```json fence or adds prose; strip both.
function parseJsonResult(result) {
  let s = String(result).trim();
  const fence = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(s);
  if (fence) s = fence[1].trim();
  if (!s.startsWith("{")) {
    const brace = /\{[\s\S]*\}/.exec(s);
    if (brace) s = brace[0];
  }
  return JSON.parse(s);
}

async function estimateWithClaude(parsedItems) {
  const envelope = await runClaude(buildPrompt(parsedItems.map((p) => p.raw)));
  const out = parseJsonResult(envelope.result).items || [];
  const results = [];
  for (const it of out) {
    const grams = Number(it.grams);
    const kcal100 = Number(it.kcal_per_100g);
    const prot100 = Number(it.protein_per_100g);
    if (!(grams > 0) || !Number.isFinite(kcal100) || !Number.isFinite(prot100)) continue;
    results.push({
      label: it.input || it.food,
      kcal: (grams * kcal100) / 100,
      protein: (grams * prot100) / 100,
      estimated: true,
    });
    // Learn the per-100g values under both the user's wording and Claude's
    // generic name, so the next mention skips Claude.
    const src = parsedItems.find((p) => p.raw === String(it.input || "").toLowerCase());
    const entry = { kcal: kcal100, protein: prot100, unit: Number(it.piece_grams) || null, source: "claude" };
    for (const key of new Set([src?.name, String(it.food || "").toLowerCase()])) {
      if (!validName(key)) continue;
      // create() fails if the name exists, so seed/user entries are never overwritten.
      foodRef(key)
        .create(entry)
        .catch((e) => e.code !== 6 && console.error("food write failed:", key, e.message)); // 6 = ALREADY_EXISTS
    }
  }
  return results;
}

// Resolve every item in a meal to {label, kcal, protein}. Firestore first;
// one Claude call for whatever is left.
async function analyzeMeal(text) {
  const parsed = splitItems(text).map(parseItem);
  const foods = await lookupFoods(parsed.map((p) => p.name));
  const resolved = [];
  const unresolved = [];
  for (const p of parsed) {
    const food = foods.get(p.name);
    const grams = food ? toGrams(p, food.unit) : null;
    if (food && grams) {
      resolved.push({
        label: food.perPiece ? `${p.name} ×${round1(grams / 100)}` : `${p.name} ${round1(grams)}g`,
        kcal: (grams * food.kcal) / 100,
        protein: (grams * food.protein) / 100,
        estimated: false,
      });
    } else {
      unresolved.push(p);
    }
  }
  if (unresolved.length) resolved.push(...(await estimateWithClaude(unresolved)));
  return resolved;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------
async function addToDay(chatId, date, kcal, protein) {
  await dayRef(chatId, date).set(
    {
      chatId: String(chatId),
      date,
      calories: FieldValue.increment(kcal),
      protein: FieldValue.increment(protein),
      meals: FieldValue.increment(kcal >= 0 ? 1 : -1),
    },
    { merge: true },
  );
  const snap = await dayRef(chatId, date).get();
  return snap.data();
}

async function getDay(chatId, date) {
  const snap = await dayRef(chatId, date).get();
  return snap.exists ? snap.data() : { date, calories: 0, protein: 0, meals: 0 };
}

// ---------------------------------------------------------------------------
// Google Sheet sync: one row per date (A Date, B Calories, C Protein) on
// SHEET_NAME. Existing rows for a date are updated in place, so re-runs are safe.
// ---------------------------------------------------------------------------
const sheetsAuth = new google.auth.GoogleAuth({
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
let sheetsClient;
async function getSheets() {
  if (!sheetsClient) sheetsClient = google.sheets({ version: "v4", auth: await sheetsAuth.getClient() });
  return sheetsClient;
}

// Sheets stores dates as days since 1899-12-30.
const toSerial = (date) => (Date.parse(`${date}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86_400_000;

// Totals across all allowed chats for a date (it's a personal sheet).
async function totalsForDate(date) {
  const snap = await db.collection("calorie_days").where("date", "==", date).get();
  const docs = snap.docs
    .map((d) => d.data())
    .filter((d) => !ALLOWED_CHAT_IDS.length || ALLOWED_CHAT_IDS.includes(d.chatId));
  if (!docs.length) return null;
  return {
    date,
    calories: docs.reduce((s, d) => s + d.calories, 0),
    protein: docs.reduce((s, d) => s + d.protein, 0),
  };
}

async function syncSheet(dates) {
  if (!SPREADSHEET_ID) throw new Error("SPREADSHEET_ID is not set");
  const sheets = await getSheets();
  const col = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${SHEET_NAME}'!A:A`,
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  const colA = col.data.values || [];
  let nextRow = colA.length + 1;
  const written = [];
  for (const date of dates) {
    const totals = await totalsForDate(date);
    if (!totals) continue;
    const serial = toSerial(date);
    const idx = colA.findIndex((r) => r[0] === serial || r[0] === date);
    const row = idx >= 0 ? idx + 1 : nextRow++;
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${SHEET_NAME}'!A${row}:C${row}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[date, Math.round(totals.calories), round1(totals.protein)]] },
    });
    written.push(totals);
  }
  console.log("sheet sync", { dates, written: written.length });
  return written;
}

const fmtDay = (d) => `${Math.round(d.calories)} kcal · ${round1(d.protein)} g protein`;

// ---------------------------------------------------------------------------
// Telegram handling. Replies are returned in the webhook response body
// ({method:"sendMessage", ...}), so the server never calls the Bot API itself.
// ---------------------------------------------------------------------------
const HELP = `Send what you ate, e.g.
rice 200g, chicken 150g, soya 50g
2 eggs, 1 banana, milk 250ml

Prefix with "yesterday" to log to yesterday.
/today — today's totals
/week — last 7 days
/undo — remove the last entry

/add <food> <serving> <cal> <protein> — save a food, e.g.
  /add chicken legs 100g 120cal 20g
  /add protein bar 1pc 200cal 20g
/foods — list foods you added
/delete <food> — remove a food from the database
/sync — push yesterday + today to the sheet now`;

async function handleCommand(chatId, cmd, args) {
  if (cmd === "/start" || cmd === "/help") return HELP;
  if (cmd === "/add") {
    const parsed = parseAddCommand(args);
    if (!parsed) return "Format: /add chicken legs 100g 120cal 20g\n(or per piece: /add protein bar 1pc 200cal 20g)";
    const { name, entry } = parsed;
    await foodRef(name).set({ ...entry, source: "user" });
    const per = entry.perPiece ? "per piece" : "per 100 g";
    return `✅ Saved "${name}": ${round1(entry.kcal)} kcal · ${round1(entry.protein)} g protein ${per}`;
  }
  if (cmd === "/foods") {
    const snap = await db.collection("foods").where("source", "==", "user").get();
    if (snap.empty) return "No foods added yet. Use /add.";
    return snap.docs
      .map((d) => {
        const f = d.data();
        return `• ${d.id}: ${round1(f.kcal)} kcal · ${round1(f.protein)} g ${f.perPiece ? "per piece" : "per 100 g"}`;
      })
      .join("\n");
  }
  if (cmd === "/delete") {
    const name = args.trim().toLowerCase();
    if (!name) return "Usage: /delete <food>";
    const ref = foodRef(name);
    if (!(await ref.get()).exists) return `No food "${name}" in the database.`;
    await ref.delete();
    return `🗑 Deleted "${name}"`;
  }
  if (cmd === "/sync") {
    const rows = await syncSheet([localDate(-1), localDate()]);
    return `📊 Sheet updated:\n${rows.map((r) => `${r.date}: ${fmtDay(r)}`).join("\n")}`;
  }
  if (cmd === "/today") {
    const today = localDate();
    return `📅 ${today}: ${fmtDay(await getDay(chatId, today))}`;
  }
  if (cmd === "/week") {
    const lines = [];
    for (let i = 6; i >= 0; i--) {
      const date = localDate(-i);
      lines.push(`${date}: ${fmtDay(await getDay(chatId, date))}`);
    }
    return lines.join("\n");
  }
  if (cmd === "/undo") {
    const meta = (await metaRef(chatId).get()).data();
    if (!meta?.last) return "Nothing to undo.";
    const { date, calories, protein } = meta.last;
    const day = await addToDay(chatId, date, -calories, -protein);
    await metaRef(chatId).set({ last: FieldValue.delete() }, { merge: true });
    return `↩️ Removed ${Math.round(calories)} kcal · ${round1(protein)} g protein\n📅 ${date}: ${fmtDay(day)}`;
  }
  return `Unknown command.\n\n${HELP}`;
}

async function handleMeal(chatId, text) {
  let date = localDate();
  let dayLabel = "Today";
  const y = /^yesterday\b[:\s-]*/i.exec(text);
  if (y) {
    date = localDate(-1);
    dayLabel = "Yesterday";
    text = text.slice(y[0].length);
  }

  const items = await analyzeMeal(text);
  if (!items.length) return `Couldn't find any food in that.\n\n${HELP}`;

  const kcal = items.reduce((s, i) => s + i.kcal, 0);
  const protein = items.reduce((s, i) => s + i.protein, 0);
  const day = await addToDay(chatId, date, kcal, protein);
  await metaRef(chatId).set({ last: { date, calories: kcal, protein } }, { merge: true });

  const lines = items.map(
    (i) => `• ${i.estimated ? "~" : ""}${i.label} — ${Math.round(i.kcal)} kcal, ${round1(i.protein)} g`,
  );
  return [
    `🍽 +${Math.round(kcal)} kcal · ${round1(protein)} g protein`,
    ...lines,
    "",
    `📅 ${dayLabel} (${date}): ${fmtDay(day)}`,
  ].join("\n");
}

// Returns the reply text, or null if the update should be ignored.
async function handleUpdate(update) {
  const msg = update.message;
  if (!msg?.text) return null;
  const chatId = msg.chat.id;
  if (ALLOWED_CHAT_IDS.length && !ALLOWED_CHAT_IDS.includes(String(chatId))) {
    console.warn("rejected chat", chatId);
    return null;
  }
  const text = msg.text.trim();
  console.log("msg", { chatId, text });
  try {
    if (text.startsWith("/")) {
      const [, cmd, args = ""] = /^(\/\w+)(?:@\w+)?\s*([\s\S]*)$/.exec(text) || [];
      return await handleCommand(chatId, (cmd || text).toLowerCase(), args);
    }
    return await handleMeal(chatId, text);
  } catch (err) {
    console.error("handler failed:", err);
    return `⚠️ Failed: ${err.message}`;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function send(res, status, body) {
  const json = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(json);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") return send(res, 200, { ok: true });
    if (req.method === "POST" && req.url === "/telegram") {
      if (req.headers["x-telegram-bot-api-secret-token"] !== WEBHOOK_SECRET) {
        return send(res, 401, { error: "bad secret" });
      }
      const update = JSON.parse(await readBody(req));
      // Await the full parse + write before acking: Cloud Run throttles CPU
      // once the response is sent.
      const reply = await handleUpdate(update);
      if (!reply) return send(res, 200, {});
      return send(res, 200, { method: "sendMessage", chat_id: update.message.chat.id, text: reply });
    }
    if (req.method === "POST" && req.url === "/sync") {
      if (!SYNC_SECRET || req.headers["x-sync-secret"] !== SYNC_SECRET) {
        return send(res, 401, { error: "bad secret" });
      }
      // Yesterday too, in case something was logged with "yesterday" after the last run.
      const written = await syncSheet([localDate(-1), localDate()]);
      return send(res, 200, { ok: true, written });
    }
    send(res, 404, { error: "not found" });
  } catch (err) {
    console.error("request failed:", err);
    send(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => console.log(`calorie-bot listening on ${PORT}`));
