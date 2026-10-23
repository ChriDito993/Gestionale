DO $test$
DECLARE
    c uuid; c2 uuid; s uuid; other_service uuid; t uuid; other_type uuid; p uuid; manual_p uuid;
    ids uuid[]; res jsonb; request jsonb; a uuid; cancelled uuid; future_unlinked uuid; past_unlinked uuid;
    booked integer; c3 uuid; c4 uuid; one_type uuid; single_p uuid; first_id uuid; second_id uuid;
    base timestamp := (current_timestamp AT TIME ZONE 'Europe/Rome') + interval '2 days';
BEGIN
    INSERT INTO pg_temp.clienti(nome) VALUES('Test one') RETURNING id INTO c;
    INSERT INTO pg_temp.clienti(nome) VALUES('Test two') RETURNING id INTO c2;
    INSERT INTO pg_temp.servizi(nome) VALUES('Service A') RETURNING id INTO s;
    INSERT INTO pg_temp.servizi(nome) VALUES('Service B') RETURNING id INTO other_service;
    INSERT INTO pg_temp.tipi_pacchetto(nome,servizio_id,numero_sedute) VALUES('Ten sessions',s,10) RETURNING id INTO t;
    INSERT INTO pg_temp.tipi_pacchetto(nome,servizio_id,numero_sedute) VALUES('Other service',other_service,5) RETURNING id INTO other_type;
    res := pg_temp.gestionale_package_operation('assign',jsonb_build_object('cliente_id',c,'tipo_pacchetto_id',t));
    p := (res->'pacchetto'->>'id')::uuid;
    SELECT jsonb_build_object('clienti_ids',jsonb_build_array(c,c2),'servizio_id',s,'pacchetto_cliente_id',p,
        'slots',jsonb_agg(jsonb_build_object('start_datetime',base + n*interval '1 day',
                                          'end_datetime',base + n*interval '1 day' + interval '1 hour'))) INTO request
    FROM generate_series(1,10) n;
    res := pg_temp.gestionale_package_operation('create',request);
    ASSERT jsonb_array_length(res->'appuntamenti') = 10, 'batch create';
    ASSERT (SELECT sedute_effettuate=10 AND stato='chiuso' AND NOT chiusura_manuale FROM pg_temp.pacchetti_cliente WHERE id=p), 'full closure';
    ASSERT (SELECT count(*)=20 FROM pg_temp.appuntamenti_clienti), 'couple bridge exactly once';
    a := (res->'appuntamenti'->3->>'id')::uuid;
    PERFORM pg_temp.gestionale_package_operation('delete',jsonb_build_object('id',a));
    ASSERT (SELECT sedute_effettuate=9 AND sedute_rimanenti=1 AND stato='attivo' FROM pg_temp.pacchetti_cliente WHERE id=p), 'delete reopens';
    ASSERT (SELECT array_agg(numero_seduta ORDER BY start_datetime)=ARRAY[1,2,3,4,5,6,7,8,9] FROM pg_temp.appuntamenti WHERE pacchetto_cliente_id=p), 'contiguous numbering';
    PERFORM pg_temp.gestionale_package_operation('delete',jsonb_build_object('id',a));
    ASSERT (SELECT sedute_effettuate=9 FROM pg_temp.pacchetti_cliente WHERE id=p), 'duplicate delete no double decrement';
    SELECT id INTO cancelled FROM pg_temp.appuntamenti WHERE pacchetto_cliente_id=p ORDER BY start_datetime LIMIT 1;
    PERFORM pg_temp.gestionale_package_operation('update',jsonb_build_object('id',cancelled,'changes',jsonb_build_object('stato','annullato')));
    PERFORM pg_temp.gestionale_package_operation('update',jsonb_build_object('id',cancelled,'changes',jsonb_build_object('stato','annullato')));
    ASSERT (SELECT sedute_effettuate=8 FROM pg_temp.pacchetti_cliente WHERE id=p), 'cancel only once';
    ASSERT (SELECT numero_seduta IS NULL AND NOT scalato FROM pg_temp.appuntamenti WHERE id=cancelled), 'cancel no session number';
    PERFORM pg_temp.gestionale_package_operation('update',jsonb_build_object('id',cancelled,'changes',jsonb_build_object('stato','prenotato')));
    ASSERT (SELECT sedute_effettuate=9 FROM pg_temp.pacchetti_cliente WHERE id=p), 'restore';
    SELECT id INTO a FROM pg_temp.appuntamenti WHERE pacchetto_cliente_id=p ORDER BY start_datetime DESC LIMIT 1;
    PERFORM pg_temp.gestionale_package_operation('update',jsonb_build_object('id',a,'changes',jsonb_build_object(
        'start_datetime',base,'end_datetime',base+interval '1 hour')));
    ASSERT (SELECT numero_seduta=1 FROM pg_temp.appuntamenti WHERE id=a), 'reschedule reorders';
    PERFORM pg_temp.gestionale_package_operation('update',jsonb_build_object('id',a,'changes',jsonb_build_object('servizio_id',other_service)));
    ASSERT (SELECT pacchetto_cliente_id IS NULL AND NOT scalato FROM pg_temp.appuntamenti WHERE id=a), 'service mismatch detaches';
    ASSERT (SELECT sedute_effettuate=8 FROM pg_temp.pacchetti_cliente WHERE id=p), 'old service refunded';
    -- Explicit oversubscription rejects the ENTIRE batch, without extra bridge rows.
    SELECT count(*) INTO booked FROM pg_temp.appuntamenti;
    BEGIN
        PERFORM pg_temp.gestionale_package_operation('create',request);
        RAISE EXCEPTION 'oversubscription accepted';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM <> 'package_capacity' THEN RAISE; END IF;
    END;
    ASSERT (SELECT count(*)=booked FROM pg_temp.appuntamenti), 'capacity rollback';
    PERFORM pg_temp.gestionale_package_operation('close',jsonb_build_object('id',p));
    SELECT id INTO a FROM pg_temp.appuntamenti WHERE pacchetto_cliente_id=p LIMIT 1;
    PERFORM pg_temp.gestionale_package_operation('delete',jsonb_build_object('id',a));
    ASSERT (SELECT stato='chiuso' AND chiusura_manuale FROM pg_temp.pacchetti_cliente WHERE id=p), 'manual stays closed';
    -- A new package captures future uncovered appointments only, never history or old packages.
    INSERT INTO pg_temp.appuntamenti(cliente_id,servizio_id,start_datetime,end_datetime)
        VALUES(c,s,base,base+interval '1 hour') RETURNING id INTO future_unlinked;
    INSERT INTO pg_temp.appuntamenti(cliente_id,servizio_id,start_datetime,end_datetime)
        VALUES(c,s,base-interval '20 days',base-interval '20 days'+interval '1 hour') RETURNING id INTO past_unlinked;
    res := pg_temp.gestionale_package_operation('assign',jsonb_build_object('cliente_id',c,'tipo_pacchetto_id',t));
    manual_p := p; p := (res->'pacchetto'->>'id')::uuid;
    ASSERT (SELECT pacchetto_cliente_id=p FROM pg_temp.appuntamenti WHERE id=future_unlinked), 'future attached';
    ASSERT (SELECT pacchetto_cliente_id IS NULL FROM pg_temp.appuntamenti WHERE id=past_unlinked), 'past preserved';
    ASSERT (SELECT count(*)=7 FROM pg_temp.appuntamenti WHERE pacchetto_cliente_id=manual_p), 'old links preserved';
    -- Automatic matching filters by service BEFORE choosing a package.
    res := pg_temp.gestionale_package_operation('assign',jsonb_build_object('cliente_id',c,'tipo_pacchetto_id',other_type));
    request := jsonb_build_object('clienti_ids',jsonb_build_array(c),'servizio_id',s,
        'slots',jsonb_build_array(jsonb_build_object('start_datetime',base+interval '30 days','end_datetime',base+interval '30 days 1 hour')));
    res := pg_temp.gestionale_package_operation('create',request);
    ASSERT (res->'appuntamenti'->0->>'pacchetto_cliente_id')::uuid=p, 'auto correct service';
    ASSERT (res->'appuntamenti'->0->>'numero_seduta')::integer=2, 'auto counts correctly';
    -- Invalid second slot causes full transaction rollback, not a half-created series.
    SELECT count(*) INTO booked FROM pg_temp.appuntamenti;
    request := jsonb_set(request,'{slots}',(request->'slots') || jsonb_build_array(jsonb_build_object(
        'start_datetime',base,'end_datetime',base-interval '1 hour')));
    BEGIN
        PERFORM pg_temp.gestionale_package_operation('create',request);
        RAISE EXCEPTION 'invalid batch accepted';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM <> 'invalid_booking' THEN RAISE; END IF;
    END;
    ASSERT (SELECT count(*)=booked FROM pg_temp.appuntamenti), 'invalid batch rollback';
    -- Full package restoration after a freed slot has already been used by another booking.
    INSERT INTO pg_temp.clienti(nome) VALUES('Test three') RETURNING id INTO c3;
    INSERT INTO pg_temp.tipi_pacchetto(nome,servizio_id,numero_sedute) VALUES('Single session',s,1) RETURNING id INTO one_type;
    res := pg_temp.gestionale_package_operation('assign',jsonb_build_object('cliente_id',c3,'tipo_pacchetto_id',one_type));
    single_p := (res->'pacchetto'->>'id')::uuid;
    request := jsonb_build_object('clienti_ids',jsonb_build_array(c3),'servizio_id',s,'pacchetto_cliente_id',single_p,
        'slots',jsonb_build_array(jsonb_build_object('start_datetime',base,'end_datetime',base+interval '1 hour')));
    res := pg_temp.gestionale_package_operation('create',request);
    first_id := (res->'appuntamenti'->0->>'id')::uuid;
    PERFORM pg_temp.gestionale_package_operation('update',jsonb_build_object('id',first_id,'changes',jsonb_build_object('stato','annullato')));
    request := jsonb_set(request,'{slots}',jsonb_build_array(jsonb_build_object('start_datetime',base+interval '1 day','end_datetime',base+interval '1 day 1 hour')));
    res := pg_temp.gestionale_package_operation('create',request);
    second_id := (res->'appuntamenti'->0->>'id')::uuid;
    PERFORM pg_temp.gestionale_package_operation('update',jsonb_build_object('id',first_id,'changes',jsonb_build_object('stato','prenotato')));
    ASSERT (SELECT sedute_effettuate=1 FROM pg_temp.pacchetti_cliente WHERE id=single_p), 'restore no overflow';
    ASSERT (SELECT pacchetto_cliente_id IS NULL AND numero_seduta IS NULL FROM pg_temp.appuntamenti WHERE id=first_id), 'restored slot uncovered when full';
    PERFORM pg_temp.gestionale_package_operation('delete',jsonb_build_object('id',second_id));
    ASSERT (SELECT pacchetto_cliente_id=single_p AND numero_seduta=1 FROM pg_temp.appuntamenti WHERE id=first_id), 'freed capacity refills future existing slot';
    -- Occupied slots never consume a package, even with a supplied package/client.
    request := jsonb_set(request,'{occupato}','true');
    res := pg_temp.gestionale_package_operation('create',request);
    ASSERT res->'appuntamenti'->0->>'pacchetto_cliente_id' IS NULL, 'occupied no package';
    ASSERT (SELECT sedute_effettuate=1 FROM pg_temp.pacchetti_cliente WHERE id=single_p), 'occupied no count';
    -- A couple session can use the second participant's package, only once.
    res := pg_temp.gestionale_package_operation('assign',jsonb_build_object('cliente_id',c2,'tipo_pacchetto_id',t));
    p := (res->'pacchetto'->>'id')::uuid;
    request := jsonb_build_object('clienti_ids',jsonb_build_array(c,c2),'servizio_id',s,'pacchetto_cliente_id',p,
        'slots',jsonb_build_array(jsonb_build_object('start_datetime',base+interval '40 days','end_datetime',base+interval '40 days 1 hour')));
    res := pg_temp.gestionale_package_operation('create',request);
    ASSERT (SELECT sedute_effettuate=1 FROM pg_temp.pacchetti_cliente WHERE id=p), 'couple one session';
    PERFORM pg_temp.gestionale_package_operation('delete_client',jsonb_build_object('id',c));
    ASSERT (SELECT sedute_effettuate=0 AND stato='attivo' FROM pg_temp.pacchetti_cliente WHERE id=p), 'primary deletion refunds surviving owner';
    -- Automatic allocation can use consecutive packages, but never session 2 of 1.
    INSERT INTO pg_temp.clienti(nome) VALUES('Test four') RETURNING id INTO c4;
    PERFORM pg_temp.gestionale_package_operation('assign',jsonb_build_object('cliente_id',c4,'tipo_pacchetto_id',one_type));
    PERFORM pg_temp.gestionale_package_operation('assign',jsonb_build_object('cliente_id',c4,'tipo_pacchetto_id',one_type));
    SELECT jsonb_build_object('clienti_ids',jsonb_build_array(c4),'servizio_id',s,
        'slots',jsonb_agg(jsonb_build_object('start_datetime',base+n*interval '1 day','end_datetime',base+n*interval '1 day 1 hour')))
        INTO request FROM generate_series(1,3) n;
    res := pg_temp.gestionale_package_operation('create',request);
    ASSERT (res->>'uncovered_count')::integer=1, 'uncovered reported';
    ASSERT (SELECT count(*)=2 AND max(numero_seduta)=1 FROM pg_temp.appuntamenti WHERE cliente_id=c4 AND pacchetto_cliente_id IS NOT NULL), 'no overflow automatic';
    ASSERT (SELECT count(*)=2 FROM pg_temp.pacchetti_cliente WHERE cliente_id=c4 AND sedute_effettuate=1 AND stato='chiuso'), 'consecutive packages';
END $test$;
SELECT 'package accounting SQL assertions passed; all objects/data temporary' AS result;
