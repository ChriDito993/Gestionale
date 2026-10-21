-- Additive: preserves all existing appointments and their permissions.
ALTER TABLE public.appuntamenti
    ADD COLUMN IF NOT EXISTS email_conferme jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.appuntamenti.email_conferme IS
    'Latest confirmation outcome per client ID; no credentials, message bodies or email addresses.';
