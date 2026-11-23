-- Operational Telemetry database schema and seed data for BionicPRO

CREATE TABLE IF NOT EXISTS prosthesis_telemetry (
    id BIGSERIAL PRIMARY KEY,
    prosthesis_id INTEGER NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL,
    movement_type VARCHAR(64) NOT NULL,
    response_time_ms REAL NOT NULL,
    battery_level REAL NOT NULL,
    signal_noise_ratio REAL NOT NULL,
    error_flag BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_telemetry_prosthesis_recorded
    ON prosthesis_telemetry (prosthesis_id, recorded_at);

-- Generate 10 days of realistic telemetry up to today (including today's data
-- which stays outside the Airflow processed watermark until the next daily boundary)
INSERT INTO prosthesis_telemetry (
    prosthesis_id,
    recorded_at,
    movement_type,
    response_time_ms,
    battery_level,
    signal_noise_ratio,
    error_flag
)
SELECT
    p.prosthesis_id,
    (date_trunc('day', NOW() AT TIME ZONE 'UTC') - (d.day_offset || ' days')::interval
        + (h.hour_offset || ' hours')::interval
        + (m.min_offset || ' minutes')::interval) AT TIME ZONE 'UTC' AS recorded_at,
    (ARRAY['pinch', 'power_grip', 'wrist_rotate', 'open_hand', 'point'])[
        1 + ((p.prosthesis_id + d.day_offset + h.hour_offset + m.min_offset) % 5)
    ] AS movement_type,
    ROUND((42.0 + ((p.prosthesis_id * 7 + d.day_offset * 3 + h.hour_offset * 5 + m.min_offset) % 45))::numeric, 2)::real AS response_time_ms,
    GREATEST(
        15.0,
        ROUND((98.0 - h.hour_offset * 4.2 - (m.min_offset * 0.05))::numeric, 2)
    )::real AS battery_level,
    ROUND((18.5 + ((p.prosthesis_id + d.day_offset + h.hour_offset) % 12) * 0.8)::numeric, 2)::real AS signal_noise_ratio,
    ((p.prosthesis_id + d.day_offset + h.hour_offset + m.min_offset) % 29 = 0) AS error_flag
FROM (VALUES (101), (102), (103), (104)) AS p(prosthesis_id)
CROSS JOIN generate_series(0, 9) AS d(day_offset)
CROSS JOIN generate_series(8, 20, 2) AS h(hour_offset)
CROSS JOIN generate_series(0, 45, 15) AS m(min_offset);
