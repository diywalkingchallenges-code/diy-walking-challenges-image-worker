export const MODEL_DAILY_ATTEMPT_LIMIT = 3;

export type CounterReservation = {
  used: number;
  remaining: number;
};

type AttemptRow = { attempts: number };
type NeuronRow = { estimated_neurons_used: number };

export function parsePositiveLimit(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100_000_000) {
    throw new Error("Invalid quota configuration");
  }
  return parsed;
}

async function reserveInstallationModelAttempt(
  db: D1Database,
  day: string,
  installationHash: string,
  modelAlias: string,
  now: string,
): Promise<CounterReservation | null> {
  const row = await db
    .prepare(
      `INSERT INTO daily_installation_model_attempts
         (day_utc, installation_hash, model_alias, attempts, updated_at)
       VALUES (?1, ?2, ?3, 1, ?4)
       ON CONFLICT(day_utc, installation_hash, model_alias) DO UPDATE SET
         attempts = attempts + 1,
         updated_at = excluded.updated_at
       WHERE attempts < ?5
       RETURNING attempts`,
    )
    .bind(day, installationHash, modelAlias, now, MODEL_DAILY_ATTEMPT_LIMIT)
    .first<AttemptRow>();
  return row
    ? { used: row.attempts, remaining: MODEL_DAILY_ATTEMPT_LIMIT - row.attempts }
    : null;
}

async function reserveGlobalNeuronBudget(
  db: D1Database,
  day: string,
  estimatedNeurons: number,
  cap: number,
  now: string,
): Promise<CounterReservation | null> {
  const row = await db
    .prepare(
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
    )
    .bind(day, estimatedNeurons, now, cap)
    .first<NeuronRow>();
  return row
    ? { used: row.estimated_neurons_used, remaining: cap - row.estimated_neurons_used }
    : null;
}

async function readGlobalNeuronBudget(
  db: D1Database,
  day: string,
  cap: number,
): Promise<CounterReservation> {
  const row = await db
    .prepare(
      `SELECT estimated_neurons_used
       FROM daily_global_neuron_budget
       WHERE day_utc = ?1`,
    )
    .bind(day)
    .first<NeuronRow>();
  const used = row?.estimated_neurons_used ?? 0;
  return { used, remaining: Math.max(0, cap - used) };
}

async function releaseInstallationModelAttempt(
  db: D1Database,
  day: string,
  installationHash: string,
  modelAlias: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE daily_installation_model_attempts
       SET attempts = MAX(0, attempts - 1)
       WHERE day_utc = ?1
         AND installation_hash = ?2
         AND model_alias = ?3`,
    )
    .bind(day, installationHash, modelAlias)
    .run();
}

export async function reserveGenerationBudget(
  db: D1Database,
  installationHash: string,
  modelAlias: string,
  estimatedNeurons: number,
  globalNeuronBudget: number,
  instant = new Date(),
): Promise<
  | {
      result: "reserved";
      modelAttempts: CounterReservation;
      globalNeurons: CounterReservation;
      estimatedNeurons: number;
    }
  | { result: "model_exhausted" }
  | {
      result: "global_exhausted";
      globalNeurons: CounterReservation;
      estimatedNeurons: number;
    }
> {
  if (!Number.isSafeInteger(estimatedNeurons) || estimatedNeurons < 1) {
    throw new Error("Invalid estimated Neuron reservation");
  }
  const day = instant.toISOString().slice(0, 10);
  const now = instant.toISOString();
  const modelAttempts = await reserveInstallationModelAttempt(
    db,
    day,
    installationHash,
    modelAlias,
    now,
  );
  if (!modelAttempts) return { result: "model_exhausted" };

  let globalNeurons: CounterReservation | null;
  try {
    globalNeurons = await reserveGlobalNeuronBudget(
      db,
      day,
      estimatedNeurons,
      globalNeuronBudget,
      now,
    );
  } catch (error) {
    // A D1 failure after the model attempt was reserved must not silently use
    // up one of that installation's three attempts.
    await releaseInstallationModelAttempt(db, day, installationHash, modelAlias);
    throw error;
  }
  if (!globalNeurons) {
    await releaseInstallationModelAttempt(db, day, installationHash, modelAlias);
    return {
      result: "global_exhausted",
      globalNeurons: await readGlobalNeuronBudget(db, day, globalNeuronBudget),
      estimatedNeurons,
    };
  }

  return { result: "reserved", modelAttempts, globalNeurons, estimatedNeurons };
}

export function secondsUntilNextUtcDay(instant = new Date()): number {
  const next = Date.UTC(
    instant.getUTCFullYear(),
    instant.getUTCMonth(),
    instant.getUTCDate() + 1,
  );
  return Math.max(1, Math.ceil((next - instant.getTime()) / 1_000));
}
