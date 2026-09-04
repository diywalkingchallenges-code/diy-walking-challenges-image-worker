CREATE TABLE IF NOT EXISTS daily_installation_artwork_slots (
    day_utc TEXT NOT NULL,
    installation_hash TEXT NOT NULL,
    artwork_slot_hash TEXT NOT NULL,
    asset_kind TEXT NOT NULL
        CHECK (asset_kind IN ('medal', 'milestone_banner', 'route_map')),
    reservation_id TEXT NOT NULL
        CHECK (length(reservation_id) BETWEEN 8 AND 128)
        CHECK (reservation_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
    reserved_at TEXT NOT NULL,
    PRIMARY KEY (day_utc, installation_hash, artwork_slot_hash)
);

CREATE INDEX IF NOT EXISTS daily_installation_artwork_slots_day
    ON daily_installation_artwork_slots (day_utc);

-- Preserve the old installation/model attempts in the total on migration day.
-- Their exact artwork slots were not stored, so synthetic non-user identifiers
-- consume only the total cap and cannot reveal past prompts or local object IDs.
INSERT OR IGNORE INTO daily_installation_artwork_slots (
    day_utc,
    installation_hash,
    artwork_slot_hash,
    asset_kind,
    reservation_id,
    reserved_at
)
WITH RECURSIVE attempt_numbers(value) AS (
    SELECT 1
    UNION ALL
    SELECT value + 1 FROM attempt_numbers WHERE value < 6
)
SELECT
    legacy.day_utc,
    legacy.installation_hash,
    'legacy-migration-' || legacy.model_alias || '-' || attempt_numbers.value,
    'medal',
    'migration-' || attempt_numbers.value || '-' || substr(legacy.model_alias, 1, 64),
    legacy.updated_at
FROM daily_installation_model_attempts AS legacy
JOIN attempt_numbers ON attempt_numbers.value <= legacy.attempts
WHERE legacy.day_utc = date('now');

