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
       VALUES (?1, ?2, 1, ?3)
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
  | { result: "global_exhausted" }
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

  const globalNeurons = await reserveGlobalNeuronBudget(
    db,
    day,
    estimatedNeurons,
    globalNeuronBudget,
    now,
  );
  return globalNeurons
    ? { result: "reserved", modelAttempts, globalNeurons, estimatedNeurons }
    : { result: "global_exhausted" };
}

export function secondsUntilNextUtcDay(instant = new Date()): number {
  const next = Date.UTC(
    instant.getUTCFullYear(),
    instant.getUTCMonth(),
    instant.getUTCDate() + 1,
  );
  return Math.max(1, Math.ceil((next - instant.getTime()) / 1_000));
}
