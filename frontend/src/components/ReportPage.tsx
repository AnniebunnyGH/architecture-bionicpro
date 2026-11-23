import React, { useCallback, useEffect, useState } from 'react';
import { useKeycloak } from '@react-keycloak/web';

interface AvailablePeriod {
  from: string;
  to: string;
  lastProcessedAt: string;
  recordsLoaded?: number;
}

interface ReportMartRow {
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

interface UserReportResponse {
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
  summary: {
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
  };
  records: ReportMartRow[];
}

const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:8000';

const ReportPage: React.FC = () => {
  const { keycloak, initialized } = useKeycloak();
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [availablePeriod, setAvailablePeriod] = useState<AvailablePeriod | null>(null);
  const [fromDate, setFromDate] = useState<string>('');
  const [toDate, setToDate] = useState<string>('');
  const [report, setReport] = useState<UserReportResponse | null>(null);

  const getFreshToken = useCallback(async (): Promise<string> => {
    if (!keycloak?.authenticated || !keycloak.token) {
      throw new Error('Вы не аутентифицированы');
    }
    try {
      await keycloak.updateToken(30);
    } catch {
      throw new Error('Сессия истекла. Пожалуйста, войдите снова.');
    }
    if (!keycloak.token) {
      throw new Error('Не удалось получить токен доступа');
    }
    return keycloak.token;
  }, [keycloak]);

  useEffect(() => {
    if (!initialized || !keycloak.authenticated) {
      return;
    }

    let cancelled = false;
    const loadAvailablePeriod = async () => {
      try {
        const token = await getFreshToken();
        const response = await fetch(`${API_URL}/reports/period`, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });

        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          if (!cancelled) {
            setError(
              payload?.message ||
                `Не удалось получить доступный период отчётов (HTTP ${response.status})`
            );
          }
          return;
        }

        if (!cancelled && payload?.availablePeriod) {
          setAvailablePeriod(payload.availablePeriod);
          setFromDate((prev) => prev || payload.availablePeriod.from);
          setToDate((prev) => prev || payload.availablePeriod.to);
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error
              ? err.message
              : 'Ошибка при загрузке доступного периода'
          );
        }
      }
    };

    loadAvailablePeriod();
    return () => {
      cancelled = true;
    };
  }, [initialized, keycloak.authenticated, getFreshToken]);

  const buildQueryString = (format: 'json' | 'csv'): string => {
    const params = new URLSearchParams();
    if (fromDate) params.set('from', fromDate);
    if (toDate) params.set('to', toDate);
    params.set('format', format);
    return params.toString();
  };

  const fetchReport = async () => {
    try {
      setLoading(true);
      setError(null);

      const token = await getFreshToken();
      const response = await fetch(
        `${API_URL}/reports?${buildQueryString('json')}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );

      const data = await response.json().catch(() => null);
      if (!response.ok) {
        if (data?.availablePeriod) {
          setAvailablePeriod(data.availablePeriod);
        }
        throw new Error(
          data?.message || `Ошибка генерации отчёта (HTTP ${response.status})`
        );
      }

      setReport(data as UserReportResponse);
    } catch (err) {
      setReport(null);
      setError(err instanceof Error ? err.message : 'Произошла ошибка');
    } finally {
      setLoading(false);
    }
  };

  const downloadCsvReport = async () => {
    try {
      setDownloading(true);
      setError(null);

      const token = await getFreshToken();
      const response = await fetch(
        `${API_URL}/reports?${buildQueryString('csv')}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );

      if (!response.ok) {
        const data = await response.json().catch(() => null);
        if (data?.availablePeriod) {
          setAvailablePeriod(data.availablePeriod);
        }
        throw new Error(
          data?.message || `Ошибка скачивания отчёта (HTTP ${response.status})`
        );
      }

      const blob = await response.blob();
      const disposition = response.headers.get('Content-Disposition');
      const filenameMatch = disposition?.match(/filename="([^"]+)"/);
      const filename =
        filenameMatch?.[1] ||
        `bionicpro-report-${fromDate || 'all'}-${toDate || 'all'}.csv`;

      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка скачивания CSV');
    } finally {
      setDownloading(false);
    }
  };

  const downloadJsonReport = () => {
    if (!report) return;
    const blob = new Blob([JSON.stringify(report, null, 2)], {
      type: 'application/json',
    });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `bionicpro-report-${report.user.username}-${report.period.from}-to-${report.period.to}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.URL.revokeObjectURL(url);
  };

  if (!initialized) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-100">
        <div className="text-gray-600 text-lg">Загрузка аутентификации...</div>
      </div>
    );
  }

  if (!keycloak.authenticated) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-gray-100 p-4">
        <div className="p-8 bg-white rounded-lg shadow-md max-w-md w-full text-center">
          <h1 className="text-2xl font-bold text-gray-800 mb-2">
            BionicPRO — Отчёты протеза
          </h1>
          <p className="text-gray-600 mb-6 text-sm">
            Войдите через Keycloak (OAuth 2.0 Authorization Code + PKCE S256),
            чтобы получить отчёт о работе вашего протеза.
          </p>
          <button
            onClick={() => keycloak.login()}
            className="w-full px-4 py-2 bg-blue-600 text-white font-medium rounded hover:bg-blue-700 transition"
          >
            Войти (PKCE)
          </button>
        </div>
      </div>
    );
  }

  const username =
    (keycloak.tokenParsed?.preferred_username as string | undefined) || 'user';
  const roles =
    ((keycloak.tokenParsed?.realm_access as { roles?: string[] } | undefined)
      ?.roles || []);

  return (
    <div className="min-h-screen bg-gray-100 py-10 px-4">
      <div className="max-w-5xl mx-auto bg-white rounded-lg shadow-md p-6 md:p-8">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between border-b pb-4 mb-6 gap-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-800">
              BionicPRO — Отчёты по работе протеза
            </h1>
            <p className="text-sm text-gray-600 mt-1">
              Пользователь: <span className="font-semibold">{username}</span>
              {roles.length > 0 && (
                <span className="ml-2 text-xs bg-blue-50 text-blue-700 px-2 py-0.5 rounded">
                  {roles.join(', ')}
                </span>
              )}
            </p>
          </div>

          <button
            onClick={() =>
              keycloak.logout({ redirectUri: window.location.origin })
            }
            className="px-4 py-2 text-sm border border-gray-300 text-gray-700 rounded hover:bg-gray-50 transition self-start sm:self-auto"
          >
            Выйти
          </button>
        </div>

        {availablePeriod && (
          <div className="mb-6 p-4 bg-blue-50 border border-blue-200 rounded text-sm text-blue-900">
            <div>
              <strong>Доступный период (обработано Airflow):</strong>{' '}
              {availablePeriod.from} — {availablePeriod.to}
            </div>
            <div className="text-xs text-blue-700 mt-1">
              Последний успешный запуск ETL: {availablePeriod.lastProcessedAt}
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Дата начала (from)
            </label>
            <input
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Дата окончания (to)
            </label>
            <input
              type="date"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
            />
          </div>
        </div>

        <div className="flex flex-wrap gap-3 mb-6">
          <button
            onClick={fetchReport}
            disabled={loading}
            className={`px-5 py-2.5 bg-blue-600 text-white font-medium rounded hover:bg-blue-700 transition ${
              loading ? 'opacity-50 cursor-not-allowed' : ''
            }`}
          >
            {loading ? 'Генерация отчёта...' : 'Получить отчёт'}
          </button>

          <button
            onClick={downloadCsvReport}
            disabled={downloading}
            className={`px-5 py-2.5 bg-green-600 text-white font-medium rounded hover:bg-green-700 transition ${
              downloading ? 'opacity-50 cursor-not-allowed' : ''
            }`}
          >
            {downloading ? 'Скачивание...' : 'Скачать отчёт (CSV)'}
          </button>

          {report && (
            <button
              onClick={downloadJsonReport}
              className="px-5 py-2.5 bg-gray-700 text-white font-medium rounded hover:bg-gray-800 transition"
            >
              Скачать JSON
            </button>
          )}
        </div>

        {error && (
          <div className="mb-6 p-4 bg-red-50 border border-red-200 text-red-700 rounded text-sm">
            {error}
          </div>
        )}

        {report && (
          <div className="space-y-6">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="p-4 bg-gray-50 rounded border">
                <div className="text-xs text-gray-500">Всего движений</div>
                <div className="text-xl font-bold text-gray-800">
                  {report.summary.totalMovements}
                </div>
              </div>
              <div className="p-4 bg-gray-50 rounded border">
                <div className="text-xs text-gray-500">Средний отклик (мс)</div>
                <div className="text-xl font-bold text-gray-800">
                  {report.summary.avgResponseTimeMs}
                </div>
              </div>
              <div className="p-4 bg-gray-50 rounded border">
                <div className="text-xs text-gray-500">Средний заряд (%)</div>
                <div className="text-xl font-bold text-gray-800">
                  {report.summary.avgBatteryLevel}%
                </div>
              </div>
              <div className="p-4 bg-gray-50 rounded border">
                <div className="text-xs text-gray-500">Ошибок датчиков</div>
                <div className="text-xl font-bold text-gray-800">
                  {report.summary.totalErrors}
                </div>
              </div>
            </div>

            {report.records.length === 0 ? (
              <div className="p-4 bg-yellow-50 border border-yellow-200 text-yellow-800 rounded text-sm">
                За выбранный период данных по вашим протезам не найдено.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm border-collapse border border-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="border px-3 py-2 text-left">Дата</th>
                      <th className="border px-3 py-2 text-left">Протез</th>
                      <th className="border px-3 py-2 text-left">Серийный №</th>
                      <th className="border px-3 py-2 text-right">Движений</th>
                      <th className="border px-3 py-2 text-right">Отклик (мс)</th>
                      <th className="border px-3 py-2 text-right">Заряд (%)</th>
                      <th className="border px-3 py-2 text-right">SNR</th>
                      <th className="border px-3 py-2 text-right">Ошибки</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.records.map((row) => (
                      <tr
                        key={`${row.report_date}-${row.prosthesis_id}`}
                        className="hover:bg-gray-50"
                      >
                        <td className="border px-3 py-2">{row.report_date}</td>
                        <td className="border px-3 py-2">
                          {row.prosthesis_model}
                        </td>
                        <td className="border px-3 py-2 font-mono text-xs">
                          {row.serial_number}
                        </td>
                        <td className="border px-3 py-2 text-right">
                          {row.total_movements}
                        </td>
                        <td className="border px-3 py-2 text-right">
                          {row.avg_response_time_ms}
                        </td>
                        <td className="border px-3 py-2 text-right">
                          {row.avg_battery_level}
                        </td>
                        <td className="border px-3 py-2 text-right">
                          {row.avg_signal_noise_ratio}
                        </td>
                        <td className="border px-3 py-2 text-right">
                          {row.error_count}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default ReportPage;
