import { createApp } from './app';
import { loadConfig } from './config';
import { createKeycloakTokenVerifier } from './middleware/auth';
import { ClickHouseReportRepository } from './services/clickhouse';

const config = loadConfig();

const repository = new ClickHouseReportRepository({
  url: config.clickhouseUrl,
  username: config.clickhouseUser,
  password: config.clickhousePassword,
  database: config.clickhouseDb,
});

const verifyToken = createKeycloakTokenVerifier(
  config.keycloakJwksUri,
  config.keycloakIssuers
);

const app = createApp({
  config,
  repository,
  verifyToken,
});

const server = app.listen(config.port, () => {
  console.log(
    `[Reports API] Listening on port ${config.port} (ClickHouse: ${config.clickhouseUrl}/${config.clickhouseDb})`
  );
});

async function shutdown(): Promise<void> {
  server.close();
  await repository.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
