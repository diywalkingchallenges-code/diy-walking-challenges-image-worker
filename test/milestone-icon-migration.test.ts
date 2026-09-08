import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { expect, it } from "vitest";

it("adds milestone icons while preserving existing racer reservations and diagnostics", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const migrations = new URL("../migrations/", import.meta.url);
    for (const file of readdirSync(migrations).filter(name => name.endsWith(".sql") && name < "0006").sort()) {
      db.exec(readFileSync(new URL(file, migrations), "utf8"));
    }
    db.exec(`INSERT INTO daily_installation_artwork_slots VALUES('2026-09-08','install','slot','racer_icon','request-old','2026-09-08T00:00:00.000Z');
      INSERT INTO provider_ai_failures VALUES('request-old','flux2-klein-4b','racer_icon','unknown','unknown','2026-09-08T00:00:00.000Z');`);
    db.exec(readFileSync(new URL("0006_milestone_icons.sql", migrations), "utf8"));
    expect(db.prepare("SELECT asset_kind FROM daily_installation_artwork_slots WHERE artwork_slot_hash='slot'").get()?.asset_kind).toBe("racer_icon");
    expect(db.prepare("SELECT asset_kind FROM provider_ai_failures WHERE request_id='request-old'").get()?.asset_kind).toBe("racer_icon");
    db.exec(`INSERT INTO daily_installation_artwork_slots VALUES('2026-09-08','install','icon','milestone_icon','request-icon','2026-09-08T00:00:00.000Z');
      INSERT INTO provider_ai_failures VALUES('request-icon','flux2-klein-4b','milestone_icon','unknown','unknown','2026-09-08T00:00:00.000Z');`);
    expect(db.prepare("SELECT count(*) AS n FROM daily_installation_artwork_slots").get()?.n).toBe(2);
    expect(db.prepare("SELECT count(*) AS n FROM provider_ai_failures").get()?.n).toBe(2);
  } finally { db.close(); }
});
