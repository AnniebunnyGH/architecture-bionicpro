import cors from 'cors';
import express, { Express, NextFunction, Request, Response } from 'express';
import { AppConfig } from './config';
import { HttpError } from './errors';
import {
  createAuthMiddleware,
  requireRole,
  TokenVerifier,
} from './middleware/auth';
import { createReportsRouter } from './routes/reports';
import { ReportService } from './services/reportService';
import { ReportRepository } from './types/report';

export interface AppDependencies {
  config: AppConfig;
  repository: ReportRepository;
  verifyToken: TokenVerifier;
}

export function createApp(deps: AppDependencies): Express {
  const { config, repository, verifyToken } = deps;

  const app = express();

  app.use(
    cors({
      origin: config.corsOrigins,
      methods: ['GET', 'OPTIONS'],
      allowedHeaders: ['Authorization', 'Content-Type'],
      exposedHeaders: ['Content-Disposition'],
    })
  );
  app.use(express.json());

  app.get('/health', async (_req: Request, res: Response) => {
    try {
      const chAlive = await repository.ping();
      res.status(chAlive ? 200 : 503).json({
        status: chAlive ? 'ok' : 'degraded',
        clickhouse: chAlive ? 'connected' : 'unreachable',
      });
    } catch (err) {
      res.status(503).json({
        status: 'degraded',
        clickhouse: 'unreachable',
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  });

  const reportService = new ReportService(
    repository,
    config.airflowPipelineName
  );

  app.use(
    '/reports',
    createAuthMiddleware(verifyToken),
    requireRole(config.requiredReportRole),
    createReportsRouter(reportService)
  );

  // Centralized error handler
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.statusCode).json({
        error: err.name,
        message: err.message,
        ...(err.details || {}),
      });
      return;
    }

    console.error('[Reports API] Unexpected error:', err);
    res.status(500).json({
      error: 'InternalServerError',
      message: 'Failed to process report request',
    });
  });

  return app;
}
