"""
Airflow ETL DAG for BionicPRO prosthesis usage reports.

Pipeline schedule: every hour ("0 * * * *").
Extracts customer/prosthesis metadata from CRM DB (PostgreSQL) and raw sensor
telemetry from Telemetry DB (PostgreSQL), loads them into ClickHouse OLAP,
builds the pre-aggregated `user_reports_mart` table grouped by client/prosthesis/day,
and updates `etl_watermarks` so the Reports API only serves periods already
processed by Airflow.
"""

from __future__ import annotations

import logging
import os
from datetime import date, datetime, timedelta, timezone
from typing import Any

import clickhouse_connect
import psycopg2
from airflow import DAG
from airflow.operators.python import PythonOperator

logger = logging.getLogger(__name__)

PIPELINE_NAME = "prosthesis_reports_etl"
CLICKHOUSE_DB = os.getenv("CLICKHOUSE_DB", "bionicpro_olap")


def _get_pg_connection(prefix: str):
    return psycopg2.connect(
        host=os.getenv(f"{prefix}_DB_HOST", "localhost"),
        port=int(os.getenv(f"{prefix}_DB_PORT", "5432")),
        dbname=os.getenv(f"{prefix}_DB_NAME"),
        user=os.getenv(f"{prefix}_DB_USER"),
        password=os.getenv(f"{prefix}_DB_PASSWORD"),
    )


def _get_clickhouse_client():
    return clickhouse_connect.get_client(
        host=os.getenv("CLICKHOUSE_HOST", "clickhouse"),
        port=int(os.getenv("CLICKHOUSE_PORT", "8123")),
        username=os.getenv("CLICKHOUSE_USER", "default"),
        password=os.getenv("CLICKHOUSE_PASSWORD", "clickhouse_pass"),
    )


def _resolve_cutoff_date(context: dict[str, Any]) -> date:
    """
    Use the last completed UTC day (logical_date - 1 day, capped at yesterday UTC)
    so partial/in-progress current-day telemetry is excluded until Airflow processes it.
    """
    logical_date: datetime | None = context.get("logical_date")
    yesterday_utc = (datetime.now(timezone.utc) - timedelta(days=1)).date()
    if logical_date is None:
        return yesterday_utc
    candidate = (logical_date.astimezone(timezone.utc) - timedelta(days=1)).date()
    return min(candidate, yesterday_utc)


def ensure_olap_schema() -> None:
    client = _get_clickhouse_client()
    client.command(f"CREATE DATABASE IF NOT EXISTS {CLICKHOUSE_DB}")

    client.command(
        f"""
        CREATE TABLE IF NOT EXISTS {CLICKHOUSE_DB}.crm_customers_staging (
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
        ORDER BY (keycloak_username, prosthesis_id)
        """
    )

    client.command(
        f"""
        CREATE TABLE IF NOT EXISTS {CLICKHOUSE_DB}.telemetry_raw (
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
        ORDER BY (prosthesis_id, report_date, telemetry_id)
        """
    )

    client.command(
        f"""
        CREATE TABLE IF NOT EXISTS {CLICKHOUSE_DB}.user_reports_mart (
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
        ORDER BY (keycloak_username, report_date, prosthesis_id)
        """
    )

    client.command(
        f"""
        CREATE TABLE IF NOT EXISTS {CLICKHOUSE_DB}.etl_watermarks (
            pipeline_name LowCardinality(String),
            min_processed_date Date,
            max_processed_date Date,
            records_loaded UInt64,
            processed_at DateTime,
            status LowCardinality(String)
        ) ENGINE = MergeTree()
        ORDER BY (pipeline_name, processed_at)
        """
    )
    logger.info("Verified ClickHouse OLAP schema in database %s", CLICKHOUSE_DB)


def extract_crm_data() -> int:
    conn = _get_pg_connection("CRM")
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT
                    c.id AS customer_id,
                    c.keycloak_username,
                    c.full_name,
                    c.email,
                    c.country_code,
                    p.id AS prosthesis_id,
                    p.serial_number,
                    p.model_name,
                    p.firmware_version
                FROM customers c
                INNER JOIN prostheses p ON p.customer_id = c.id
                WHERE p.status = 'active'
                ORDER BY c.id, p.id
                """
            )
            rows = cur.fetchall()
    finally:
        conn.close()

    client = _get_clickhouse_client()
    now_utc = datetime.now(timezone.utc).replace(tzinfo=None)
    payload = [(*row, now_utc) for row in rows]

    client.command(f"TRUNCATE TABLE {CLICKHOUSE_DB}.crm_customers_staging")
    if payload:
        client.insert(
            f"{CLICKHOUSE_DB}.crm_customers_staging",
            payload,
            column_names=[
                "customer_id",
                "keycloak_username",
                "customer_name",
                "customer_email",
                "country_code",
                "prosthesis_id",
                "serial_number",
                "prosthesis_model",
                "firmware_version",
                "updated_at",
            ],
        )
    logger.info("Loaded %d CRM customer-prosthesis rows into ClickHouse", len(payload))
    return len(payload)


def extract_telemetry_data(**context: Any) -> int:
    cutoff_date = _resolve_cutoff_date(context)
    logger.info("Extracting telemetry up to cutoff_date=%s", cutoff_date.isoformat())

    conn = _get_pg_connection("TELEMETRY")
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT
                    id,
                    prosthesis_id,
                    recorded_at AT TIME ZONE 'UTC' AS recorded_at_utc,
                    (recorded_at AT TIME ZONE 'UTC')::date AS report_date,
                    movement_type,
                    response_time_ms,
                    battery_level,
                    signal_noise_ratio,
                    CASE WHEN error_flag THEN 1 ELSE 0 END AS error_flag
                FROM prosthesis_telemetry
                WHERE (recorded_at AT TIME ZONE 'UTC')::date <= %s
                ORDER BY id
                """,
                (cutoff_date,),
            )
            rows = cur.fetchall()
    finally:
        conn.close()

    client = _get_clickhouse_client()
    client.command(f"TRUNCATE TABLE {CLICKHOUSE_DB}.telemetry_raw")

    batch_size = 5000
    columns = [
        "telemetry_id",
        "prosthesis_id",
        "recorded_at",
        "report_date",
        "movement_type",
        "response_time_ms",
        "battery_level",
        "signal_noise_ratio",
        "error_flag",
    ]
    for idx in range(0, len(rows), batch_size):
        client.insert(
            f"{CLICKHOUSE_DB}.telemetry_raw",
            rows[idx : idx + batch_size],
            column_names=columns,
        )

    logger.info(
        "Loaded %d telemetry rows into ClickHouse (cutoff_date=%s)",
        len(rows),
        cutoff_date.isoformat(),
    )
    return len(rows)


def build_reports_mart(**context: Any) -> None:
    cutoff_date = _resolve_cutoff_date(context)
    client = _get_clickhouse_client()

    # Rebuild the pre-aggregated reporting mart cleanly for all completed dates <= cutoff_date
    client.command(f"TRUNCATE TABLE {CLICKHOUSE_DB}.user_reports_mart")
    client.command(
        f"""
        INSERT INTO {CLICKHOUSE_DB}.user_reports_mart (
            keycloak_username,
            customer_id,
            customer_name,
            customer_email,
            country_code,
            prosthesis_id,
            serial_number,
            prosthesis_model,
            firmware_version,
            report_date,
            total_movements,
            avg_response_time_ms,
            max_response_time_ms,
            avg_battery_level,
            min_battery_level,
            avg_signal_noise_ratio,
            error_count,
            active_minutes,
            updated_at
        )
        SELECT
            c.keycloak_username,
            c.customer_id,
            c.customer_name,
            c.customer_email,
            c.country_code,
            c.prosthesis_id,
            c.serial_number,
            c.prosthesis_model,
            c.firmware_version,
            t.report_date,
            toUInt32(count()) AS total_movements,
            toFloat32(round(avg(t.response_time_ms), 2)) AS avg_response_time_ms,
            toFloat32(round(max(t.response_time_ms), 2)) AS max_response_time_ms,
            toFloat32(round(avg(t.battery_level), 2)) AS avg_battery_level,
            toFloat32(round(min(t.battery_level), 2)) AS min_battery_level,
            toFloat32(round(avg(t.signal_noise_ratio), 2)) AS avg_signal_noise_ratio,
            toUInt32(sum(t.error_flag)) AS error_count,
            toUInt32(uniqExact(toStartOfMinute(t.recorded_at))) AS active_minutes,
            now() AS updated_at
        FROM {CLICKHOUSE_DB}.telemetry_raw AS t
        INNER JOIN {CLICKHOUSE_DB}.crm_customers_staging AS c
            ON t.prosthesis_id = c.prosthesis_id
        WHERE t.report_date <= toDate('{cutoff_date.isoformat()}')
        GROUP BY
            c.keycloak_username,
            c.customer_id,
            c.customer_name,
            c.customer_email,
            c.country_code,
            c.prosthesis_id,
            c.serial_number,
            c.prosthesis_model,
            c.firmware_version,
            t.report_date
        """
    )
    client.command(f"OPTIMIZE TABLE {CLICKHOUSE_DB}.user_reports_mart FINAL")
    logger.info("Rebuilt user_reports_mart up to %s", cutoff_date.isoformat())


def update_etl_watermark(**context: Any) -> None:
    cutoff_date = _resolve_cutoff_date(context)
    client = _get_clickhouse_client()

    result = client.query(
        f"""
        SELECT
            min(report_date) AS min_date,
            max(report_date) AS max_date,
            count() AS total_rows
        FROM {CLICKHOUSE_DB}.user_reports_mart FINAL
        WHERE report_date <= toDate('{cutoff_date.isoformat()}')
        """
    )
    min_date, max_date, total_rows = result.result_rows[0]
    if total_rows == 0:
        logger.warning("No mart rows found; skipping watermark update")
        return

    now_utc = datetime.now(timezone.utc).replace(tzinfo=None)
    client.insert(
        f"{CLICKHOUSE_DB}.etl_watermarks",
        [
            (
                PIPELINE_NAME,
                min_date,
                max_date,
                int(total_rows),
                now_utc,
                "success",
            )
        ],
        column_names=[
            "pipeline_name",
            "min_processed_date",
            "max_processed_date",
            "records_loaded",
            "processed_at",
            "status",
        ],
    )
    logger.info(
        "Recorded ETL watermark: pipeline=%s range=%s..%s rows=%d",
        PIPELINE_NAME,
        min_date,
        max_date,
        total_rows,
    )


default_args = {
    "owner": "bionicpro-data",
    "depends_on_past": False,
    "retries": 2,
    "retry_delay": timedelta(minutes=2),
}

with DAG(
    dag_id=PIPELINE_NAME,
    description="ETL pipeline combining CRM and prosthesis telemetry into ClickHouse reporting mart",
    default_args=default_args,
    start_date=datetime(2025, 1, 1, tzinfo=timezone.utc),
    schedule="0 * * * *",
    catchup=False,
    max_active_runs=1,
    tags=["bionicpro", "etl", "clickhouse", "reports"],
) as dag:
    t_ensure_schema = PythonOperator(
        task_id="ensure_olap_schema",
        python_callable=ensure_olap_schema,
    )

    t_extract_crm = PythonOperator(
        task_id="extract_crm_data",
        python_callable=extract_crm_data,
    )

    t_extract_telemetry = PythonOperator(
        task_id="extract_telemetry_data",
        python_callable=extract_telemetry_data,
    )

    t_build_mart = PythonOperator(
        task_id="build_reports_mart",
        python_callable=build_reports_mart,
    )

    t_update_watermark = PythonOperator(
        task_id="update_etl_watermark",
        python_callable=update_etl_watermark,
    )

    t_ensure_schema >> [t_extract_crm, t_extract_telemetry] >> t_build_mart >> t_update_watermark
