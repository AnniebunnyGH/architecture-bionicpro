export interface AuthenticatedUser {
  sub: string;
  username: string;
  email?: string;
  roles: string[];
}

export interface EtlWatermark {
  pipelineName: string;
  minProcessedDate: string; // YYYY-MM-DD
  maxProcessedDate: string; // YYYY-MM-DD
  recordsLoaded: number;
  processedAt: string; // ISO / DateTime string
  status: string;
}

export interface ReportMartRow {
  keycloak_username: string;
  customer_id: number;
  customer_name: string;
  customer_email: string;
  country_code: string;
  prosthesis_id: number;
  serial_number: string;
  prosthesis_model: string;
  firmware_version: string;
  report_date: string;
  total_movements: number;
  avg_response_time_ms: number;
  max_response_time_ms: number;
  avg_battery_level: number;
  min_battery_level: number;
  avg_signal_noise_ratio: number;
  error_count: number;
  active_minutes: number;
}

export interface UserReportSummary {
  daysCount: number;
  prosthesesCount: number;
  totalMovements: number;
  avgResponseTimeMs: number;
  maxResponseTimeMs: number;
  avgBatteryLevel: number;
  minBatteryLevel: number;
  avgSignalNoiseRatio: number;
  totalErrors: number;
  totalActiveMinutes: number;
}

export interface UserReportResponse {
  generatedAt: string;
  user: {
    username: string;
    customerName: string | null;
    email: string | null;
    countryCode: string | null;
  };
  period: {
    from: string;
    to: string;
    airflowProcessedFrom: string;
    airflowProcessedTo: string;
    lastEtlRunAt: string;
  };
  summary: UserReportSummary;
  records: ReportMartRow[];
}

export interface ReportRepository {
  ping(): Promise<boolean>;
  getLatestWatermark(pipelineName: string): Promise<EtlWatermark | null>;
  getUserReportRows(
    username: string,
    fromDate: string,
    toDate: string,
    maxProcessedDate: string
  ): Promise<ReportMartRow[]>;
}
