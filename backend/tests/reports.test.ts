import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { AppConfig } from '../src/config';
import { TokenVerifier } from '../src/middleware/auth';
import {
  AuthenticatedUser,
  EtlWatermark,
  ReportMartRow,
  ReportRepository,
} from '../src/types/report';

const testConfig: AppConfig = {
  port: 8000,
  corsOrigins: ['http://localhost:3000'],
  keycloakJwksUri: 'http://localhost:8080/realms/reports-realm/protocol/openid-connect/certs',
  keycloakIssuers: ['http://localhost:8080/realms/reports-realm'],
  requiredReportRole: 'prothetic_user',
  clickhouseUrl: 'http://localhost:8123',
  clickhouseUser: 'default',
  clickhousePassword: '',
  clickhouseDb: 'bionicpro_olap',
  airflowPipelineName: 'prosthesis_reports_etl',
};

const sampleWatermark: EtlWatermark = {
  pipelineName: 'prosthesis_reports_etl',
  minProcessedDate: '2026-11-12',
  maxProcessedDate: '2026-11-21',
  recordsLoaded: 20,
  processedAt: '2026-11-22 00:05:00',
  status: 'success',
};

const sampleRows: ReportMartRow[] = [
  {
    keycloak_username: 'prothetic1',
    customer_id: 1,
    customer_name: 'Алексей Смирнов',
    customer_email: 'prothetic1@example.com',
    country_code: 'RU',
    prosthesis_id: 101,
    serial_number: 'BP-RU-2026-0001',
    prosthesis_model: 'BionicPRO Hand X1',
    firmware_version: 'v2.4.1',
    report_date: '2026-11-21',
    total_movements: 28,
    avg_response_time_ms: 61.5,
    max_response_time_ms: 85.0,
    avg_battery_level: 74.2,
    min_battery_level: 41.0,
    avg_signal_noise_ratio: 22.4,
    error_count: 1,
    active_minutes: 28,
  },
  {
    keycloak_username: 'prothetic2',
    customer_id: 2,
    customer_name: 'Мария Петрова',
    customer_email: 'prothetic2@example.com',
    country_code: 'RU',
    prosthesis_id: 103,
    serial_number: 'BP-RU-2026-0003',
    prosthesis_model: 'BionicPRO Arm Pro',
    firmware_version: 'v2.5.0',
    report_date: '2026-11-21',
    total_movements: 32,
    avg_response_time_ms: 58.0,
    max_response_time_ms: 79.0,
    avg_battery_level: 80.5,
    min_battery_level: 50.0,
    avg_signal_noise_ratio: 24.1,
    error_count: 0,
    active_minutes: 32,
  },
];

const tokenMap: Record<string, AuthenticatedUser> = {
  'token-prothetic1': {
    sub: 'sub-prothetic1',
    username: 'prothetic1',
    email: 'prothetic1@example.com',
    roles: ['prothetic_user'],
  },
  'token-regular-user': {
    sub: 'sub-user1',
    username: 'user1',
    email: 'user1@example.com',
    roles: ['user'],
  },
};

const mockVerifyToken: TokenVerifier = async (token: string) => {
  const user = tokenMap[token];
  if (!user) {
    throw new Error('Invalid token');
  }
  return user;
};

function buildTestApp(watermark: EtlWatermark | null = sampleWatermark) {
  const repository: ReportRepository = {
    ping: async () => true,
    getLatestWatermark: async () => watermark,
    getUserReportRows: async (username, fromDate, toDate, maxProcessedDate) =>
      sampleRows.filter(
        (r) =>
          r.keycloak_username === username &&
          r.report_date >= fromDate &&
          r.report_date <= toDate &&
          r.report_date <= maxProcessedDate
      ),
  };

  return createApp({
    config: testConfig,
    repository,
    verifyToken: mockVerifyToken,
  });
}

describe('Reports API security and OLAP period enforcement', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const app = buildTestApp();
    const res = await request(app).get('/reports');
    expect(res.status).toBe(401);
  });

  it('rejects users without prothetic_user role with 403', async () => {
    const app = buildTestApp();
    const res = await request(app)
      .get('/reports')
      .set('Authorization', 'Bearer token-regular-user');
    expect(res.status).toBe(403);
  });

  it('blocks accessing another user report via query param or path param (403)', async () => {
    const app = buildTestApp();

    const byQuery = await request(app)
      .get('/reports?username=prothetic2')
      .set('Authorization', 'Bearer token-prothetic1');
    expect(byQuery.status).toBe(403);

    const byPath = await request(app)
      .get('/reports/prothetic2')
      .set('Authorization', 'Bearer token-prothetic1');
    expect(byPath.status).toBe(403);
  });

  it('returns only the authenticated user report within the Airflow-processed period', async () => {
    const app = buildTestApp();
    const res = await request(app)
      .get('/reports?from=2026-11-12&to=2026-11-21')
      .set('Authorization', 'Bearer token-prothetic1');

    expect(res.status).toBe(200);
    expect(res.body.user.username).toBe('prothetic1');
    expect(res.body.records).toHaveLength(1);
    expect(res.body.records[0].keycloak_username).toBe('prothetic1');
    expect(res.body.summary.totalMovements).toBe(28);
  });

  it('returns CSV attachment when format=csv is requested', async () => {
    const app = buildTestApp();
    const res = await request(app)
      .get('/reports?from=2026-11-12&to=2026-11-21&format=csv')
      .set('Authorization', 'Bearer token-prothetic1');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text).toContain('BP-RU-2026-0001');
    expect(res.text).not.toContain('BP-RU-2026-0003');
  });

  it('rejects requests for periods not yet processed by Airflow with 422', async () => {
    const app = buildTestApp();
    const res = await request(app)
      .get('/reports?from=2026-11-12&to=2026-11-22')
      .set('Authorization', 'Bearer token-prothetic1');

    expect(res.status).toBe(422);
    expect(res.body.availablePeriod).toEqual({
      from: '2026-11-12',
      to: '2026-11-21',
      lastProcessedAt: '2026-11-22 00:05:00',
    });
  });

  it('returns 503 when Airflow has not processed any period yet', async () => {
    const app = buildTestApp(null);
    const res = await request(app)
      .get('/reports')
      .set('Authorization', 'Bearer token-prothetic1');

    expect(res.status).toBe(503);
  });
});
