-- Extend optional artwork kinds without resetting existing attempts or diagnostics.

CREATE TABLE IF NOT EXISTS provider_ai_failures_with_icons (
    request_id TEXT PRIMARY KEY NOT NULL
        CHECK (length(request_id) BETWEEN 8 AND 128)
        CHECK (request_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
    model_alias TEXT NOT NULL
        CHECK (length(model_alias) BETWEEN 1 AND 64)
        CHECK (model_alias NOT GLOB '*[^a-z0-9-]*'),
    asset_kind TEXT NOT NULL
        CHECK (asset_kind IN ('medal', 'milestone_banner', 'route_map', 'racer_icon', 'milestone_icon')),
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
INSERT INTO provider_ai_failures_with_icons SELECT * FROM provider_ai_failures;
DROP TABLE provider_ai_failures;
ALTER TABLE provider_ai_failures_with_icons RENAME TO provider_ai_failures;
CREATE INDEX provider_ai_failures_created_at ON provider_ai_failures (created_at);

CREATE TABLE IF NOT EXISTS daily_installation_artwork_slots_with_icons (
    day_utc TEXT NOT NULL,
    installation_hash TEXT NOT NULL,
    artwork_slot_hash TEXT NOT NULL,
    asset_kind TEXT NOT NULL
        CHECK (asset_kind IN ('medal', 'milestone_banner', 'route_map', 'racer_icon', 'milestone_icon')),
    reservation_id TEXT NOT NULL
        CHECK (length(reservation_id) BETWEEN 8 AND 128)
        CHECK (reservation_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
    reserved_at TEXT NOT NULL,
    PRIMARY KEY (day_utc, installation_hash, artwork_slot_hash)
);
INSERT INTO daily_installation_artwork_slots_with_icons SELECT * FROM daily_installation_artwork_slots;
DROP TABLE daily_installation_artwork_slots;
ALTER TABLE daily_installation_artwork_slots_with_icons RENAME TO daily_installation_artwork_slots;
CREATE INDEX daily_installation_artwork_slots_day ON daily_installation_artwork_slots (day_utc);
