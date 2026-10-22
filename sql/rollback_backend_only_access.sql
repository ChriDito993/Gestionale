-- EMERGENCY ONLY: restores the verified pre-hardening state and REOPENS PUBLIC ACCESS.
-- Prefer correcting the backend secret key instead. Never execute as routine setup.
BEGIN;
SET LOCAL lock_timeout = '5s';
GRANT ALL PRIVILEGES ON TABLE public.appuntamenti TO anon, authenticated;
ALTER TABLE public.appuntamenti DISABLE ROW LEVEL SECURITY;
GRANT ALL PRIVILEGES ON TABLE public.appuntamenti_clienti TO anon, authenticated;
ALTER TABLE public.appuntamenti_clienti DISABLE ROW LEVEL SECURITY;
GRANT ALL PRIVILEGES ON TABLE public.clienti TO anon, authenticated;
ALTER TABLE public.clienti DISABLE ROW LEVEL SECURITY;
GRANT ALL PRIVILEGES ON TABLE public.pacchetti_cliente TO anon, authenticated;
ALTER TABLE public.pacchetti_cliente DISABLE ROW LEVEL SECURITY;
GRANT ALL PRIVILEGES ON TABLE public.pagamenti TO anon, authenticated;
ALTER TABLE public.pagamenti DISABLE ROW LEVEL SECURITY;
GRANT ALL PRIVILEGES ON TABLE public.servizi TO anon, authenticated;
ALTER TABLE public.servizi DISABLE ROW LEVEL SECURITY;
GRANT ALL PRIVILEGES ON TABLE public.tipi_pacchetto TO anon, authenticated;
ALTER TABLE public.tipi_pacchetto DISABLE ROW LEVEL SECURITY;
COMMIT;
