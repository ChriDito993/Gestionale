import os
from datetime import datetime, timedelta

os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "test-key")
os.environ.setdefault("SECRET_KEY", "test-secret")

import app as app_module
import pytest


class FakeResponse:
    def __init__(self, data):
        self.data = data


class FakeQuery:
    def __init__(self, fake_supabase, table_name):
        self.fake_supabase = fake_supabase
        self.table_name = table_name
        self.operation = None
        self.payload = None
        self.filters = []
        self._single = False
        self._limit = None

    def select(self, _columns):
        self.operation = "select"
        return self

    def insert(self, payload):
        self.operation = "insert"
        self.payload = payload
        return self

    def update(self, payload):
        self.operation = "update"
        self.payload = payload
        return self

    def delete(self):
        self.operation = "delete"
        return self

    def eq(self, column, value):
        self.filters.append(("eq", column, value))
        return self

    def gte(self, column, value):
        self.filters.append(("gte", column, value))
        return self

    def lt(self, column, value):
        self.filters.append(("lt", column, value))
        return self

    def limit(self, value):
        self._limit = value
        return self

    def single(self):
        self._single = True
        return self

    def execute(self):
        self.fake_supabase.calls.append(
            {
                "table": self.table_name,
                "operation": self.operation,
                "payload": self.payload,
                "filters": list(self.filters),
            }
        )

        if self.table_name == "appuntamenti":
            return self._exec_appuntamenti()
        if self.table_name == "appuntamenti_clienti":
            return self._exec_appuntamenti_clienti()
        if self.table_name == "pacchetti_cliente":
            return self._exec_pacchetti_cliente()
        if self.table_name == "clienti":
            return self._exec_readonly(self.fake_supabase.clienti)
        if self.table_name == "servizi":
            return self._exec_readonly(self.fake_supabase.servizi)
        return FakeResponse([])

    def _filter_rows(self, rows):
        filtered = []
        for row in rows:
            include = True
            for operator, column, value in self.filters:
                row_value = row.get(column)
                if operator == "eq":
                    if str(row_value) != str(value):
                        include = False
                        break
                elif operator == "gte":
                    if row_value is None or str(row_value) < str(value):
                        include = False
                        break
                elif operator == "lt":
                    if row_value is None or str(row_value) >= str(value):
                        include = False
                        break
            if include:
                filtered.append(row)
        return filtered

    def _exec_appuntamenti(self):
        if self.operation == "insert":
            row = dict(self.payload or {})
            row["id"] = str(self.fake_supabase.next_appuntamento_id)
            self.fake_supabase.next_appuntamento_id += 1
            self.fake_supabase.appuntamenti[row["id"]] = row
            return FakeResponse([row])

        if self.operation == "select":
            rows = self._filter_rows(list(self.fake_supabase.appuntamenti.values()))
            if self._limit is not None:
                rows = rows[: self._limit]
            if self._single:
                return FakeResponse(rows[0] if rows else None)
            return FakeResponse(rows)

        if self.operation == "update":
            updated = []
            rows = self._filter_rows(list(self.fake_supabase.appuntamenti.values()))
            for row in rows:
                row.update(self.payload or {})
                updated.append(dict(row))
            return FakeResponse(updated)

        if self.operation == "delete":
            rows = self._filter_rows(list(self.fake_supabase.appuntamenti.values()))
            deleted = []
            for row in rows:
                deleted.append(row)
                self.fake_supabase.appuntamenti.pop(str(row["id"]), None)
            return FakeResponse(deleted)

        return FakeResponse([])

    def _exec_appuntamenti_clienti(self):
        if self.operation == "insert":
            row = dict(self.payload or {})
            self.fake_supabase.appuntamenti_clienti.append(row)
            return FakeResponse([row])
        return FakeResponse([])

    def _exec_pacchetti_cliente(self):
        if self.operation == "select":
            rows = self._filter_rows(list(self.fake_supabase.pacchetti_cliente.values()))
            if self._limit is not None:
                rows = rows[: self._limit]
            if self._single:
                return FakeResponse(rows[0] if rows else None)
            return FakeResponse(rows)

        if self.operation == "update":
            updated = []
            rows = self._filter_rows(list(self.fake_supabase.pacchetti_cliente.values()))
            for row in rows:
                row.update(self.payload or {})
                updated.append(dict(row))
            return FakeResponse(updated)

        return FakeResponse([])

    def _exec_readonly(self, rows_by_id):
        if self.operation != "select":
            return FakeResponse([])

        rows = self._filter_rows(list(rows_by_id.values()))
        if self._limit is not None:
            rows = rows[: self._limit]
        if self._single:
            return FakeResponse(rows[0] if rows else None)
        return FakeResponse(rows)


class FakeSupabase:
    def __init__(self):
        self.next_appuntamento_id = 1
        self.appuntamenti = {}
        self.appuntamenti_clienti = []
        self.pacchetti_cliente = {}
        self.clienti = {}
        self.servizi = {}
        self.calls = []

    def table(self, table_name):
        return FakeQuery(self, table_name)


@pytest.fixture
def authed_client(monkeypatch):
    fake_supabase = FakeSupabase()
    monkeypatch.setattr(app_module, "supabase", fake_supabase)
    app_module.app.config.update(TESTING=True)
    app_module._calendar_cache = {"key": None, "timestamp": None, "data": []}

    with app_module.app.test_client() as client:
        with client.session_transaction() as session:
            session["logged_in"] = True
        yield client, fake_supabase


@pytest.fixture
def unauth_client(monkeypatch):
    fake_supabase = FakeSupabase()
    monkeypatch.setattr(app_module, "supabase", fake_supabase)
    app_module.app.config.update(TESTING=True)
    app_module._calendar_cache = {"key": None, "timestamp": None, "data": []}
    with app_module.app.test_client() as client:
        yield client


def test_post_appuntamenti_creates_record_and_links_clients(authed_client):
    client, fake_supabase = authed_client

    response = client.post(
        "/api/appuntamenti",
        json={
            "servizio_id": 10,
            "start_datetime": "2026-03-11T10:00:00Z",
            "end_datetime": "2026-03-11T11:00:00+01:00",
            "clienti_ids": [101, 202],
        },
    )

    assert response.status_code == 200
    assert response.get_json()["success"] is True

    created = fake_supabase.appuntamenti["1"]
    assert created["cliente_id"] == 101
    assert created["servizio_id"] == 10
    assert created["start_datetime"] == "2026-03-11T10:00:00"
    assert created["end_datetime"] == "2026-03-11T11:00:00"
    assert len(fake_supabase.appuntamenti_clienti) == 2


def test_post_appuntamenti_sends_confirmation_without_blocking_creation(authed_client, monkeypatch):
    client, _fake_supabase = authed_client
    chiamate = []

    def fake_invia_conferme(appuntamenti, clienti_ids, servizio_id):
        chiamate.append((appuntamenti, clienti_ids, servizio_id))

    monkeypatch.setattr(app_module, "invia_conferme_appuntamento", fake_invia_conferme)

    response = client.post(
        "/api/appuntamenti",
        json={
            "servizio_id": 10,
            "start_datetime": "2026-03-11T10:00:00",
            "end_datetime": "2026-03-11T11:00:00",
            "clienti_ids": [101],
            "invia_conferma_email": True,
        },
    )

    assert response.status_code == 200
    assert len(chiamate) == 1
    appuntamenti, clienti_ids, servizio_id = chiamate[0]
    assert appuntamenti[0]["id"] == "1"
    assert clienti_ids == [101]
    assert servizio_id == 10


def test_post_appuntamenti_does_not_send_confirmation_without_opt_in(authed_client, monkeypatch):
    client, _fake_supabase = authed_client
    chiamate_email = []
    monkeypatch.setattr(
        app_module,
        "invia_conferme_appuntamento",
        lambda *args: chiamate_email.append(args),
    )

    response = client.post(
        "/api/appuntamenti",
        json={
            "servizio_id": 10,
            "start_datetime": "2026-03-11T10:00:00",
            "end_datetime": "2026-03-11T11:00:00",
            "clienti_ids": [101],
        },
    )

    assert response.status_code == 200
    assert chiamate_email == []


def test_invia_email_uses_gmail_smtp_when_configured(monkeypatch):
    class FakeSmtp:
        instances = []

        def __init__(self, host, port, context, timeout):
            self.host = host
            self.port = port
            self.context = context
            self.timeout = timeout
            self.login_args = None
            self.message = None
            self.__class__.instances.append(self)

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def login(self, email, password):
            self.login_args = (email, password)

        def send_message(self, message):
            self.message = message

    monkeypatch.delenv("GMAIL_EMAIL", raising=False)
    monkeypatch.delenv("GMAIL_APP_PASSWORD", raising=False)
    monkeypatch.setenv("EMAIL_USER", "studio@example.com")
    monkeypatch.setenv("EMAIL_PASS", "pass word app")
    monkeypatch.setenv("GMAIL_FROM_NAME", "Studio Test")
    monkeypatch.setattr(app_module.smtplib, "SMTP_SSL", FakeSmtp)

    allegato = ("appuntamento-1.ics", b"BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n", "text", "calendar")
    assert app_module.invia_email("cliente@example.com", "Conferma", "Testo email", [allegato]) is True
    smtp = FakeSmtp.instances[0]
    assert smtp.host == "smtp.gmail.com"
    assert smtp.port == 465
    assert smtp.login_args == ("studio@example.com", "passwordapp")
    assert smtp.message["To"] == "cliente@example.com"
    assert smtp.message["Subject"] == "Conferma"
    attachment = list(smtp.message.iter_attachments())[0]
    assert attachment.get_filename() == "appuntamento-1.ics"
    assert attachment.get_content().encode("utf-8") == allegato[1]


def test_genera_file_calendario_is_valid_and_uses_rome_timezone():
    contenuto = app_module.genera_file_calendario(
        {
            "id": "42",
            "start_datetime": "2026-06-10T09:30:00",
            "end_datetime": "2026-06-10T10:30:00",
        },
        "Massoterapia, relax",
        "Seduta: 3 di 10",
    ).decode("utf-8")
    contenuto_senza_pieghe = contenuto.replace("\r\n ", "")

    assert contenuto.startswith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n")
    assert "UID:appuntamento-42@" in contenuto_senza_pieghe
    assert "DTSTART;TZID=Europe/Rome:20260610T093000" in contenuto_senza_pieghe
    assert "DTEND;TZID=Europe/Rome:20260610T103000" in contenuto_senza_pieghe
    assert "LOCATION:Via Michele Lessona 9\\, Milano" in contenuto_senza_pieghe
    assert "SUMMARY:Massoterapia & PT – Massoterapia\\, relax" in contenuto_senza_pieghe
    assert "DESCRIPTION:Appuntamento presso Massoterapia & PT di Christian Di Tommaso.\\nSeduta: 3 di 10" in contenuto_senza_pieghe
    assert contenuto.endswith("END:VEVENT\r\nEND:VCALENDAR\r\n")


def test_confirmation_email_includes_package_session_and_ics(authed_client, monkeypatch):
    _client, fake_supabase = authed_client
    fake_supabase.clienti["101"] = {"id": "101", "nome": "Mario", "email": "mario@example.com"}
    fake_supabase.servizi["10"] = {"id": "10", "nome": "Massoterapia"}
    fake_supabase.pacchetti_cliente["500"] = {
        "id": "500",
        "cliente_id": "101",
        "tipi_pacchetto": {"numero_sedute": 10},
    }
    email_inviate = []
    monkeypatch.setattr(
        app_module,
        "invia_email",
        lambda destinatario, oggetto, corpo, allegati=None: email_inviate.append(
            (destinatario, oggetto, corpo, allegati)
        ) or True,
    )

    app_module.invia_conferme_appuntamento(
        [{
            "id": "42",
            "start_datetime": "2026-03-11T10:00:00",
            "end_datetime": "2026-03-11T11:00:00",
            "pacchetto_cliente_id": "500",
            "numero_seduta": 3,
        }],
        ["101"],
        "10",
    )

    assert len(email_inviate) == 1
    destinatario, oggetto, corpo, allegati = email_inviate[0]
    assert destinatario == "mario@example.com"
    assert oggetto == "Conferma appuntamento – Massoterapia & PT"
    assert "Seduta: 3 di 10" in corpo
    assert "Luogo: Via Michele Lessona 9, Milano" in corpo
    assert allegati[0][0] == "appuntamento-42.ics"
    assert b"DTSTART;TZID=Europe/Rome:20260311T100000" in allegati[0][1]


def test_couple_appointment_sends_email_and_session_to_both_clients(authed_client, monkeypatch):
    _client, fake_supabase = authed_client
    fake_supabase.clienti["101"] = {"id": "101", "nome": "Mario", "email": "mario@example.com"}
    fake_supabase.clienti["202"] = {"id": "202", "nome": "Anna", "email": "anna@example.com"}
    fake_supabase.servizi["20"] = {"id": "20", "nome": "Ginnastica posturale di coppia"}
    fake_supabase.pacchetti_cliente["500"] = {
        "id": "500",
        "cliente_id": "101",
        "tipi_pacchetto": {"numero_sedute": 10},
    }
    email_inviate = []
    monkeypatch.setattr(
        app_module,
        "invia_email",
        lambda destinatario, oggetto, corpo, allegati=None: email_inviate.append(
            (destinatario, oggetto, corpo, allegati)
        ) or True,
    )

    app_module.invia_conferme_appuntamento(
        [{
            "id": "44",
            "start_datetime": "2026-03-11T10:00:00",
            "end_datetime": "2026-03-11T11:00:00",
            "pacchetto_cliente_id": "500",
            "numero_seduta": 3,
        }],
        ["101", "202"],
        "20",
    )

    assert {email[0] for email in email_inviate} == {"mario@example.com", "anna@example.com"}
    assert all(email[1] == "Conferma appuntamento – Massoterapia & PT" for email in email_inviate)
    assert all("Seduta: 3 di 10" in email[2] for email in email_inviate)
    assert all(email[3][0][0] == "appuntamento-44.ics" for email in email_inviate)


def test_confirmation_email_omits_session_without_package_or_email(authed_client, monkeypatch):
    _client, fake_supabase = authed_client
    fake_supabase.clienti["101"] = {"id": "101", "nome": "Mario", "email": "mario@example.com"}
    fake_supabase.clienti["202"] = {"id": "202", "nome": "Luca", "email": ""}
    fake_supabase.servizi["10"] = {"id": "10", "nome": "Massoterapia"}
    email_inviate = []
    monkeypatch.setattr(
        app_module,
        "invia_email",
        lambda destinatario, oggetto, corpo, allegati=None: email_inviate.append(corpo) or False,
    )

    app_module.invia_conferme_appuntamento(
        [{
            "id": "43",
            "start_datetime": "2026-03-11T10:00:00",
            "end_datetime": "2026-03-11T11:00:00",
            "pacchetto_cliente_id": None,
            "numero_seduta": None,
        }],
        ["101", "202"],
        "10",
    )

    assert len(email_inviate) == 1
    assert "Seduta:" not in email_inviate[0]


def test_post_appuntamenti_can_occupy_slot_without_cliente(authed_client, monkeypatch):
    client, fake_supabase = authed_client
    chiamate_email = []
    monkeypatch.setattr(
        app_module,
        "invia_conferme_appuntamento",
        lambda *args: chiamate_email.append(args),
    )

    response = client.post(
        "/api/appuntamenti",
        json={
            "servizio_id": 10,
            "start_datetime": "2026-03-11T10:00:00",
            "end_datetime": "2026-03-11T11:00:00",
            "occupato": True,
        },
    )

    assert response.status_code == 200
    assert fake_supabase.appuntamenti["1"]["cliente_id"] is None
    assert fake_supabase.appuntamenti["1"]["stato"] == "occupato"
    assert fake_supabase.appuntamenti_clienti == []
    assert chiamate_email == []


def test_post_appuntamenti_supports_legacy_cliente_id_field(authed_client):
    client, fake_supabase = authed_client

    response = client.post(
        "/api/appuntamenti",
        json={
            "servizio_id": 3,
            "start_datetime": "2026-03-11T09:00:00",
            "end_datetime": "2026-03-11T10:00:00",
            "cliente_id": 999,
        },
    )

    assert response.status_code == 200
    assert response.get_json()["success"] is True
    assert fake_supabase.appuntamenti["1"]["cliente_id"] == 999
    assert fake_supabase.appuntamenti_clienti == [
        {"appuntamento_id": "1", "cliente_id": 999}
    ]


def test_post_appuntamenti_requires_at_least_one_cliente(authed_client):
    client, fake_supabase = authed_client

    response = client.post(
        "/api/appuntamenti",
        json={
            "servizio_id": 10,
            "start_datetime": "2026-03-11T10:00:00",
            "end_datetime": "2026-03-11T11:00:00",
        },
    )

    assert response.status_code == 400
    assert "Nessun cliente selezionato" in response.get_json()["error"]
    assert fake_supabase.appuntamenti == {}


def test_post_appuntamenti_creates_weekly_series(authed_client):
    client, fake_supabase = authed_client

    response = client.post(
        "/api/appuntamenti",
        json={
            "servizio_id": 10,
            "start_datetime": "2026-03-11T10:00:00",
            "end_datetime": "2026-03-11T11:00:00",
            "clienti_ids": [101],
            "ripeti_settimanale": True,
            "occorrenze": 5,
        },
    )

    assert response.status_code == 200
    body = response.get_json()
    assert body["success"] is True
    assert body["created_count"] == 5
    assert len(fake_supabase.appuntamenti) == 5
    assert len(fake_supabase.appuntamenti_clienti) == 5

    expected_starts = [
        (datetime(2026, 3, 11, 10, 0, 0) + timedelta(days=7 * i)).isoformat()
        for i in range(5)
    ]
    actual_starts = sorted(
        row["start_datetime"] for row in fake_supabase.appuntamenti.values()
    )
    assert actual_starts == expected_starts


def test_post_appuntamenti_rejects_invalid_occorrenze(authed_client):
    client, fake_supabase = authed_client

    response = client.post(
        "/api/appuntamenti",
        json={
            "servizio_id": 10,
            "start_datetime": "2026-03-11T10:00:00",
            "end_datetime": "2026-03-11T11:00:00",
            "clienti_ids": [101],
            "ripeti_settimanale": True,
            "occorrenze": 0,
        },
    )

    assert response.status_code == 400
    assert "occorrenze" in response.get_json()["error"].lower()
    assert fake_supabase.appuntamenti == {}


def test_post_appuntamenti_creates_custom_slots_sequence(authed_client):
    client, fake_supabase = authed_client

    response = client.post(
        "/api/appuntamenti",
        json={
            "servizio_id": 10,
            "clienti_ids": [101],
            "slots_personalizzati": [
                {
                    "start_datetime": "2026-03-09T15:00:00",
                    "end_datetime": "2026-03-09T16:00:00",
                },
                {
                    "start_datetime": "2026-03-12T17:00:00",
                    "end_datetime": "2026-03-12T18:00:00",
                },
                {
                    "start_datetime": "2026-03-18T19:00:00",
                    "end_datetime": "2026-03-18T20:00:00",
                },
            ],
        },
    )

    assert response.status_code == 200
    body = response.get_json()
    assert body["success"] is True
    assert body["created_count"] == 3
    assert len(fake_supabase.appuntamenti) == 3

    expected_starts = [
        "2026-03-09T15:00:00",
        "2026-03-12T17:00:00",
        "2026-03-18T19:00:00",
    ]
    actual_starts = sorted(
        row["start_datetime"] for row in fake_supabase.appuntamenti.values()
    )
    assert actual_starts == expected_starts


@pytest.mark.parametrize(
    "method,path,payload",
    [
        ("post", "/api/appuntamenti", {"servizio_id": 1}),
        ("put", "/api/appuntamenti/42", {"stato": "confermato"}),
        ("delete", "/api/appuntamenti/42", None),
    ],
)
def test_critical_api_requires_login(unauth_client, method, path, payload):
    client = unauth_client
    if payload is None:
        response = getattr(client, method)(path)
    else:
        response = getattr(client, method)(path, json=payload)

    assert response.status_code == 302
    assert response.headers["Location"].endswith("/login")


def test_put_appuntamenti_updates_payload(authed_client):
    client, fake_supabase = authed_client
    fake_supabase.appuntamenti["55"] = {
        "id": "55",
        "servizio_id": 10,
        "start_datetime": "2026-03-11T10:00:00",
        "end_datetime": "2026-03-11T11:00:00",
    }

    response = client.put(
        "/api/appuntamenti/55",
        json={
            "stato": "confermato",
            "start_datetime": "2026-03-12T09:30:00Z",
        },
    )

    assert response.status_code == 200
    body = response.get_json()
    assert body[0]["stato"] == "confermato"
    assert fake_supabase.appuntamenti["55"]["start_datetime"] == "2026-03-12T09:30:00"


def test_put_appuntamenti_non_existing_returns_empty_array(authed_client):
    client, _fake_supabase = authed_client

    response = client.put(
        "/api/appuntamenti/404",
        json={"stato": "annullato"},
    )

    assert response.status_code == 200
    assert response.get_json() == []


def test_delete_appuntamenti_removes_record(authed_client):
    client, fake_supabase = authed_client
    fake_supabase.appuntamenti["77"] = {
        "id": "77",
        "pacchetto_cliente_id": None,
        "scalato": False,
    }

    response = client.delete("/api/appuntamenti/77")

    assert response.status_code == 200
    assert response.get_json()["success"] is True
    assert "77" not in fake_supabase.appuntamenti


def test_delete_appuntamento_with_scaled_package_decrements_sessions(authed_client):
    client, fake_supabase = authed_client
    fake_supabase.appuntamenti["88"] = {
        "id": "88",
        "pacchetto_cliente_id": "500",
        "scalato": True,
    }
    fake_supabase.pacchetti_cliente["500"] = {
        "id": "500",
        "sedute_effettuate": 4,
    }

    response = client.delete("/api/appuntamenti/88")

    assert response.status_code == 200
    assert response.get_json()["success"] is True
    assert fake_supabase.pacchetti_cliente["500"]["sedute_effettuate"] == 3
    assert "88" not in fake_supabase.appuntamenti


def test_smoke_calendar_get_returns_events(authed_client):
    client, fake_supabase = authed_client
    fake_supabase.appuntamenti["1"] = {
        "id": "1",
        "start_datetime": "2026-03-11T10:00:00",
        "end_datetime": "2026-03-11T11:00:00",
        "stato": "prenotato",
        "numero_seduta": 2,
        "reminder_whatsapp": False,
        "servizi": {
            "nome": "Massoterapia",
            "colore_calendario": "#2a9d8f",
        },
        "appuntamenti_clienti": [
            {
                "cliente_id": "101",
                "clienti": {"nome": "Mario", "cognome": "Rossi"},
            }
        ],
    }

    response = client.get("/api/appuntamenti")

    assert response.status_code == 200
    body = response.get_json()
    assert len(body) == 1
    assert body[0]["id"] == "1"
    assert body[0]["title"] == "Massoterapia (S2)"


def test_calendar_marks_occupied_slot_in_red(authed_client):
    client, fake_supabase = authed_client
    fake_supabase.appuntamenti["1"] = {
        "id": "1",
        "start_datetime": "2026-03-11T10:00:00",
        "end_datetime": "2026-03-11T11:00:00",
        "stato": "occupato",
        "servizi": {
            "nome": "Massoterapia",
            "colore_calendario": "#2a9d8f",
        },
        "appuntamenti_clienti": [],
    }

    response = client.get("/api/appuntamenti")

    assert response.status_code == 200
    body = response.get_json()
    assert body[0]["title"] == "Occupato"
    assert body[0]["backgroundColor"] == "#dc2626"
    assert body[0]["extendedProps"]["occupato"] is True


def test_health_endpoint_is_public(unauth_client):
    client = unauth_client
    response = client.get("/health")

    assert response.status_code == 200
    body = response.get_json()
    assert body["status"] == "ok"
    assert "timestamp" in body
    assert response.headers.get("X-Request-ID")


def test_api_unhandled_error_returns_request_id(authed_client, monkeypatch):
    client, _fake_supabase = authed_client

    class ExplodingSupabase:
        def table(self, _table_name):
            raise RuntimeError("boom")

    monkeypatch.setattr(app_module, "supabase", ExplodingSupabase())

    response = client.get("/api/servizi")

    assert response.status_code == 500
    body = response.get_json()
    assert body["error"] == "Errore interno del server"
    assert body["request_id"]
    assert response.headers.get("X-Request-ID") == body["request_id"]


def test_promemoria_route_requires_login(unauth_client):
    client = unauth_client
    response = client.get("/cliente/123/promemoria")

    assert response.status_code == 302
    assert response.headers["Location"].endswith("/login")


def test_update_stato_updates_appointment_and_redirects(authed_client):
    client, fake_supabase = authed_client
    fake_supabase.appuntamenti["42"] = {"id": "42", "stato": "prenotato"}

    response = client.post(
        "/update_stato",
        data={
            "appuntamento_id": "42",
            "stato": "completato",
        },
    )

    assert response.status_code == 302
    assert response.headers["Location"].endswith("/")
    assert fake_supabase.appuntamenti["42"]["stato"] == "completato"
