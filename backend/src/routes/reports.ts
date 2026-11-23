import { NextFunction, Request, Response, Router } from 'express';
import { BadRequestError } from '../errors';
import { formatReportAsCsv, ReportService } from '../services/reportService';

function getSingleQueryParam(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return undefined;
}

export function createReportsRouter(reportService: ReportService): Router {
  const router = Router();

  /**
   * GET /reports/period
   * Returns the latest date window already processed by the Airflow ETL pipeline.
   */
  router.get(
    '/period',
    async (_req: Request, res: Response, next: NextFunction) => {
      try {
        const watermark = await reportService.getAvailablePeriod();
        res.json({
          pipelineName: watermark.pipelineName,
          availablePeriod: {
            from: watermark.minProcessedDate,
            to: watermark.maxProcessedDate,
            lastProcessedAt: watermark.processedAt,
            recordsLoaded: watermark.recordsLoaded,
          },
        });
      } catch (err) {
        next(err);
      }
    }
  );

  const handleReportRequest = async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({
          error: 'Unauthorized',
          message: 'Authentication required',
        });
        return;
      }

      const pathUser =
        typeof req.params.username === 'string' && req.params.username.trim()
          ? req.params.username.trim()
          : undefined;
      const queryUser =
        getSingleQueryParam(req.query.username) ||
        getSingleQueryParam(req.query.user_id);

      const requestedTargetUser = pathUser || queryUser;
      const from = getSingleQueryParam(req.query.from);
      const to = getSingleQueryParam(req.query.to);
      const format = (getSingleQueryParam(req.query.format) || 'json').toLowerCase();

      if (format !== 'json' && format !== 'csv') {
        throw new BadRequestError(
          "Unsupported 'format' parameter. Allowed values: 'json', 'csv'."
        );
      }

      const report = await reportService.getUserReport({
        user: req.user,
        requestedTargetUser,
        from,
        to,
      });

      if (format === 'csv') {
        const csv = formatReportAsCsv(report);
        const filename = `bionicpro-report-${report.user.username}-${report.period.from}-to-${report.period.to}.csv`;
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${filename}"`
        );
        res.status(200).send(csv);
        return;
      }

      res.status(200).json(report);
    } catch (err) {
      next(err);
    }
  };

  /**
   * GET /reports
   * Returns pre-aggregated OLAP report strictly for the authenticated user.
   */
  router.get('/', handleReportRequest);

  /**
   * GET /reports/:username
   * Allowed ONLY when :username matches the authenticated user; otherwise 403 Forbidden.
   */
  router.get('/:username', handleReportRequest);

  return router;
}
