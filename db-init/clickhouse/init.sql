CREATE DATABASE IF NOT EXISTS bionicpro_olap;

CREATE TABLE IF NOT EXISTS bionicpro_olap.crm_customers_staging (
    customer_id UInt32,
    keycloak_username String,
    customer_name String,
    customer_email String,
    country_code LowCardinality(String),
    prosthesis_id UInt32,
    serial_number String,
    prosthesis_model String,
    firmware_version String,
    updated_at DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (keycloak_username, prosthesis_id);

CREATE TABLE IF NOT EXISTS bionicpro_olap.telemetry_raw (
    telemetry_id UInt64,
    prosthesis_id UInt32,
    recorded_at DateTime,
    report_date Date,
    movement_type LowCardinality(String),
    response_time_ms Float32,
    battery_level Float32,
    signal_noise_ratio Float32,
    error_flag UInt8
) ENGINE = ReplacingMergeTree()
PARTITION BY toYYYYMM(report_date)
ORDER BY (prosthesis_id, report_date, telemetry_id);

CREATE TABLE IF NOT EXISTS bionicpro_olap.user_reports_mart (
    keycloak_username String,
    customer_id UInt32,
    customer_name String,
    customer_email String,
    country_code LowCardinality(String),
    prosthesis_id UInt32,
    serial_number String,
    prosthesis_model String,
    firmware_version String,
    report_date Date,
    total_movements UInt32,
    avg_response_time_ms Float32,
    max_response_time_ms Float32,
    avg_battery_level Float32,
    min_battery_level Float32,
    avg_signal_noise_ratio Float32,
    error_count UInt32,
    active_minutes UInt32,
    updated_at DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(updated_at)
PARTITION BY toYYYYMM(report_date)
ORDER BY (keycloak_username, report_date, prosthesis_id);

CREATE TABLE IF NOT EXISTS bionicpro_olap.etl_watermarks (
    pipeline_name LowCardinality(String),
    min_processed_date Date,
    max_processed_date Date,
    records_loaded UInt64,
    processed_at DateTime,
    status LowCardinality(String)
) ENGINE = MergeTree()
ORDER BY (pipeline_name, processed_at);
