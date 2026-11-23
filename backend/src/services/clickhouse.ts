import { createClient, ClickHouseClient } from '@clickhouse/client';
import {
  EtlWatermark,
  ReportMartRow,
  ReportRepository,
} from '../types/report';

export interface ClickHouseConfig {
  url: string;
  username: string;
  password: string;
  database: string;
}

interface WatermarkQueryRow {
  pipeline_name: string;
  min_processed_date: string;
  max_processed_date: string;
  records_loaded: string | number;
  processed_at: string;
  status: string;
}

export class ClickHouseReportRepository implements ReportRepository {
  private readonly client: ClickHouseClient;
  private readonly database: string;

  constructor(config: ClickHouseConfig) {
    this.database = config.database;
    this.client = createClient({
      url: config.url,
      username: config.username,
      password: config.password,
      database: config.database,
    });
  }

  async ping(): Promise<boolean> {
    const result = await this.client.ping();
    return result.success;
  }

  async getLatestWatermark(pipelineName: string): Promise<EtlWatermark | null> {
    const resultSet = await this.client.query({
      query: `
        SELECT
          pipeline_name,
          toString(min_processed_date) AS min_processed_date,
          toString(max_processed_date) AS max_processed_date,
          records_loaded,
          toString(processed_at) AS processed_at,
          status
        FROM ${this.database}.etl_watermarks
        WHERE pipeline_name = {pipelineName:String}
          AND status = 'success'
        ORDER BY processed_at DESC
        LIMIT 1
      `,
      query_params: { pipelineName },
      format: 'JSONEachRow',
    });

    const rows = await resultSet.json<WatermarkQueryRow>();
    if (!rows.length) {
      return null;
    }

    const row = rows[0];
    return {
      pipelineName: row.pipeline_name,
      minProcessedDate: row.min_processed_date,
      maxProcessedDate: row.max_processed_date,
      recordsLoaded: Number(row.records_loaded),
      processedAt: row.processed_at,
      status: row.status,
    };
  }

  async getUserReportRows(
    username: string,
    fromDate: string,
    toDate: string,
    maxProcessedDate: string
  ): Promise<ReportMartRow[]> {
    const resultSet = await this.client.query({
      query: `
        SELECT
          m.keycloak_username,
          m.customer_id,
          m.customer_name,
          m.customer_email,
          m.country_code,
          m.prosthesis_id,
          m.serial_number,
          m.prosthesis_model,
          m.firmware_version,
          m.report_date,
          m.total_movements,
          m.avg_response_time_ms,
          m.max_response_time_ms,
          m.avg_battery_level,
          m.min_battery_level,
          m.avg_signal_noise_ratio,
          m.error_count,
          m.active_minutes
        FROM ${this.database}.user_reports_mart AS m FINAL
        WHERE m.keycloak_username = {username:String}
          AND m.report_date >= toDate({fromDate:String})
          AND m.report_date <= toDate({toDate:String})
          AND m.report_date <= toDate({maxProcessedDate:String})
        ORDER BY m.report_date DESC, m.prosthesis_id ASC
      `,
      query_params: {
        username,
        fromDate,
        toDate,
        maxProcessedDate,
      },
      format: 'JSONEachRow',
    });

    const rows = await resultSet.json<ReportMartRow>();
    return rows.map((row) => ({
      ...row,
      customer_id: Number(row.customer_id),
      prosthesis_id: Number(row.prosthesis_id),
      total_movements: Number(row.total_movements),
      avg_response_time_ms: Number(row.avg_response_time_ms),
      max_response_time_ms: Number(row.max_response_time_ms),
      avg_battery_level: Number(row.avg_battery_level),
      min_battery_level: Number(row.min_battery_level),
      avg_signal_noise_ratio: Number(row.avg_signal_noise_ratio),
      error_count: Number(row.error_count),
      active_minutes: Number(row.active_minutes),
    }));
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
