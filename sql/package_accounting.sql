-- Additive installation: old application code keeps working until the new deploy.
-- All mutations below are SECURITY INVOKER and callable only by the backend.
SET LOCAL lock_timeout = '5s';
CREATE SCHEMA IF NOT EXISTS gestionale_internal;
REVOKE ALL ON SCHEMA gestionale_internal FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA gestionale_internal TO service_role;

DO $init$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema = 'public' AND table_name = 'pacchetti_cliente'
                   AND column_name = 'chiusura_manuale') THEN
        ALTER TABLE public.pacchetti_cliente ADD COLUMN chiusura_manuale boolean NOT NULL DEFAULT false;
        -- Legacy closed-but-not-full packages are conservatively kept manually closed.
        UPDATE public.pacchetti_cliente p SET chiusura_manuale = true
        FROM public.tipi_pacchetto t WHERE t.id = p.tipo_pacchetto_id
        AND p.stato = 'chiuso' AND coalesce(p.sedute_effettuate, 0) < t.numero_sedute;
    END IF;
END $init$;

CREATE OR REPLACE FUNCTION gestionale_internal.sync_package(p_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $fn$
DECLARE p record; used integer;
BEGIN
    SELECT pc.*, t.numero_sedute, t.servizio_id INTO p FROM public.pacchetti_cliente pc
    JOIN public.tipi_pacchetto t ON t.id = pc.tipo_pacchetto_id WHERE pc.id = p_id;
    IF NOT FOUND THEN RETURN; END IF;
    IF p.numero_sedute <= 0 THEN RAISE EXCEPTION USING MESSAGE = 'invalid_package'; END IF;

    -- Invalid links cannot consume a session. Keep cancellations linked for history.
    UPDATE public.appuntamenti a SET pacchetto_cliente_id = NULL, scalato = false, numero_seduta = NULL
    WHERE a.pacchetto_cliente_id = p_id AND
        (a.servizio_id IS DISTINCT FROM p.servizio_id OR a.stato = 'occupato' OR NOT
         (coalesce(a.cliente_id = p.cliente_id, false) OR EXISTS (SELECT 1 FROM public.appuntamenti_clienti ac
           WHERE ac.appuntamento_id = a.id AND ac.cliente_id = p.cliente_id)));
    UPDATE public.appuntamenti SET scalato = false, numero_seduta = NULL
    WHERE pacchetto_cliente_id = p_id AND stato = 'annullato';
    SELECT count(*)::integer INTO used FROM public.appuntamenti
    WHERE pacchetto_cliente_id = p_id AND coalesce(stato, 'prenotato') NOT IN ('annullato', 'occupato');
    IF used > p.numero_sedute THEN RAISE EXCEPTION USING MESSAGE = 'package_capacity'; END IF;
    WITH numbered AS (
        SELECT id, row_number() OVER (ORDER BY start_datetime, end_datetime, id)::integer AS n
        FROM public.appuntamenti WHERE pacchetto_cliente_id = p_id
        AND coalesce(stato, 'prenotato') NOT IN ('annullato', 'occupato')
    ) UPDATE public.appuntamenti a SET numero_seduta = n.n, scalato = true
      FROM numbered n WHERE a.id = n.id AND
      (a.numero_seduta IS DISTINCT FROM n.n OR a.scalato IS DISTINCT FROM true);
    UPDATE public.pacchetti_cliente SET sedute_effettuate = used, sedute_totali = p.numero_sedute,
        sedute_rimanenti = greatest(0, p.numero_sedute - used),
        stato = CASE WHEN p.chiusura_manuale OR used >= p.numero_sedute
                     OR p.data_scadenza < (current_timestamp AT TIME ZONE 'Europe/Rome')::date
                     THEN 'chiuso' ELSE 'attivo' END
    WHERE id = p_id;
END $fn$;

CREATE OR REPLACE FUNCTION gestionale_internal.sync_scope(p_clients uuid[], p_services uuid[], p_fill boolean DEFAULT true)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $fn$
DECLARE p record;
BEGIN
    FOR p IN SELECT pc.id FROM public.pacchetti_cliente pc
        JOIN public.tipi_pacchetto t ON t.id = pc.tipo_pacchetto_id
        WHERE pc.cliente_id = ANY(p_clients) AND t.servizio_id = ANY(p_services)
        ORDER BY pc.data_attivazione NULLS FIRST, pc.id
    LOOP PERFORM gestionale_internal.sync_package(p.id); END LOOP;
    IF NOT p_fill THEN RETURN; END IF;
    FOR p IN SELECT pc.*, t.numero_sedute, t.servizio_id FROM public.pacchetti_cliente pc
        JOIN public.tipi_pacchetto t ON t.id = pc.tipo_pacchetto_id
        WHERE pc.cliente_id = ANY(p_clients) AND t.servizio_id = ANY(p_services)
        AND pc.stato = 'attivo' AND NOT pc.chiusura_manuale
        ORDER BY pc.data_attivazione NULLS FIRST, pc.id
    LOOP
        -- Only future, uncovered appointments; never transfer another package's sessions.
        WITH candidates AS (
            SELECT a.id FROM public.appuntamenti a WHERE a.pacchetto_cliente_id IS NULL
            AND a.servizio_id = p.servizio_id
            AND a.start_datetime >= current_timestamp AT TIME ZONE 'Europe/Rome'
            AND (p.data_scadenza IS NULL OR a.start_datetime::date <= p.data_scadenza)
            AND coalesce(a.stato, 'prenotato') NOT IN ('annullato', 'occupato')
            AND (a.cliente_id = p.cliente_id OR EXISTS (SELECT 1 FROM public.appuntamenti_clienti ac
                 WHERE ac.appuntamento_id = a.id AND ac.cliente_id = p.cliente_id))
            ORDER BY a.start_datetime, a.end_datetime, a.id
            LIMIT greatest(0, p.numero_sedute - p.sedute_effettuate)
        ) UPDATE public.appuntamenti a SET pacchetto_cliente_id = p.id FROM candidates c WHERE a.id = c.id;
        PERFORM gestionale_internal.sync_package(p.id);
    END LOOP;
END $fn$;

CREATE OR REPLACE FUNCTION public.gestionale_package_operation(p_action text, p_data jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $fn$
DECLARE
    ids uuid[]; services uuid[]; client uuid; service uuid; package uuid; requested uuid;
    row_id uuid; created uuid[] := '{}'; slot jsonb; changes jsonb; old public.appuntamenti%ROWTYPE;
    updated public.appuntamenti%ROWTYPE; pk record; result jsonb; occupied boolean;
BEGIN
    -- Shared transaction lock acquired BEFORE reads/writes, released on commit/rollback.
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('gestionale_package_accounting_v1', 0));
    IF p_action = 'create' THEN
        ids := ARRAY(SELECT value::uuid FROM jsonb_array_elements_text(p_data->'clienti_ids') WITH ORDINALITY v(value, ord)
                     GROUP BY value ORDER BY min(ord));
        occupied := coalesce((p_data->>'occupato')::boolean, false);
        service := (p_data->>'servizio_id')::uuid;
        requested := nullif(p_data->>'pacchetto_cliente_id', '')::uuid;
        IF occupied THEN ids := '{}'; requested := NULL; END IF;
        IF (NOT occupied AND cardinality(ids) NOT BETWEEN 1 AND 2) OR service IS NULL
           OR jsonb_typeof(p_data->'slots') IS DISTINCT FROM 'array'
           OR jsonb_array_length(p_data->'slots') NOT BETWEEN 1 AND 80 THEN
            RAISE EXCEPTION USING MESSAGE = 'invalid_booking';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM public.servizi WHERE id = service)
           OR EXISTS (SELECT 1 FROM unnest(ids) x WHERE NOT EXISTS (SELECT 1 FROM public.clienti WHERE id = x)) THEN
            RAISE EXCEPTION USING MESSAGE = 'invalid_booking';
        END IF;
        PERFORM gestionale_internal.sync_scope(ids, ARRAY[service]);
        IF requested IS NOT NULL THEN
            SELECT pc.*, t.servizio_id, t.numero_sedute INTO pk FROM public.pacchetti_cliente pc
            JOIN public.tipi_pacchetto t ON t.id = pc.tipo_pacchetto_id WHERE pc.id = requested;
            IF NOT FOUND OR NOT (pk.cliente_id = ANY(ids)) OR pk.servizio_id IS DISTINCT FROM service THEN
                RAISE EXCEPTION USING MESSAGE = 'invalid_package';
            END IF;
            IF pk.chiusura_manuale OR pk.stato <> 'attivo' THEN RAISE EXCEPTION USING MESSAGE = 'package_closed'; END IF;
            IF pk.sedute_effettuate + jsonb_array_length(p_data->'slots') > pk.numero_sedute THEN
                RAISE EXCEPTION USING MESSAGE = 'package_capacity';
            END IF;
        END IF;
        FOR slot IN SELECT value FROM jsonb_array_elements(p_data->'slots') LOOP
            IF (slot->>'end_datetime')::timestamp <= (slot->>'start_datetime')::timestamp
               OR slot->>'start_datetime' IS NULL OR slot->>'end_datetime' IS NULL THEN
                RAISE EXCEPTION USING MESSAGE = 'invalid_booking';
            END IF;
            package := requested;
            IF requested IS NOT NULL THEN
                IF pk.data_scadenza IS NOT NULL AND (slot->>'start_datetime')::timestamp::date > pk.data_scadenza THEN
                    RAISE EXCEPTION USING MESSAGE = 'package_expired';
                END IF;
            END IF;
            IF requested IS NULL AND NOT occupied THEN
                SELECT pc.id INTO package FROM public.pacchetti_cliente pc
                JOIN public.tipi_pacchetto t ON t.id = pc.tipo_pacchetto_id
                WHERE pc.cliente_id = ANY(ids) AND t.servizio_id = service AND NOT pc.chiusura_manuale
                AND pc.stato = 'attivo' AND (pc.data_scadenza IS NULL OR (slot->>'start_datetime')::timestamp::date <= pc.data_scadenza)
                AND (pc.data_attivazione IS NULL OR (slot->>'start_datetime')::timestamp >= pc.data_attivazione)
                AND (SELECT count(*) FROM public.appuntamenti a WHERE a.pacchetto_cliente_id = pc.id
                     AND coalesce(a.stato, 'prenotato') NOT IN ('annullato', 'occupato')) < t.numero_sedute
                ORDER BY array_position(ids, pc.cliente_id), pc.data_attivazione NULLS FIRST, pc.id LIMIT 1;
            END IF;
            INSERT INTO public.appuntamenti(cliente_id,servizio_id,start_datetime,end_datetime,pacchetto_cliente_id,
                                          scalato,stato,note,email_conferme)
            VALUES(ids[1],service,(slot->>'start_datetime')::timestamp,(slot->>'end_datetime')::timestamp,package,
                   package IS NOT NULL,CASE WHEN occupied THEN 'occupato' ELSE 'prenotato' END,
                   nullif(p_data->>'note',''),coalesce((SELECT jsonb_object_agg(x::text,jsonb_build_object('status',
                       CASE WHEN coalesce((p_data->>'invia_conferma_email')::boolean,false) THEN 'pending' ELSE 'not_requested' END))
                       FROM unnest(ids) x),'{}'::jsonb)) RETURNING id INTO row_id;
            INSERT INTO public.appuntamenti_clienti(appuntamento_id,cliente_id) SELECT row_id,x FROM unnest(ids) x;
            created := array_append(created,row_id);
        END LOOP;
        PERFORM gestionale_internal.sync_scope(ids, ARRAY[service]);
        SELECT jsonb_agg(to_jsonb(a) ORDER BY a.start_datetime,a.id) INTO result
        FROM public.appuntamenti a WHERE a.id = ANY(created);
        RETURN jsonb_build_object('appuntamenti',result,'uncovered_count',
            CASE WHEN EXISTS (SELECT 1 FROM public.pacchetti_cliente pc JOIN public.tipi_pacchetto t ON t.id=pc.tipo_pacchetto_id
                              WHERE pc.cliente_id=ANY(ids) AND t.servizio_id=service)
                 THEN (SELECT count(*) FROM public.appuntamenti WHERE id=ANY(created) AND pacchetto_cliente_id IS NULL)
                 ELSE 0 END);

    ELSIF p_action IN ('update','delete') THEN
        SELECT * INTO old FROM public.appuntamenti WHERE id = (p_data->>'id')::uuid FOR UPDATE;
        IF NOT FOUND THEN RETURN jsonb_build_object('appuntamenti','[]'::jsonb); END IF;
        ids := ARRAY(SELECT DISTINCT x FROM (
            SELECT old.cliente_id x UNION ALL SELECT cliente_id FROM public.appuntamenti_clienti WHERE appuntamento_id = old.id
        ) c WHERE x IS NOT NULL);
        services := ARRAY[old.servizio_id];
        IF p_action = 'delete' THEN
            DELETE FROM public.appuntamenti WHERE id = old.id;
            PERFORM gestionale_internal.sync_scope(ids,services);
            RETURN jsonb_build_object('appuntamenti','[]'::jsonb);
        END IF;
        changes := p_data->'changes';
        IF jsonb_typeof(changes) IS DISTINCT FROM 'object' OR EXISTS (SELECT 1 FROM jsonb_object_keys(changes) k
            WHERE k NOT IN ('start_datetime','end_datetime','servizio_id','pacchetto_cliente_id','stato','note')) THEN
            RAISE EXCEPTION USING MESSAGE = 'invalid_booking';
        END IF;
        SELECT * INTO updated FROM jsonb_populate_record(old,changes);
        IF updated.end_datetime <= updated.start_datetime OR updated.start_datetime IS NULL OR updated.end_datetime IS NULL
           OR coalesce(updated.stato,'prenotato') NOT IN ('prenotato','confermato','completato','svolto','no_show','annullato','occupato') THEN
            RAISE EXCEPTION USING MESSAGE = 'invalid_booking';
        END IF;
        IF updated.stato = 'occupato' THEN updated.pacchetto_cliente_id := NULL; END IF;
        IF updated.pacchetto_cliente_id IS NOT NULL THEN
            SELECT pc.*,t.servizio_id,t.numero_sedute INTO pk FROM public.pacchetti_cliente pc
            JOIN public.tipi_pacchetto t ON t.id = pc.tipo_pacchetto_id WHERE pc.id = updated.pacchetto_cliente_id;
            IF NOT FOUND OR NOT (pk.cliente_id = ANY(ids)) OR pk.servizio_id IS DISTINCT FROM updated.servizio_id
               OR (pk.data_scadenza IS NOT NULL AND updated.start_datetime::date > pk.data_scadenza) THEN
                IF changes ? 'pacchetto_cliente_id' THEN RAISE EXCEPTION USING MESSAGE = 'invalid_package'; END IF;
                updated.pacchetto_cliente_id := NULL;
            ELSIF changes ? 'pacchetto_cliente_id' AND updated.pacchetto_cliente_id IS DISTINCT FROM old.pacchetto_cliente_id
                  AND (pk.chiusura_manuale OR pk.stato <> 'attivo') THEN
                RAISE EXCEPTION USING MESSAGE = 'package_closed';
            ELSIF old.stato = 'annullato' AND updated.stato <> 'annullato' THEN
                -- Restoring a cancelled slot must not overbook a package refilled meanwhile.
                IF pk.chiusura_manuale OR (SELECT count(*) FROM public.appuntamenti a
                    WHERE a.pacchetto_cliente_id = pk.id AND a.id <> old.id
                    AND coalesce(a.stato,'prenotato') NOT IN ('annullato','occupato')) >= pk.numero_sedute THEN
                    updated.pacchetto_cliente_id := NULL;
                END IF;
            END IF;
        END IF;
        IF updated.pacchetto_cliente_id IS NULL OR updated.stato IN ('annullato','occupato') THEN
            updated.scalato := false; updated.numero_seduta := NULL;
        END IF;
        UPDATE public.appuntamenti SET start_datetime = updated.start_datetime, end_datetime = updated.end_datetime,
            servizio_id = updated.servizio_id, pacchetto_cliente_id = updated.pacchetto_cliente_id, stato = updated.stato,
            note = updated.note, scalato = updated.scalato, numero_seduta = updated.numero_seduta WHERE id = old.id;
        PERFORM gestionale_internal.sync_scope(ids,array_append(services,updated.servizio_id));
        SELECT to_jsonb(a) INTO result FROM public.appuntamenti a WHERE a.id = old.id;
        RETURN jsonb_build_object('appuntamenti',jsonb_build_array(result));

    ELSIF p_action = 'delete_client' THEN
        client := (p_data->>'id')::uuid;
        SELECT array_agg(DISTINCT a.servizio_id), array_agg(DISTINCT coalesce(ac.cliente_id,a.cliente_id)) INTO services,ids
        FROM public.appuntamenti a LEFT JOIN public.appuntamenti_clienti ac ON ac.appuntamento_id=a.id
        WHERE a.cliente_id=client OR EXISTS (SELECT 1 FROM public.appuntamenti_clienti link
              WHERE link.appuntamento_id=a.id AND link.cliente_id=client);
        ids := coalesce(ids,'{}'::uuid[]) || ARRAY(SELECT a.cliente_id FROM public.appuntamenti a
            JOIN public.pacchetti_cliente pc ON pc.id=a.pacchetto_cliente_id WHERE pc.cliente_id=client);
        DELETE FROM public.clienti WHERE id=client;
        IF NOT FOUND THEN RETURN jsonb_build_object('deleted',false); END IF;
        PERFORM gestionale_internal.sync_scope(ids,services);
        RETURN jsonb_build_object('deleted',true);

    ELSIF p_action = 'assign' THEN
        client := (p_data->>'cliente_id')::uuid;
        SELECT * INTO pk FROM public.tipi_pacchetto WHERE id = (p_data->>'tipo_pacchetto_id')::uuid;
        IF NOT FOUND OR pk.numero_sedute <= 0 OR pk.servizio_id IS NULL THEN RAISE EXCEPTION USING MESSAGE = 'invalid_package'; END IF;
        INSERT INTO public.pacchetti_cliente(cliente_id,tipo_pacchetto_id,sedute_effettuate,stato,chiusura_manuale)
        VALUES(client,pk.id,0,'attivo',false) RETURNING id INTO package;
        PERFORM gestionale_internal.sync_scope(ARRAY[client],ARRAY[pk.servizio_id]);
        SELECT to_jsonb(pc) INTO result FROM public.pacchetti_cliente pc WHERE pc.id = package;
        RETURN jsonb_build_object('pacchetto',result);

    ELSIF p_action = 'close' THEN
        UPDATE public.pacchetti_cliente SET chiusura_manuale = true, stato = 'chiuso'
        WHERE id = (p_data->>'id')::uuid RETURNING to_jsonb(pacchetti_cliente) INTO result;
        RETURN jsonb_build_object('pacchetto',result);
    END IF;
    RAISE EXCEPTION USING MESSAGE = 'invalid_operation';
END $fn$;

-- security-grants-begin
REVOKE ALL ON FUNCTION gestionale_internal.sync_package(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION gestionale_internal.sync_scope(uuid[],uuid[],boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION gestionale_internal.sync_package(uuid),
    gestionale_internal.sync_scope(uuid[],uuid[],boolean) TO service_role;
REVOKE ALL ON FUNCTION public.gestionale_package_operation(text,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gestionale_package_operation(text,jsonb) TO service_role;

-- Reconcile existing links only: fix numbering/counters, never attach past or uncovered bookings here.
DO $repair$
DECLARE p record;
BEGIN
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('gestionale_package_accounting_v1',0));
    FOR p IN SELECT id FROM public.pacchetti_cliente ORDER BY id
    LOOP PERFORM gestionale_internal.sync_package(p.id); END LOOP;
END $repair$;
