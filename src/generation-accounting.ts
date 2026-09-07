import { INSTALLATION_DAILY_ATTEMPT_LIMIT, readInstallationAttemptCount } from "./quota";

export const FREE_FAILED_GENERATION_NEURONS = 500;
export type GenerationKey = { installationHash: string; generationId: string };
type Attempt = {
  request_id: string; day_utc: string; artwork_slot_hash: string;
  status: "preparing" | "pending" | "succeeded" | "failed" | "canceled";
  cancel_requested: number; reserved_neurons: number; spent_neurons: number;
};
export type ArtworkAllowance = {
  installationRemaining: number; artworkSlotRemaining: number;
  estimatedNeuronsUsed: number; freeFailureNeuronLimit: number;
  resetsAtEpochMillis: number; pending: boolean;
};

export async function readGeneration(db: D1Database, key: GenerationKey): Promise<Attempt | null> {
  return db.prepare(`SELECT * FROM generation_attempts WHERE installation_hash = ?1 AND generation_id = ?2`)
    .bind(key.installationHash, key.generationId).first<Attempt>();
}

export async function beginGeneration(
  db: D1Database, key: GenerationKey, requestId: string, slotHash: string, instant: Date,
): Promise<boolean> {
  const row = await db.prepare(`INSERT INTO generation_attempts
    (installation_hash, generation_id, request_id, day_utc, artwork_slot_hash, status, created_at)
    VALUES (?1, ?2, ?3, ?4, ?5, 'preparing', ?6)
    ON CONFLICT(installation_hash, generation_id) DO NOTHING RETURNING request_id`)
    .bind(key.installationHash, key.generationId, requestId, instant.toISOString().slice(0, 10), slotHash, instant.toISOString())
    .first();
  return row !== null;
}

export async function setGenerationReservation(db: D1Database, key: GenerationKey, neurons: number): Promise<void> {
  await db.prepare(`UPDATE generation_attempts SET status = 'pending', reserved_neurons = ?3
    WHERE installation_hash = ?1 AND generation_id = ?2 AND status = 'preparing'`)
    .bind(key.installationHash, key.generationId, neurons).run();
}

/** Claim each AI stage before starting it. A canceled or settled request cannot start more AI work. */
export async function startGenerationStage(db: D1Database, key: GenerationKey, neurons: number): Promise<boolean> {
  const row = await db.prepare(`UPDATE generation_attempts SET spent_neurons = spent_neurons + ?3
    WHERE installation_hash = ?1 AND generation_id = ?2 AND status = 'pending'
      AND cancel_requested = 0 AND spent_neurons + ?3 <= reserved_neurons RETURNING spent_neurons`)
    .bind(key.installationHash, key.generationId, neurons).first();
  return row !== null;
}

/** Atomic and idempotent: retain spent neurons, refund only unstarted work, then settle the personal use. */
export async function finishGeneration(
  db: D1Database, key: GenerationKey, outcome: "succeeded" | "failed" | "canceled",
): Promise<Attempt | null> {
  const settlementId = crypto.randomUUID();
  await db.batch([
    db.prepare(`UPDATE generation_attempts SET status = CASE WHEN cancel_requested = 1 THEN 'canceled' ELSE ?3 END,
      settlement_id = ?4 WHERE installation_hash = ?1 AND generation_id = ?2 AND status = 'pending'`)
      .bind(key.installationHash, key.generationId, outcome, settlementId),
    db.prepare(`INSERT INTO daily_artwork_neuron_usage (day_utc, installation_hash, artwork_slot_hash, estimated_neurons_used)
      SELECT day_utc, installation_hash, artwork_slot_hash, spent_neurons FROM generation_attempts WHERE settlement_id = ?1
      ON CONFLICT(day_utc, installation_hash, artwork_slot_hash) DO UPDATE SET
        estimated_neurons_used = estimated_neurons_used + excluded.estimated_neurons_used`).bind(settlementId),
    db.prepare(`UPDATE daily_global_neuron_budget SET estimated_neurons_used = MAX(0, estimated_neurons_used - (
      SELECT reserved_neurons - spent_neurons FROM generation_attempts WHERE settlement_id = ?1))
      WHERE day_utc = (SELECT day_utc FROM generation_attempts WHERE settlement_id = ?1)`).bind(settlementId),
    db.prepare(`DELETE FROM daily_installation_artwork_slots WHERE reservation_id IN (
      SELECT a.request_id FROM generation_attempts a JOIN daily_artwork_neuron_usage u
        ON u.day_utc = a.day_utc AND u.installation_hash = a.installation_hash AND u.artwork_slot_hash = a.artwork_slot_hash
      WHERE a.settlement_id = ?1 AND a.status <> 'succeeded' AND u.estimated_neurons_used <= ?2
        AND a.installation_hash = daily_installation_artwork_slots.installation_hash
        AND a.day_utc = daily_installation_artwork_slots.day_utc
        AND a.artwork_slot_hash = daily_installation_artwork_slots.artwork_slot_hash)`)
      .bind(settlementId, FREE_FAILED_GENERATION_NEURONS),
  ]);
  return readGeneration(db, key);
}

/** An early cancellation creates a tombstone; a delayed POST cannot resurrect it. */
export async function cancelGeneration(db: D1Database, key: GenerationKey, instant = new Date()): Promise<Attempt | null> {
  await db.prepare(`INSERT INTO generation_attempts
    (installation_hash, generation_id, request_id, day_utc, artwork_slot_hash, status, cancel_requested, created_at)
    VALUES (?1, ?2, ?2, ?3, '', 'canceled', 1, ?4)
    ON CONFLICT(installation_hash, generation_id) DO UPDATE SET cancel_requested = 1,
      status = CASE WHEN status = 'succeeded' THEN 'canceled' ELSE status END
      WHERE status IN ('preparing', 'pending') OR (status = 'succeeded' AND created_at >= ?5)`)
    .bind(key.installationHash, key.generationId, instant.toISOString().slice(0, 10), instant.toISOString(),
      new Date(instant.getTime() - 5 * 60_000).toISOString()).run();
  const attempt = await finishGeneration(db, key, "canceled");
  // Cancellation can race the image download. Allow its short delivery window, without
  // counting the same work twice or refunding an already completed image hours later.
  await db.prepare(`DELETE FROM daily_installation_artwork_slots WHERE reservation_id IN (
    SELECT a.request_id FROM generation_attempts a JOIN daily_artwork_neuron_usage u
      ON u.day_utc = a.day_utc AND u.installation_hash = a.installation_hash AND u.artwork_slot_hash = a.artwork_slot_hash
    WHERE a.installation_hash = ?1 AND a.generation_id = ?2 AND a.status = 'canceled'
      AND u.estimated_neurons_used <= ?3 AND a.installation_hash = daily_installation_artwork_slots.installation_hash
      AND a.day_utc = daily_installation_artwork_slots.day_utc AND a.artwork_slot_hash = daily_installation_artwork_slots.artwork_slot_hash)`)
    .bind(key.installationHash, key.generationId, FREE_FAILED_GENERATION_NEURONS).run();
  return attempt;
}

export async function readArtworkAllowance(
  db: D1Database, day: string, installationHash: string, artworkSlotHash: string,
): Promise<ArtworkAllowance> {
  const [used, slot, neurons, pending] = await Promise.all([
    readInstallationAttemptCount(db, day, installationHash),
    db.prepare(`SELECT 1 AS used FROM daily_installation_artwork_slots
      WHERE day_utc = ?1 AND installation_hash = ?2 AND artwork_slot_hash = ?3`)
      .bind(day, installationHash, artworkSlotHash).first(),
    db.prepare(`SELECT estimated_neurons_used FROM daily_artwork_neuron_usage
      WHERE day_utc = ?1 AND installation_hash = ?2 AND artwork_slot_hash = ?3`)
      .bind(day, installationHash, artworkSlotHash).first<{ estimated_neurons_used: number }>(),
    db.prepare(`SELECT 1 AS pending FROM generation_attempts WHERE day_utc = ?1 AND installation_hash = ?2
      AND artwork_slot_hash = ?3 AND status IN ('preparing', 'pending')`)
      .bind(day, installationHash, artworkSlotHash).first(),
  ]);
  return {
    installationRemaining: Math.max(0, INSTALLATION_DAILY_ATTEMPT_LIMIT - used),
    artworkSlotRemaining: slot ? 0 : 1, estimatedNeuronsUsed: neurons?.estimated_neurons_used ?? 0,
    freeFailureNeuronLimit: FREE_FAILED_GENERATION_NEURONS,
    resetsAtEpochMillis: Date.parse(`${day}T00:00:00Z`) + 86_400_000, pending: pending !== null,
  };
}
