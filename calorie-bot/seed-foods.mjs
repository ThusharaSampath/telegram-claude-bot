// One-off: load foods.mjs (names + aliases) into the Firestore `foods`
// collection with source "seed". Only creates missing names, so re-running is
// safe and never overwrites /add or Claude entries.
// Usage: GOOGLE_CLOUD_PROJECT=serendib-custom node seed-foods.mjs
import { Firestore } from "@google-cloud/firestore";
import { FOODS } from "./foods.mjs";

const db = new Firestore();
const writer = db.bulkWriter();
let created = 0;
let skipped = 0;
writer.onWriteError((err) => {
  if (err.code === 6) skipped++; // ALREADY_EXISTS
  else console.error("write failed:", err.documentRef.id, err.message);
  return false;
});

for (const [name, { kcal, protein, unit = null, aliases = [] }] of Object.entries(FOODS)) {
  for (const key of [name, ...aliases]) {
    writer
      .create(db.collection("foods").doc(key.replace(/\//g, "_")), { kcal, protein, unit, source: "seed" })
      .then(() => created++)
      .catch(() => {});
  }
}
await writer.close();
console.log(`seeded: ${created} created, ${skipped} already existed`);
