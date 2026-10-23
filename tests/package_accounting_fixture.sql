CREATE TEMP TABLE clienti(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), nome text);
CREATE TEMP TABLE servizi(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), nome text);
CREATE TEMP TABLE tipi_pacchetto(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), nome text,
    servizio_id uuid REFERENCES servizi(id), numero_sedute integer NOT NULL);
CREATE TEMP TABLE pacchetti_cliente(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    cliente_id uuid REFERENCES clienti(id) ON DELETE CASCADE, tipo_pacchetto_id uuid REFERENCES tipi_pacchetto(id),
    sedute_effettuate integer DEFAULT 0, stato text DEFAULT 'attivo', data_attivazione timestamp DEFAULT now(),
    sedute_rimanenti integer, sedute_totali integer, data_scadenza date);
CREATE TEMP TABLE appuntamenti(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    cliente_id uuid REFERENCES clienti(id) ON DELETE CASCADE, servizio_id uuid REFERENCES servizi(id),
    pacchetto_cliente_id uuid REFERENCES pacchetti_cliente(id) ON DELETE SET NULL,
    start_datetime timestamp NOT NULL, end_datetime timestamp NOT NULL, stato text DEFAULT 'prenotato',
    note text, numero_seduta integer, scalato boolean DEFAULT false, email_conferme jsonb NOT NULL DEFAULT '{}');
CREATE TEMP TABLE appuntamenti_clienti(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    appuntamento_id uuid REFERENCES appuntamenti(id) ON DELETE CASCADE, cliente_id uuid REFERENCES clienti(id) ON DELETE CASCADE);
