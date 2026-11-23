import {
  BadRequestError,
  ForbiddenError,
  PeriodNotProcessedError,
  ServiceUnavailableError,
} from '../errors';
import {
  AuthenticatedUser,
  EtlWatermark,
  ReportMartRow,
  ReportRepository,
  UserReportResponse,
  UserReportSummary,
} from '../types/report';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE_RE.test(value)) {
    return false;
  }
  const [y, m, d] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(y, m - 1, d));
  return (
    parsed.getUTCFullYear() === y &&
    parsed.getUTCMonth() === m - 1 &&
    parsed.getUTCDate() === d
  );
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function computeSummary(records: ReportMartRow[]): UserReportSummary {
  if (records.length === 0) {
    return {
      daysCount: 0,
      prosthesesCount: 0,
      totalMovements: 0,
      avgResponseTimeMs: 0,
      maxResponseTimeMs: 0,
      avgBatteryLevel: 0,
      minBatteryLevel: 0,
      avgSignalNoiseRatio: 0,
      totalErrors: 0,
      totalActiveMinutes: 0,
    };
  }

  const distinctDays = new Set<string>();
  const distinctProstheses = new Set<number>();

  let totalMovements = 0;
  let weightedResponseTimeSum = 0;
  let maxResponseTimeMs = 0;
  let batterySum = 0;
  let minBatteryLevel = Number.POSITIVE_INFINITY;
  let snrSum = 0;
  let totalErrors = 0;
  let totalActiveMinutes = 0;

  for (const row of records) {
    distinctDays.add(row.report_date);
    distinctProstheses.add(row.prosthesis_id);

    totalMovements += row.total_movements;
    weightedResponseTimeSum += row.avg_response_time_ms * row.total_movements;
    if (row.max_response_time_ms > maxResponseTimeMs) {
      maxResponseTimeMs = row.max_response_time_ms;
    }
    batterySum += row.avg_battery_level;
    if (row.min_battery_level < minBatteryLevel) {
      minBatteryLevel = row.min_battery_level;
    }
    snrSum += row.avg_signal_noise_ratio;
    totalErrors += row.error_count;
    totalActiveMinutes += row.active_minutes;
  }

  return {
    daysCount: distinctDays.size,
    prosthesesCount: distinctProstheses.size,
    totalMovements,
    avgResponseTimeMs:
      totalMovements > 0 ? round2(weightedResponseTimeSum / totalMovements) : 0,
    maxResponseTimeMs: round2(maxResponseTimeMs),
    avgBatteryLevel: round2(batterySum / records.length),
    minBatteryLevel:
      minBatteryLevel === Number.POSITIVE_INFINITY ? 0 : round2(minBatteryLevel),
    avgSignalNoiseRatio: round2(snrSum / records.length),
    totalErrors,
    totalActiveMinutes,
  };
}

export interface GetReportInput {
  user: AuthenticatedUser;
  requestedTargetUser?: string;
  from?: string;
  to?: string;
}

export class ReportService {
  constructor(
    private readonly repository: ReportRepository,
    private readonly pipelineName: string
  ) {}

  async getAvailablePeriod(): Promise<EtlWatermark> {
    const watermark = await this.repository.getLatestWatermark(
      this.pipelineName
    );
    if (!watermark) {
      throw new ServiceUnavailableError(
        'Report data is not yet available. Scheduled Airflow ETL has not completed yet.'
      );
    }
    return watermark;
  }

  async getUserReport(input: GetReportInput): Promise<UserReportResponse> {
    const { user, requestedTargetUser, from, to } = input;

    // Strict own-report-only authorization guard (prevents IDOR)
    if (
      requestedTargetUser &&
      requestedTargetUser !== user.username &&
      requestedTargetUser !== user.sub
    ) {
      throw new ForbiddenError(
        'Access denied: you can only request reports for your own account.'
      );
    }

    if (from && !isValidIsoDate(from)) {
      throw new BadRequestError(
        "Invalid 'from' date parameter. Expected format: YYYY-MM-DD."
      );
    }
    if (to && !isValidIsoDate(to)) {
      throw new BadRequestError(
        "Invalid 'to' date parameter. Expected format: YYYY-MM-DD."
      );
    }

    // Verify Airflow has already processed data into ClickHouse OLAP
    const watermark = await this.getAvailablePeriod();

    const effectiveFrom = from || watermark.minProcessedDate;
    const effectiveTo = to || watermark.maxProcessedDate;

    if (effectiveFrom > effectiveTo) {
      throw new BadRequestError(
        "Invalid date range: 'from' date must be less than or equal to 'to' date."
      );
    }

    // Prevent generating reports for periods not yet processed by Airflow
    if (
      effectiveTo > watermark.maxProcessedDate ||
      effectiveFrom < watermark.minProcessedDate
    ) {
      throw new PeriodNotProcessedError(
        `Requested period (${effectiveFrom} to ${effectiveTo}) is outside the data already processed by Airflow (${watermark.minProcessedDate} to ${watermark.maxProcessedDate}).`,
        {
          availablePeriod: {
            from: watermark.minProcessedDate,
            to: watermark.maxProcessedDate,
            lastProcessedAt: watermark.processedAt,
          },
        }
      );
    }

    const records = await this.repository.getUserReportRows(
      user.username,
      effectiveFrom,
      effectiveTo,
      watermark.maxProcessedDate
    );

    const firstRow = records[0];
    return {
      generatedAt: new Date().toISOString(),
      user: {
        username: user.username,
        customerName: firstRow?.customer_name ?? null,
        email: firstRow?.customer_email ?? user.email ?? null,
        countryCode: firstRow?.country_code ?? null,
      },
      period: {
        from: effectiveFrom,
        to: effectiveTo,
        airflowProcessedFrom: watermark.minProcessedDate,
        airflowProcessedTo: watermark.maxProcessedDate,
        lastEtlRunAt: watermark.processedAt,
      },
      summary: computeSummary(records),
      records,
    };
  }
}

function csvEscape(value: string | number | null | undefined): string {
  const str = value === null || value === undefined ? '' : String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function formatReportAsCsv(report: UserReportResponse): string {
  const header = [
    'report_date',
    'keycloak_username',
    'customer_name',
    'prosthesis_id',
    'serial_number',
    'prosthesis_model',
    'firmware_version',
    'total_movements',
    'avg_response_time_ms',
    'max_response_time_ms',
    'avg_battery_level',
    'min_battery_level',
    'avg_signal_noise_ratio',
    'error_count',
    'active_minutes',
  ].join(',');

  const lines = report.records.map((r) =>
    [
      r.report_date,
      r.keycloak_username,
      r.customer_name,
      r.prosthesis_id,
      r.serial_number,
      r.prosthesis_model,
      r.firmware_version,
      r.total_movements,
      r.avg_response_time_ms,
      r.max_response_time_ms,
      r.avg_battery_level,
      r.min_battery_level,
      r.avg_signal_noise_ratio,
      r.error_count,
      r.active_minutes,
    ]
      .map(csvEscape)
      .join(',')
  );

  return [header, ...lines].join('\n');
}
