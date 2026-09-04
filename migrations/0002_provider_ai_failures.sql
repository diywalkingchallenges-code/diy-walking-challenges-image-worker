CREATE TABLE IF NOT EXISTS provider_ai_failures (
    request_id TEXT PRIMARY KEY NOT NULL
        CHECK (length(request_id) BETWEEN 8 AND 128)
        CHECK (request_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
    model_alias TEXT NOT NULL
        CHECK (length(model_alias) BETWEEN 1 AND 64)
        CHECK (model_alias NOT GLOB '*[^a-z0-9-]*'),
    asset_kind TEXT NOT NULL
        CHECK (asset_kind IN ('medal', 'milestone_banner', 'route_map')),
    provider_code TEXT NOT NULL
        CHECK (provider_code = 'unknown' OR provider_code GLOB '[35][0-9][0-9][0-9]'),
    category TEXT NOT NULL
        CHECK (category IN (
            'access',
            'capacity',
            'configuration',
            'content_filter',
            'free_quota',
            'invalid_model',
            'invalid_output',
            'timeout',
            'unknown'
        )),
    created_at TEXT NOT NULL
        CHECK (length(created_at) = 24)
        CHECK (created_at GLOB '????-??-??T??:??:??.???Z')
);

CREATE INDEX IF NOT EXISTS provider_ai_failures_created_at
    ON provider_ai_failures (created_at);
