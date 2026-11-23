import 'dotenv/config';

export interface AppConfig {
  port: number;
  corsOrigins: string[];
  keycloakJwksUri: string;
  keycloakIssuers: string[];
  requiredReportRole: string;
  clickhouseUrl: string;
  clickhouseUser: string;
  clickhousePassword: string;
  clickhouseDb: string;
  airflowPipelineName: string;
}

export function loadConfig(): AppConfig {
  const issuersRaw =
    process.env.KEYCLOAK_ISSUERS ||
    'http://localhost:8080/realms/reports-realm,http://keycloak:8080/realms/reports-realm';

  const corsRaw = process.env.CORS_ORIGINS || 'http://localhost:3000';

  return {
    port: Number(process.env.PORT || 8000),
    corsOrigins: corsRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    keycloakJwksUri:
      process.env.KEYCLOAK_JWKS_URI ||
      'http://keycloak:8080/realms/reports-realm/protocol/openid-connect/certs',
    keycloakIssuers: issuersRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    requiredReportRole: process.env.REQUIRED_REPORT_ROLE || 'prothetic_user',
    clickhouseUrl: process.env.CLICKHOUSE_URL || 'http://clickhouse:8123',
    clickhouseUser: process.env.CLICKHOUSE_USER || 'default',
    clickhousePassword: process.env.CLICKHOUSE_PASSWORD || 'clickhouse_pass',
    clickhouseDb: process.env.CLICKHOUSE_DB || 'bionicpro_olap',
    airflowPipelineName:
      process.env.AIRFLOW_PIPELINE_NAME || 'prosthesis_reports_etl',
  };
}
