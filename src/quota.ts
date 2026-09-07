export const INSTALLATION_DAILY_ATTEMPT_LIMIT = 6;
export const ARTWORK_SLOT_DAILY_ATTEMPT_LIMIT = 1;

export type CounterReservation = { used: number; remaining: number };

type AttemptRow = { attempts: number };
type NeuronRow = { estimated_neurons_used: number };
type SlotRow = { reserved: number; attempts?: number };

export function parsePositiveLimit(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100_000_000) {
    throw new Error("Invalid quota configuration");
  }
  return parsed;
}

export function parseBooleanFlag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  if (value.trim().toLowerCase() === "true") return true;
  if (value.trim().toLowerCase() === "false") return false;
  throw new Error("Invalid boolean configuration");
}

type SlotReservation = {
  installationAttempts: CounterReservation;
  artworkSlotAttempts: CounterReservation;
};

export async function readInstallationAttemptCount(
  db: D1Database,
  day: string,
  installationHash: string,
): Promise<number> {
  const row = await db.prepare(
    `SELECT COUNT(*) AS attempts
     FROM daily_installation_artwork_slots
     WHERE day_utc = ?1 AND installation_hash = ?2`,
  ).bind(day, installationHash).first<AttemptRow>();
  return row?.attempts ?? 0;
}

async function reserveArtworkSlot(
  db: D1Database,
  day: string,
  installationHash: string,
  artworkSlotHash: string,
  assetKind: string,
  reservationId: string,
  now: string,
): Promise<SlotReservation | "installation_exhausted" | "artwork_slot_exhausted"> {
  const row = await db.prepare(
    `INSERT INTO daily_installation_artwork_slots
       (day_utc, installation_hash, artwork_slot_hash, asset_kind, reservation_id, reserved_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6
     WHERE (
       SELECT COUNT(*) FROM daily_installation_artwork_slots
       WHERE day_utc = ?1 AND installation_hash = ?2
     ) < ?7
     ON CONFLICT(day_utc, installation_hash, artwork_slot_hash) DO NOTHING
     RETURNING 1 AS reserved`,
  ).bind(
    day,
    installationHash,
    artworkSlotHash,
    assetKind,
    reservationId,
    now,
    INSTALLATION_DAILY_ATTEMPT_LIMIT,
  ).first<SlotRow>();
  if (row) {
    let used: number;
    try {
      used = await readInstallationAttemptCount(db, day, installationHash);
    } catch (error) {
      await releaseArtworkSlot(db, day, installationHash, artworkSlotHash, reservationId);
      throw error;
    }
    return {
      installationAttempts: {
        used,
        remaining: Math.max(0, INSTALLATION_DAILY_ATTEMPT_LIMIT - used),
      },
      artworkSlotAttempts: { used: 1, remaining: 0 },
    };
  }
  const existingSlot = await db.prepare(
    `SELECT 1 AS reserved FROM daily_installation_artwork_slots
     WHERE day_utc = ?1 AND installation_hash = ?2 AND artwork_slot_hash = ?3`,
  ).bind(day, installationHash, artworkSlotHash).first<SlotRow>();
  return existingSlot ? "artwork_slot_exhausted" : "installation_exhausted";
}

async function releaseArtworkSlot(
  db: D1Database,
  day: string,
  installationHash: string,
  artworkSlotHash: string,
  reservationId: string,
): Promise<void> {
  await db.prepare(
    `DELETE FROM daily_installation_artwork_slots
     WHERE day_utc = ?1 AND installation_hash = ?2
       AND artwork_slot_hash = ?3 AND reservation_id = ?4`,
  ).bind(day, installationHash, artworkSlotHash, reservationId).run();
}

async function reserveGlobalNeuronBudget(
  db: D1Database,
  day: string,
  estimatedNeurons: number,
  cap: number,
  now: string,
): Promise<CounterReservation | null> {
  const row = await db.prepare(
    `INSERT INTO daily_global_neuron_budget
       (day_utc, estimated_neurons_used, attempts, updated_at)
     SELECT ?1, ?2, 1, ?3
     WHERE ?2 <= ?4
     ON CONFLICT(day_utc) DO UPDATE SET
       estimated_neurons_used = estimated_neurons_used + excluded.estimated_neurons_used,
       attempts = attempts + 1,
       updated_at = excluded.updated_at
     WHERE estimated_neurons_used + excluded.estimated_neurons_used <= ?4
     RETURNING estimated_neurons_used`,
  ).bind(day, estimatedNeurons, now, cap).first<NeuronRow>();
  return row
    ? { used: row.estimated_neurons_used, remaining: cap - row.estimated_neurons_used }
    : null;
}

export async function readGlobalNeuronBudget(
  db: D1Database,
  day: string,
  cap: number,
): Promise<CounterReservation> {
  const row = await db.prepare(
    `SELECT estimated_neurons_used FROM daily_global_neuron_budget WHERE day_utc = ?1`,
  ).bind(day).first<NeuronRow>();
  const used = row?.estimated_neurons_used ?? 0;
  return { used, remaining: Math.max(0, cap - used) };
}

export type GenerationBudgetRequest = {
  installationHash: string;
  artworkSlotHash: string;
  reservationId: string;
  assetKind: string;
  estimatedNeurons: number;
  globalNeuronBudget: number;
  enforceInstallationDailyCaps: boolean;
  instant?: Date;
};

export async function reserveGenerationBudget(
  db: D1Database,
  request: GenerationBudgetRequest,
): Promise<
  | { result: "reserved"; installationAttempts?: CounterReservation; artworkSlotAttempts?: CounterReservation; globalNeurons: CounterReservation; estimatedNeurons: number }
  | { result: "installation_exhausted" }
  | { result: "artwork_slot_exhausted" }
  | { result: "global_exhausted"; globalNeurons: CounterReservation; estimatedNeurons: number }
> {
  if (!Number.isSafeInteger(request.estimatedNeurons) || request.estimatedNeurons < 1) {
    throw new Error("Invalid estimated Neuron reservation");
  }
  const instant = request.instant ?? new Date();
  const day = instant.toISOString().slice(0, 10);
  const now = instant.toISOString();
  let installationAttempts: CounterReservation | undefined;
  let artworkSlotAttempts: CounterReservation | undefined;

  if (request.enforceInstallationDailyCaps) {
    const slotReservation = await reserveArtworkSlot(
      db,
      day,
      request.installationHash,
      request.artworkSlotHash,
      request.assetKind,
      request.reservationId,
      now,
    );
    if (slotReservation === "installation_exhausted") return { result: slotReservation };
    if (slotReservation === "artwork_slot_exhausted") return { result: slotReservation };
    installationAttempts = slotReservation.installationAttempts;
    artworkSlotAttempts = slotReservation.artworkSlotAttempts;
  }

  let globalNeurons: CounterReservation | null;
  try {
    globalNeurons = await reserveGlobalNeuronBudget(
      db, day, request.estimatedNeurons, request.globalNeuronBudget, now,
    );
  } catch (error) {
    if (request.enforceInstallationDailyCaps) {
      await releaseArtworkSlot(
        db, day, request.installationHash, request.artworkSlotHash, request.reservationId,
      );
    }
    throw error;
  }
  if (!globalNeurons) {
    if (request.enforceInstallationDailyCaps) {
      await releaseArtworkSlot(
        db, day, request.installationHash, request.artworkSlotHash, request.reservationId,
      );
    }
    return {
      result: "global_exhausted",
      globalNeurons: await readGlobalNeuronBudget(db, day, request.globalNeuronBudget),
      estimatedNeurons: request.estimatedNeurons,
    };
  }

  return {
    result: "reserved",
    ...(installationAttempts ? { installationAttempts } : {}),
    ...(artworkSlotAttempts ? { artworkSlotAttempts } : {}),
    globalNeurons,
    estimatedNeurons: request.estimatedNeurons,
  };
}

export function secondsUntilNextUtcDay(instant = new Date()): number {
  const next = Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - instant.getTime()) / 1_000));
}

export async function pruneExpiredDailyQuota(
  db: D1Database,
  instant = new Date(),
  retentionDays = 31,
): Promise<void> {
  if (!Number.isSafeInteger(retentionDays) || retentionDays < 2 || retentionDays > 366) {
    throw new Error("Invalid quota retention period");
  }
  const cutoff = new Date(instant);
  cutoff.setUTCDate(cutoff.getUTCDate() - retentionDays);
  const cutoffDay = cutoff.toISOString().slice(0, 10);
  await db.prepare(
    `DELETE FROM daily_installation_artwork_slots WHERE day_utc < ?1`,
  ).bind(cutoffDay).run();
  await db.prepare(`DELETE FROM generation_attempts WHERE day_utc < ?1`).bind(cutoffDay).run();
  await db.prepare(`DELETE FROM daily_artwork_neuron_usage WHERE day_utc < ?1`).bind(cutoffDay).run();
}
