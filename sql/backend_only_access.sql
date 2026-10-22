-- Apply only AFTER the backend uses a server secret key locally AND on Render.
-- The Flask login remains the application access boundary; no direct browser DB access.
-- Existing service_role privileges remain untouched. No application rows are changed.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE public.servizi ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.servizi FROM PUBLIC, anon, authenticated;
ALTER TABLE public.appuntamenti ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.appuntamenti FROM PUBLIC, anon, authenticated;
ALTER TABLE public.appuntamenti_clienti ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.appuntamenti_clienti FROM PUBLIC, anon, authenticated;
ALTER TABLE public.clienti ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.clienti FROM PUBLIC, anon, authenticated;
ALTER TABLE public.pacchetti_cliente ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.pacchetti_cliente FROM PUBLIC, anon, authenticated;
ALTER TABLE public.pagamenti ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.pagamenti FROM PUBLIC, anon, authenticated;
ALTER TABLE public.tipi_pacchetto ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.tipi_pacchetto FROM PUBLIC, anon, authenticated;
COMMIT;
