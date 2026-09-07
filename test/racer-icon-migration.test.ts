import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { expect, it } from "vitest";

it("extends artwork kinds without losing old quota reservations or diagnostics", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const migrations = new URL("../migrations/", import.meta.url);
    for (const file of readdirSync(migrations).filter(name => name.endsWith(".sql") && name < "0005").sort()) {
      db.exec(readFileSync(new URL(file, migrations), "utf8"));
    }
    db.exec(`INSERT INTO daily_installation_artwork_slots VALUES('2026-09-07','install','slot','medal','request-old','2026-09-07T00:00:00.000Z');
      INSERT INTO provider_ai_failures VALUES('request-old','flux2-klein-4b','medal','unknown','unknown','2026-09-07T00:00:00.000Z');`);
    db.exec(readFileSync(new URL("0005_racer_icons.sql", migrations), "utf8"));
    expect(db.prepare("SELECT asset_kind FROM daily_installation_artwork_slots WHERE artwork_slot_hash='slot'").get()?.asset_kind).toBe("medal");
    expect(db.prepare("SELECT asset_kind FROM provider_ai_failures WHERE request_id='request-old'").get()?.asset_kind).toBe("medal");
    db.exec(`INSERT INTO daily_installation_artwork_slots VALUES('2026-09-07','install','icon','racer_icon','request-icon','2026-09-07T00:00:00.000Z');
      INSERT INTO provider_ai_failures VALUES('request-icon','flux2-klein-4b','racer_icon','unknown','unknown','2026-09-07T00:00:00.000Z');`);
    expect(db.prepare("SELECT count(*) AS n FROM daily_installation_artwork_slots").get()?.n).toBe(2);
    expect(db.prepare("SELECT count(*) AS n FROM provider_ai_failures").get()?.n).toBe(2);
  } finally { db.close(); }
});
