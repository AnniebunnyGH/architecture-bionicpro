-- CRM database schema and seed data for BionicPRO

CREATE TABLE IF NOT EXISTS customers (
    id SERIAL PRIMARY KEY,
    keycloak_username VARCHAR(128) NOT NULL UNIQUE,
    full_name VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL,
    country_code VARCHAR(8) NOT NULL DEFAULT 'RU',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS prostheses (
    id SERIAL PRIMARY KEY,
    customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    serial_number VARCHAR(64) NOT NULL UNIQUE,
    model_name VARCHAR(128) NOT NULL,
    firmware_version VARCHAR(32) NOT NULL,
    issued_date DATE NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'active'
);

INSERT INTO customers (id, keycloak_username, full_name, email, country_code) VALUES
    (1, 'prothetic1', 'Алексей Смирнов', 'prothetic1@example.com', 'RU'),
    (2, 'prothetic2', 'Мария Петрова', 'prothetic2@example.com', 'RU'),
    (3, 'prothetic3', 'Иван Козлов', 'prothetic3@example.com', 'EU')
ON CONFLICT (keycloak_username) DO NOTHING;

INSERT INTO prostheses (id, customer_id, serial_number, model_name, firmware_version, issued_date, status) VALUES
    (101, 1, 'BP-RU-2026-0001', 'BionicPRO Hand X1', 'v2.4.1', CURRENT_DATE - INTERVAL '120 days', 'active'),
    (102, 1, 'BP-RU-2026-0002', 'BionicPRO Grip Sport', 'v2.4.1', CURRENT_DATE - INTERVAL '45 days', 'active'),
    (103, 2, 'BP-RU-2026-0003', 'BionicPRO Arm Pro', 'v2.5.0', CURRENT_DATE - INTERVAL '90 days', 'active'),
    (104, 3, 'BP-EU-2026-0004', 'BionicPRO Hand X2', 'v2.5.2', CURRENT_DATE - INTERVAL '60 days', 'active')
ON CONFLICT (serial_number) DO NOTHING;
