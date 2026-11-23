# BionicPRO — Архитектура безопасности и сервис отчётов (Спринт 9)

Полное описание исходного задания вынесено в [TASK.md](./TASK.md).

---

## Задание 1. Повышение безопасности системы

### Задача 1. Архитектура управления учётными данными (C4)
- **Диаграмма:** [diagrams/task1_security_c4.drawio](./diagrams/task1_security_c4.drawio) (подробное пояснение — [diagrams/README.md](./diagrams/README.md)).
- **Унификация доступа и локальное хранение ПДн/медданных:** единый SSO на базе **Keycloak** + **LDAP User Federation (LDAPS)** к региональным каталогам в контурах стран присутствия (РФ / 152-ФЗ, ЕС / GDPR). Персональные и медицинские данные остаются в стране представительства без репликации в центральную БД; телеметрия привязана к обезличенному `sub`/UUID.
- **Безопасная работа с токенами без передачи на фронтенд:** между клиентскими приложениями и Keycloak / API внедрён **BFF (Auth Gateway)** + **Redis Session Store**. BFF выполняет OAuth 2.0 Authorization Code + PKCE (`S256`), хранит `access_token` и `refresh_token` исключительно на сервере, а клиенту выдаёт только `HttpOnly; Secure; SameSite=Strict` session cookie.
- **Внешние удостоверяющие службы разных стран:** **Identity Brokering (OIDC / SAML 2.0)** в Keycloak (Яндекс ID / ЕСИА в РФ, Google / eIDAS и региональные IdP в других странах).

### Задача 2. Переход на PKCE (`S256`) в Keycloak и Frontend
- **Keycloak ([keycloak/realm-export.json](./keycloak/realm-export.json)):** для клиента `reports-frontend` включён обязательный `pkce.code.challenge.method: S256`, `standardFlowEnabled: true`, отключены `implicitFlowEnabled` и `directAccessGrantsEnabled`.
- **Frontend ([frontend/src/App.tsx](./frontend/src/App.tsx)):** настроены `initOptions` с `pkceMethod: 'S256'` для `keycloak-js`.

---

## Задание 2. Разработка сервиса отчётов

### Задача 1. Архитектура подготовки и выдачи отчётов (C4)
- **Диаграмма:** [diagrams/task2_reports_c4.drawio](./diagrams/task2_reports_c4.drawio).
- Разделение нагрузок: операционные данные (`CRM DB` и `Telemetry DB` на PostgreSQL) перекладываются по расписанию через **Apache Airflow** в колоночную OLAP-БД **ClickHouse**, из которой **Reports API** читает готовую предрассчитанную витрину.

### Задача 2. Apache Airflow ETL и витрина в ClickHouse
- **Код Airflow:** [airflow/dags/prosthesis_reports_etl.py](./airflow/dags/prosthesis_reports_etl.py), [airflow/Dockerfile](./airflow/Dockerfile), [airflow/requirements.txt](./airflow/requirements.txt).
- **Расписание:** `0 * * * *` (каждый час, `catchup=False`, `max_active_runs=1`). При первом старте `docker compose` выполняется первичный прогон (`airflow_init`).
- **Витрина OLAP ([db-init/clickhouse/init.sql](./db-init/clickhouse/init.sql)):**
  - `bionicpro_olap.user_reports_mart` (`ReplacingMergeTree(updated_at)`, `PARTITION BY toYYYYMM(report_date)`, `ORDER BY (keycloak_username, report_date, prosthesis_id)`) — объединяет данные клиентов/протезов из CRM и агрегированную дневную телеметрию (движения, время отклика, заряд, SNR, ошибки, активные минуты), обеспечивая быстрый поиск по пользователю без тяжёлых вычислений в реальном времени.
  - `bionicpro_olap.etl_watermarks` — фиксирует границы успешно обработанного Airflow периода (`min_processed_date`, `max_processed_date`).
- **Тестовые данные источников:** [db-init/crm/init.sql](./db-init/crm/init.sql) и [db-init/telemetry/init.sql](./db-init/telemetry/init.sql).

### Задачи 3 и 4. Reports API (TypeScript) и контроль доступа
- **Код бэкенда:** [backend/](./backend) (Node.js, TypeScript, Express, `@clickhouse/client`, `jose`).
- **Эндпоинты:**
  - `GET /health` — проверка доступности сервиса и ClickHouse.
  - `GET /reports/period` — доступный период данных, уже обработанный Airflow.
  - `GET /reports` (поддержка `?from=YYYY-MM-DD&to=YYYY-MM-DD&format=json|csv`) — получение/скачивание отчёта из `user_reports_mart`.
  - `GET /reports/:username` — разрешён только для самого себя.
- **Безопасность и валидация:**
  - Проверка подписи JWT через JWKS Keycloak (`401 Unauthorized` без валидного токена).
  - RBAC: требуется роль `prothetic_user` (`403 Forbidden` для остальных ролей).
  - Строгая изоляция по пользователю: владелец извлекается из токена (`preferred_username`); попытка запросить чужой отчёт (`/reports/prothetic2` или `?username=prothetic2`) возвращает `403 Forbidden`.
  - Контроль обработанного Airflow периода: запрос дат вне окна из `etl_watermarks` отклоняется с `422 PeriodNotProcessedError` и возвратом `availablePeriod`.
- **Автотесты:** [backend/tests/reports.test.ts](./backend/tests/reports.test.ts) (`npm test` в папке `backend/`).

### Задача 5. Обновление UI
- **Код UI:** [frontend/src/components/ReportPage.tsx](./frontend/src/components/ReportPage.tsx).
- Отображение доступного периода Airflow, выбор диапазона дат, кнопки **«Получить отчёт»**, **«Скачать отчёт (CSV)»** и **«Скачать JSON»**, сводка метрик, таблица по протезам и понятная обработка ошибок (`401`/`403`/`422`).

---

## Быстрый запуск и проверка

```bash
docker compose up -d --build
```

| Сервис | URL | Учётные данные для проверки |
|---|---|---|
| **Frontend (UI отчётов)** | http://localhost:3000 | `prothetic1` / `prothetic123` (есть доступ к отчётам)<br>`prothetic2` / `prothetic123` (только свои отчёты)<br>`user1` / `password123` (нет роли `prothetic_user` → `403`) |
| **Reports API** | http://localhost:8000/health | Bearer JWT от Keycloak |
| **Keycloak** | http://localhost:8080 | `admin` / `admin` |
| **Apache Airflow UI** | http://localhost:8081 | `airflow` / `airflow` |
| **ClickHouse HTTP** | http://localhost:8123 | `default` / `clickhouse_pass` |

Запуск модульных/API-тестов бэкенда:

```bash
cd backend
npm install
npm test
```
