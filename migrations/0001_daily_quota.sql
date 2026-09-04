CREATE TABLE IF NOT EXISTS daily_global_neuron_budget (
    day_utc TEXT PRIMARY KEY NOT NULL,
    estimated_neurons_used INTEGER NOT NULL DEFAULT 0 CHECK (estimated_neurons_used >= 0),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS daily_installation_model_attempts (
    day_utc TEXT NOT NULL,
    installation_hash TEXT NOT NULL,
    model_alias TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (day_utc, installation_hash, model_alias)
);

CREATE TABLE IF NOT EXISTS generation_reports (
    report_id TEXT PRIMARY KEY NOT NULL,
    generation_request_id TEXT NOT NULL,
    installation_hash TEXT NOT NULL,
    reason TEXT NOT NULL,
    details TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (generation_request_id, installation_hash)
);

CREATE INDEX IF NOT EXISTS generation_reports_created_at
    ON generation_reports (created_at);
