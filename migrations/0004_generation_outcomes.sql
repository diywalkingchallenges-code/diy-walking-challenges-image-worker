-- Keep refunded work in a separate ledger so canceling cannot erase its cost.
CREATE TABLE daily_artwork_neuron_usage (
    day_utc TEXT NOT NULL,
    installation_hash TEXT NOT NULL,
    artwork_slot_hash TEXT NOT NULL,
    estimated_neurons_used INTEGER NOT NULL DEFAULT 0 CHECK (estimated_neurons_used >= 0),
    PRIMARY KEY (day_utc, installation_hash, artwork_slot_hash)
);

CREATE TABLE generation_attempts (
    installation_hash TEXT NOT NULL,
    generation_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    day_utc TEXT NOT NULL,
    artwork_slot_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('preparing', 'pending', 'succeeded', 'failed', 'canceled')),
    cancel_requested INTEGER NOT NULL DEFAULT 0,
    reserved_neurons INTEGER NOT NULL DEFAULT 0 CHECK (reserved_neurons >= 0),
    spent_neurons INTEGER NOT NULL DEFAULT 0 CHECK (spent_neurons >= 0),
    settlement_id TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (installation_hash, generation_id)
);
CREATE INDEX generation_attempts_day ON generation_attempts(day_utc);
