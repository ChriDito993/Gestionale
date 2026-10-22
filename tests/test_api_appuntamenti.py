import os
import json
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
        self._range = None

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

    def is_(self, column, value):
        self.filters.append(("is", column, value))
        return self

    def gte(self, column, value):
        self.filters.append(("gte", column, value))
        return self

    def lt(self, column, value):
        self.filters.append(("lt", column, value))
        return self

    def gt(self, column, value):
        self.filters.append(("gt", column, value))
        return self

    def order(self, _column):
        return self

    def range(self, first, last):
        self._range = (first, last)
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
            if self.operation == "update":
                rows = self._filter_rows(list(self.fake_supabase.clienti.values()))
                for row in rows:
                    row.update(self.payload or {})
                return FakeResponse([dict(row) for row in rows])
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
                    if column == "email_conferme":
                        matches = row_value == json.loads(value)
                    else:
                        matches = str(row_value) == str(value)
                    if not matches:
                        include = False
                        break
                elif operator == "is":
                    if value == "null" and row_value is not None:
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
                elif operator == "gt":
                    if row_value is None or str(row_value) <= str(value):
                        include = False
                        break
            if include:
                filtered.append(row)
        return filtered

    def _exec_appuntamenti(self):
        if self.operation == "insert":
            row = dict(self.payload or {})
            row.setdefault("email_conferme", {})
            row["id"] = str(self.fake_supabase.next_appuntamento_id)
            self.fake_supabase.next_appuntamento_id += 1
            self.fake_supabase.appuntamenti[row["id"]] = row
            return FakeResponse([row])

        if self.operation == "select":
            rows = self._filter_rows(list(self.fake_supabase.appuntamenti.values()))
            if self._range is not None:
                rows = rows[self._range[0]:self._range[1] + 1]
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
        if self.operation == "select":
            return FakeResponse(self._filter_rows(self.fake_supabase.appuntamenti_clienti))
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
        return {
            "requested": True,
            "attempted_count": 1,
            "sent_count": 1,
            "failed_count": 0,
            "skipped_no_email_count": 0,
        }

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
    assert response.get_json()["email_confirmation"]["sent_count"] == 1
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
    assert response.get_json()["email_confirmation"]["requested"] is False


def test_invia_email_uses_gmail_smtp_when_configured(monkeypatch):
    monkeypatch.delenv("EMAIL_PROVIDER", raising=False)
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


@pytest.mark.parametrize("phase,expected_success,expected_code", [
    ("send", False, "delivery_unknown"),
    ("quit", True, None),
])
def test_smtp_inflight_timeout_is_uncertain_but_quit_failure_is_not(email_config, monkeypatch, phase, expected_success, expected_code):
    monkeypatch.setenv("EMAIL_PROVIDER", "gmail")
    monkeypatch.setenv("EMAIL_USER", "studio@example.com")
    monkeypatch.setenv("EMAIL_PASS", "test-password")

    class Smtp:
        def __init__(self, *args, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            if phase == "quit":
                raise OSError("Connection closed after acceptance")

        def login(self, *args):
            pass

        def send_message(self, *args):
            if phase == "send":
                raise TimeoutError("Response lost")

    monkeypatch.setattr(app_module.smtplib, "SMTP_SSL", Smtp)
    result = app_module.invia_email_dettagliata("cliente@example.com", "Conferma", "Testo")
    assert result["success"] is expected_success
    assert result["error_code"] == expected_code


def test_resend_lost_connection_is_uncertain(email_config, monkeypatch):
    monkeypatch.setenv("EMAIL_PROVIDER", "resend")
    monkeypatch.setenv("RESEND_API_KEY", "test-key")

    def send(*args, **kwargs):
        raise app_module.requests.exceptions.ConnectionError("Response lost")

    monkeypatch.setattr(app_module.requests, "post", send)
    result = app_module.invia_email_dettagliata("cliente@example.com", "Conferma", "Testo")
    assert result["success"] is False
    assert result["error_code"] == "delivery_unknown"


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


@pytest.fixture
def email_config(monkeypatch):
    for nome in ("EMAIL_PROVIDER", "GMAIL_EMAIL", "GMAIL_APP_PASSWORD", "EMAIL_USER", "EMAIL_PASS",
                 "RESEND_API_KEY", "RESEND_FROM_EMAIL"):
        monkeypatch.delenv(nome, raising=False)

    def connessione_non_prevista(*args, **kwargs):
        pytest.fail("Tentativo di connessione email non simulata")

    monkeypatch.setattr(app_module.smtplib, "SMTP_SSL", connessione_non_prevista)
    monkeypatch.setattr(app_module.requests, "post", connessione_non_prevista)


@pytest.mark.parametrize("nome,numero,atteso", [
    ("Mario Rossi", 3, "Mario-Rossi-seduta-3.ics"),
    ("Mario Rossi", None, "Mario-Rossi.ics"),
    ("José D'Angelo", 2, "Jose-DAngelo-seduta-2.ics"),
    ("../Mario / Rossi\r\n", 3, "Mario-Rossi-seduta-3.ics"),
    ("", None, "Appuntamento.ics"),
])
def test_calendar_filename_is_personal_and_safe(nome, numero, atteso):
    assert app_module.nome_file_calendario(nome, numero) == atteso


def test_personal_calendar_title_preserves_utf8_and_folding():
    nome = "José " + "D'Angelo " * 15
    calendario = app_module.genera_file_calendario({
        "id": "42", "start_datetime": "2026-11-11T10:00:00", "end_datetime": "2026-11-11T11:00:00",
    }, "Massoterapia, relax", "Seduta: 3 di 10", nome_cliente=nome).decode("utf-8")
    assert f"SUMMARY:{nome.strip()} – Massoterapia\\, relax – Seduta 3 di 10\r\n" in calendario.replace("\r\n ", "")
    assert all(len(linea.encode("utf-8")) <= 75 for linea in calendario.split("\r\n"))


def test_explicit_resend_ignores_gmail_and_preserves_ics(email_config, monkeypatch):
    monkeypatch.setenv("EMAIL_PROVIDER", "resend")
    monkeypatch.setenv("EMAIL_USER", "studio@example.com")
    monkeypatch.setenv("EMAIL_PASS", "test-password")
    monkeypatch.setenv("RESEND_API_KEY", "test-api-key")
    monkeypatch.setenv("RESEND_FROM_EMAIL", "Studio <studio@example.com>")
    richieste = []

    def post(url, **kwargs):
        richieste.append((url, kwargs))
        return type("Response", (), {"status_code": 200})()

    monkeypatch.setattr(app_module.requests, "post", post)
    calendario = b"BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n"
    assert app_module.invia_email("cliente@example.com", "Conferma", "Testo", [
        ("appuntamento.ics", calendario, "text", "calendar")
    ]) is True
    assert len(richieste) == 1
    url, richiesta = richieste[0]
    assert url == "https://api.resend.com/emails"
    assert richiesta["json"]["from"] == "Studio <studio@example.com>"
    allegato = richiesta["json"]["attachments"][0]
    assert allegato["filename"] == "appuntamento.ics"
    assert app_module.base64.b64decode(allegato["content"]) == calendario


@pytest.mark.parametrize("provider,expected", [
    ("other", "invalid_provider"), ("gmail", "missing_configuration"),
    ("resend", "missing_configuration"),
])
def test_email_configuration_errors_do_not_connect(email_config, monkeypatch, provider, expected, caplog):
    monkeypatch.setenv("EMAIL_PROVIDER", provider)
    # Anche con l'altro provider configurato non deve esserci fallback.
    if provider == "gmail":
        monkeypatch.setenv("RESEND_API_KEY", "secret-test-api-key")
    else:
        monkeypatch.setenv("EMAIL_USER", "studio@example.com")
        monkeypatch.setenv("EMAIL_PASS", "secret-test-password")
    esito = app_module.invia_email_dettagliata("cliente@example.com", "Conferma", "Testo")
    assert esito["success"] is False
    assert esito["error_code"] == expected
    assert "secret-test" not in caplog.text


@pytest.mark.parametrize("errore,expected", [
    (OSError(101, "secret-test-network"), "network_unreachable"),
    (app_module.smtplib.SMTPAuthenticationError(535, b"secret-test-password"), "authentication_failed"),
    (TimeoutError("secret-test-timeout"), "timeout"),
])
def test_gmail_failure_is_safe_and_does_not_fallback(email_config, monkeypatch, errore, expected, caplog):
    monkeypatch.setenv("EMAIL_PROVIDER", "gmail")
    monkeypatch.setenv("EMAIL_USER", "studio@example.com")
    monkeypatch.setenv("EMAIL_PASS", "secret-test-password")
    monkeypatch.setenv("RESEND_API_KEY", "secret-test-api-key")

    def smtp(*args, **kwargs):
        raise errore

    monkeypatch.setattr(app_module.smtplib, "SMTP_SSL", smtp)
    esito = app_module.invia_email_dettagliata("cliente@example.com", "Conferma", "Testo")
    assert esito["success"] is False
    assert esito["error_code"] == expected
    assert esito["provider"] == "gmail"
    assert "secret-test" not in str(esito) + caplog.text


@pytest.mark.parametrize("status,body,expected", [
    (401, {"name": "validation_error", "message": "secret-test-key"}, "authentication_failed"),
    (400, {"message": "API key is invalid"}, "authentication_failed"),
    (403, {"message": "You can only send testing emails to your own email address (secret-test@example.com)"}, "test_recipient_only"),
    (403, {"message": "The secret-test.example.com domain is not verified"}, "sender_not_verified"),
    (403, {"message": "secret-test-permissions"}, "permission_denied"),
    (429, {}, "rate_limited"),
    (503, {}, "provider_unavailable"),
    (400, {}, "send_failed"),
])
def test_resend_errors_are_classified_without_exposing_response(email_config, monkeypatch, status, body, expected, caplog):
    monkeypatch.setenv("EMAIL_PROVIDER", "resend")
    monkeypatch.setenv("RESEND_API_KEY", "secret-test-key")

    class Response:
        status_code = status

        def json(self):
            return body

    monkeypatch.setattr(app_module.requests, "post", lambda *args, **kwargs: Response())
    esito = app_module.invia_email_dettagliata("cliente@example.com", "Conferma", "Testo")
    assert esito["success"] is False
    assert esito["error_code"] == expected
    assert "secret-test" not in str(esito) + caplog.text


def test_email_network_failure_keeps_created_appointment(authed_client, email_config, monkeypatch):
    client, fake_supabase = authed_client
    fake_supabase.clienti["101"] = {"id": "101", "nome": "Mario", "email": "mario@example.com"}
    fake_supabase.servizi["10"] = {"id": "10", "nome": "Massoterapia"}
    monkeypatch.setenv("EMAIL_PROVIDER", "gmail")
    monkeypatch.setenv("EMAIL_USER", "studio@example.com")
    monkeypatch.setenv("EMAIL_PASS", "test-password")

    def smtp(*args, **kwargs):
        raise OSError(101, "Network is unreachable")

    monkeypatch.setattr(app_module.smtplib, "SMTP_SSL", smtp)
    response = client.post("/api/appuntamenti", json={
        "servizio_id": 10, "clienti_ids": [101], "invia_conferma_email": True,
        "start_datetime": "2026-11-11T10:00:00", "end_datetime": "2026-11-11T11:00:00",
    })
    assert response.status_code == 200
    assert response.get_json()["success"] is True
    assert len(fake_supabase.appuntamenti) == 1
    esito = response.get_json()["email_confirmation"]
    assert esito["sent_count"] == 0
    assert esito["failed_count"] == 1
    assert esito["errors"][0]["code"] == "network_unreachable"


def test_couple_partial_failure_keeps_both_clients_and_reports_reason(authed_client, monkeypatch):
    client, fake_supabase = authed_client
    fake_supabase.clienti.update({
        "101": {"id": "101", "nome": "Mario", "email": "mario@example.com"},
        "202": {"id": "202", "nome": "Anna", "email": "anna@example.com"},
    })
    fake_supabase.servizi["20"] = {"id": "20", "nome": "Ginnastica di coppia"}
    risultati = iter([
        {"success": True},
        {"success": False, "error_code": "recipient_rejected", "message": "Destinatario rifiutato"},
    ])
    monkeypatch.setattr(app_module, "invia_email_dettagliata", lambda *args, **kwargs: next(risultati))
    response = client.post("/api/appuntamenti", json={
        "servizio_id": 20, "clienti_ids": [101, 202], "invia_conferma_email": True,
        "start_datetime": "2026-11-11T10:00:00", "end_datetime": "2026-11-11T11:00:00",
    })
    assert response.status_code == 200
    assert len(fake_supabase.appuntamenti) == 1
    assert len(fake_supabase.appuntamenti_clienti) == 2
    esito = response.get_json()["email_confirmation"]
    assert esito["attempted_count"] == 2
    assert esito["sent_count"] == 1
    assert esito["failed_count"] == 1
    assert esito["errors"] == [{"code": "recipient_rejected", "message": "Destinatario rifiutato"}]


def test_manual_reminder_returns_safe_email_error(authed_client, monkeypatch):
    client, fake_supabase = authed_client
    fake_supabase.appuntamenti["1"] = {
        "id": "1", "start_datetime": "2026-11-11T10:00:00", "servizi": {"nome": "Massoterapia"},
        "appuntamenti_clienti": [{"clienti": {"nome": "Mario", "email": "mario@example.com"}}],
    }
    monkeypatch.setattr(app_module, "invia_email_dettagliata", lambda *args, **kwargs: {
        "success": False, "error_code": "authentication_failed", "message": "Autenticazione non riuscita",
    })
    response = client.get("/invia_promemoria/1")
    assert response.status_code == 500
    assert response.get_json() == {
        "status": "error", "error_code": "authentication_failed", "message": "Autenticazione non riuscita",
    }


def test_confirmation_email_includes_package_session_and_ics(authed_client, monkeypatch):
    _client, fake_supabase = authed_client
    fake_supabase.appuntamenti["42"] = {"id": "42", "email_conferme": {}}
    fake_supabase.clienti["101"] = {"id": "101", "nome": "Mario", "cognome": "Rossi", "email": "mario@example.com"}
    fake_supabase.servizi["10"] = {"id": "10", "nome": "Massoterapia"}
    fake_supabase.pacchetti_cliente["500"] = {
        "id": "500",
        "cliente_id": "101",
        "tipi_pacchetto": {"numero_sedute": 10},
    }
    email_inviate = []
    monkeypatch.setattr(
        app_module,
        "invia_email_dettagliata",
        lambda destinatario, oggetto, corpo, allegati=None: email_inviate.append(
            (destinatario, oggetto, corpo, allegati)
        ) or {"success": True},
    )

    esito = app_module.invia_conferme_appuntamento(
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
    assert allegati[0][0] == "Mario-Rossi-seduta-3.ics"
    calendario = allegati[0][1].decode("utf-8").replace("\r\n ", "")
    assert "SUMMARY:Mario Rossi – Massoterapia – Seduta 3 di 10\r\n" in calendario
    assert "UID:appuntamento-42@" in calendario
    assert b"DTSTART;TZID=Europe/Rome:20260311T100000" in allegati[0][1]
    assert esito["sent_count"] == 1
    assert esito["failed_count"] == 0


def test_couple_appointment_sends_email_and_session_to_both_clients(authed_client, monkeypatch):
    _client, fake_supabase = authed_client
    fake_supabase.appuntamenti["44"] = {"id": "44", "email_conferme": {}}
    fake_supabase.clienti["101"] = {"id": "101", "nome": "Mario", "cognome": "Rossi", "email": "mario@example.com"}
    fake_supabase.clienti["202"] = {"id": "202", "nome": "Anna", "cognome": "Bianchi", "email": "anna@example.com"}
    fake_supabase.servizi["20"] = {"id": "20", "nome": "Ginnastica posturale di coppia"}
    fake_supabase.pacchetti_cliente["500"] = {
        "id": "500",
        "cliente_id": "101",
        "tipi_pacchetto": {"numero_sedute": 10},
    }
    email_inviate = []
    monkeypatch.setattr(
        app_module,
        "invia_email_dettagliata",
        lambda destinatario, oggetto, corpo, allegati=None: email_inviate.append(
            (destinatario, oggetto, corpo, allegati)
        ) or {"success": True},
    )

    esito = app_module.invia_conferme_appuntamento(
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
    for email, nome, altro_nome, file_atteso in [
        (email_inviate[0], "Mario Rossi", "Anna Bianchi", "Mario-Rossi-seduta-3.ics"),
        (email_inviate[1], "Anna Bianchi", "Mario Rossi", "Anna-Bianchi-seduta-3.ics"),
    ]:
        assert email[3][0][0] == file_atteso
        calendario = email[3][0][1].decode("utf-8").replace("\r\n ", "")
        assert f"SUMMARY:{nome} – Ginnastica posturale di coppia – Seduta 3 di 10\r\n" in calendario
        assert altro_nome not in calendario
    assert esito["sent_count"] == 2


def test_confirmation_email_omits_session_without_package_or_email(authed_client, monkeypatch):
    _client, fake_supabase = authed_client
    fake_supabase.appuntamenti["43"] = {"id": "43", "email_conferme": {}}
    fake_supabase.clienti["101"] = {"id": "101", "nome": "Mario", "email": "mario@example.com"}
    fake_supabase.clienti["202"] = {"id": "202", "nome": "Luca", "email": ""}
    fake_supabase.servizi["10"] = {"id": "10", "nome": "Massoterapia"}
    email_inviate = []
    monkeypatch.setattr(
        app_module,
        "invia_email_dettagliata",
        lambda destinatario, oggetto, corpo, allegati=None: email_inviate.append((corpo, allegati)) or {
            "success": False, "error_code": "network_unreachable", "message": "Connessione non disponibile",
        },
    )

    esito = app_module.invia_conferme_appuntamento(
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
    assert "Seduta:" not in email_inviate[0][0]
    assert email_inviate[0][1][0][0] == "Mario.ics"
    calendario = email_inviate[0][1][0][1].decode("utf-8").replace("\r\n ", "")
    assert "SUMMARY:Mario – Massoterapia\r\n" in calendario
    assert "Seduta" not in calendario
    assert esito["failed_count"] == 1
    assert esito["skipped_no_email_count"] == 1
    assert esito["errors"][0]["code"] == "network_unreachable"


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


@pytest.fixture
def tracked_couple(authed_client):
    client, db = authed_client
    db.appuntamenti["42"] = {
        "id": "42", "cliente_id": "101", "servizio_id": "20", "stato": "prenotato", "email_conferme": {},
        "start_datetime": "2026-11-11T10:00:00", "end_datetime": "2026-11-11T11:00:00",
    }
    db.appuntamenti_clienti = [{"appuntamento_id": "42", "cliente_id": cid} for cid in ("101", "202")]
    db.clienti = {
        "101": {"id": "101", "nome": "Mario", "email": "mario@example.com"},
        "202": {"id": "202", "nome": "Anna", "email": "anna@example.com"},
    }
    db.servizi["20"] = {"id": "20", "nome": "Ginnastica di coppia"}
    return client, db


def test_retry_only_failed_recipient_without_duplicate_booking(tracked_couple, monkeypatch):
    client, db = tracked_couple
    sent = []
    def send(email, *args, **kwargs):
        sent.append(email)
        if email == "anna@example.com" and sent.count(email) == 1:
            return {"success": False, "provider": "gmail", "error_code": "network_unreachable", "message": "Connessione non disponibile"}
        return {"success": True, "provider": "gmail"}
    monkeypatch.setattr(app_module, "invia_email_dettagliata", send)
    result = app_module.invia_conferme_appuntamento([db.appuntamenti["42"]], ["101", "202"], "20")
    assert result["sent_count"] == result["failed_count"] == 1
    states = db.appuntamenti["42"]["email_conferme"]
    assert states["101"]["status"] == "sent"
    assert states["202"]["status"] == "failed"
    response = client.get("/api/appuntamenti/42/conferme")
    assert response.status_code == 200
    people = response.get_json()["destinatari"]
    assert [p["can_send"] for p in people] == [False, True]
    assert "mario@example.com" not in response.get_data(as_text=True)
    retry = client.post("/api/appuntamenti/42/conferme", json={"cliente_id": "202"})
    assert retry.get_json()["email_confirmation"]["sent_count"] == 1
    duplicate = client.post("/api/appuntamenti/42/conferme", json={"cliente_id": "101"})
    assert duplicate.get_json()["email_confirmation"]["skipped_already_sent_count"] == 1
    assert sent == ["mario@example.com", "anna@example.com", "anna@example.com"]
    assert len(db.appuntamenti) == 1
    assert db.appuntamenti["42"]["email_conferme"]["202"]["status"] == "sent"


def test_retry_rejects_other_client_and_cancelled_appointment(tracked_couple, monkeypatch):
    client, db = tracked_couple
    monkeypatch.setattr(app_module, "invia_email_dettagliata", lambda *args, **kwargs: pytest.fail("Email non autorizzata"))
    assert client.post("/api/appuntamenti/42/conferme", json={"cliente_id": "999"}).status_code == 400
    db.appuntamenti["42"]["stato"] = "annullato"
    assert client.post("/api/appuntamenti/42/conferme", json={"cliente_id": "101"}).status_code == 409


def test_unknown_delivery_requires_explicit_confirmation(tracked_couple, monkeypatch):
    client, db = tracked_couple
    sent = []
    monkeypatch.setattr(app_module, "invia_email_dettagliata", lambda *args, **kwargs: sent.append(1) or {"success": True})
    db.appuntamenti["42"]["email_conferme"] = {"101": {"status": "unknown"}}
    blocked = client.post("/api/appuntamenti/42/conferme", json={"cliente_id": "101"})
    assert blocked.get_json()["email_confirmation"]["errors"][0]["code"] == "delivery_unknown"
    assert sent == []
    allowed = client.post("/api/appuntamenti/42/conferme", json={"cliente_id": "101", "conferma_esito_incerto": True})
    assert allowed.get_json()["email_confirmation"]["sent_count"] == 1
    assert sent == [1]


def test_store_claim_is_exclusive_and_preserves_other_recipient(tracked_couple, monkeypatch):
    _client, db = tracked_couple
    store = app_module.ConfirmationStore(db)
    original = store._swap
    calls = []
    def concurrent_change(id, old, new):
        if not calls:
            calls.append(1)
            db.appuntamenti[id]["email_conferme"] = {"202": {"status": "failed"}}
            return False
        return original(id, old, new)
    monkeypatch.setattr(store, "_swap", concurrent_change)
    claim = store.claim("42", "101", "fingerprint")
    assert claim["acquired"] is True
    assert db.appuntamenti["42"]["email_conferme"]["202"]["status"] == "failed"
    assert store.claim("42", "101", "fingerprint")["reason"] == "send_in_progress"
    store.finish("42", "101", claim["attempt_id"], "sent")
    assert store.claim("42", "101", "fingerprint")["reason"] == "already_sent"
    assert store.claim("42", "101", "changed-fingerprint")["acquired"] is True


def test_persistence_error_prevents_send(tracked_couple, monkeypatch):
    client, db = tracked_couple
    db.appuntamenti["42"].pop("email_conferme")
    monkeypatch.setattr(app_module, "invia_email_dettagliata", lambda *args, **kwargs: pytest.fail("Invio senza tracciamento"))
    assert client.get("/api/appuntamenti/42/conferme").status_code == 503
    result = app_module.invia_conferme_appuntamento([db.appuntamenti["42"]], ["101"], "20")
    assert result["errors"][0]["code"] == "tracking_unavailable"
    assert len(db.appuntamenti) == 1


def test_changed_appointment_marks_confirmation_outdated(tracked_couple, monkeypatch):
    client, db = tracked_couple
    monkeypatch.setattr(app_module, "invia_email_dettagliata", lambda *args, **kwargs: {"success": True})
    app_module.invia_conferme_appuntamento([db.appuntamenti["42"]], ["101"], "20")
    db.appuntamenti["42"]["start_datetime"] = "2026-11-11T10:30:00"
    person = client.get("/api/appuntamenti/42/conferme").get_json()["destinatari"][0]
    assert person["status"] == "outdated"
    assert person["can_send"] is True


def test_overlap_warning_ignores_adjacent_cancelled_and_current(authed_client):
    client, db = authed_client
    for id, start, end, state in [
        ("1", "09:00", "10:00", "prenotato"), ("2", "10:00", "11:00", "annullato"),
        ("3", "10:15", "10:45", "occupato"), ("4", "10:00", "11:00", "prenotato"),
    ]:
        db.appuntamenti[id] = {"id": id, "start_datetime": "2026-11-11T" + start + ":00", "end_datetime": "2026-11-11T" + end + ":00", "stato": state}
    response = client.post("/api/appuntamenti/conflitti", json={
        "slots": [{"start_datetime": "2026-11-11T10:00:00", "end_datetime": "2026-11-11T11:00:00"}], "ignore_id": "4",
    })
    assert response.get_json() == {"count": 1, "internal_count": 0}
    assert all(call["operation"] == "select" for call in db.calls)


@pytest.mark.parametrize("slots", [[], [{}], [{"start_datetime": "invalid", "end_datetime": "invalid"}]])
def test_overlap_rejects_invalid_slots(authed_client, slots):
    client, _db = authed_client
    assert client.post("/api/appuntamenti/conflitti", json={"slots": slots}).status_code == 400


def test_overlap_detects_overlaps_between_new_slots(authed_client):
    client, _db = authed_client
    response = client.post("/api/appuntamenti/conflitti", json={"slots": [
        {"start_datetime": "2026-11-11T10:00:00", "end_datetime": "2026-11-11T11:00:00"},
        {"start_datetime": "2026-11-11T10:30:00", "end_datetime": "2026-11-11T11:30:00"},
    ]})
    assert response.get_json() == {"count": 0, "internal_count": 1}


@pytest.mark.parametrize("method,path", [("get", "/api/appuntamenti/42/conferme"), ("post", "/api/appuntamenti/42/conferme"), ("post", "/api/appuntamenti/conflitti")])
def test_new_workflows_require_login(unauth_client, method, path):
    assert getattr(unauth_client, method)(path).status_code == 302


@pytest.mark.parametrize("show_payments", [False, True])
@pytest.mark.parametrize("populated", [False, True])
def test_workflow_templates_render_and_payments_can_be_hidden(monkeypatch, show_payments, populated):
    from html.parser import HTMLParser
    from flask import render_template

    class Page(HTMLParser):
        def __init__(self):
            super().__init__()
            self.ids = []
            self.links = []
            self.forms = []

        def handle_starttag(self, tag, attributes):
            attrs = dict(attributes)
            if attrs.get("id"):
                self.ids.append(attrs["id"])
            if tag == "a":
                self.links.append(attrs.get("href"))
            if tag == "form":
                self.forms.append(attrs.get("action"))

    monkeypatch.setitem(app_module.app.config, "SHOW_PAYMENTS", show_payments)
    customer = {"id": "101", "nome": "Élodie", "cognome": "Rossi", "email": "cliente@example.com"}
    package = {"id": "p1", "tipi_pacchetto": {"nome": "Percorso", "numero_sedute": 10}, "sedute_effettuate": 8, "sedute_rimanenti": 2}
    with app_module.app.test_request_context("/"):
        home = render_template("index.html")
        archive = render_template("clienti.html", clienti=[customer] if populated else [])
        profile = render_template("cliente_dettaglio.html", cliente=customer,
            pacchetti_cliente=[package] if populated else [], tipi_pacchetto=[], appuntamenti=[], storico_appuntamenti=[])
    pages = []
    for html in (home, archive, profile):
        page = Page()
        page.feed(html)
        assert len(page.ids) == len(set(page.ids)), "Duplicate element IDs"
        assert "workflow.css" in html
        pages.append(page)
    assert ("/pagamenti" in pages[0].links) is show_payments
    assert ('class="detail-card profile-payments"' in profile) is show_payments
    assert "/assegna_pacchetto" in pages[2].forms
    assert "pacchettoSelect" in pages[0].ids
    assert ("/cliente/101" in pages[1].links) is populated
    if populated:
        assert "/chiudi_pacchetto/p1" in pages[2].forms
        assert "package-low" in profile


def test_hidden_payments_page_is_still_available(authed_client, monkeypatch):
    client, _db = authed_client
    monkeypatch.setitem(app_module.app.config, "SHOW_PAYMENTS", False)
    response = client.get("/pagamenti")
    assert response.status_code == 200
    assert b"Resoconto Pagamenti" in response.data


@pytest.mark.parametrize("previous", [None, "", "   "])
def test_add_missing_email_preserves_other_customer_fields(authed_client, previous):
    client, db = authed_client
    db.clienti["101"] = {"id": "101", "nome": "Mario", "cognome": "Rossi", "telefono": "393331111111", "email": previous}
    response = client.put("/api/clienti/101/email", json={"email": " mario@example.com ", "nome": "IGNORATO"})
    assert response.status_code == 200
    assert response.get_json() == {"id": "101", "email": "mario@example.com"}
    assert db.clienti["101"] == {"id": "101", "nome": "Mario", "cognome": "Rossi", "telefono": "393331111111", "email": "mario@example.com"}
    assert len(db.appuntamenti) == 0


@pytest.mark.parametrize("email", [None, "", "senza-chiocciola", "a@", "a@example", "a b@example.com", "a@example.com\r\nBcc:other@example.com", 123, ["a@example.com"], "a" * 250 + "@example.com"])
def test_add_missing_email_rejects_invalid_input_without_writes(authed_client, email):
    client, db = authed_client
    assert client.put("/api/clienti/101/email", json={"email": email}).status_code == 400
    assert db.calls == []


def test_add_missing_email_requires_login(unauth_client):
    assert unauth_client.put("/api/clienti/101/email", json={"email": "mario@example.com"}).status_code == 302


def test_add_missing_email_requires_existing_customer(authed_client):
    client, _db = authed_client
    assert client.put("/api/clienti/101/email", json={"email": "mario@example.com"}).status_code == 404


def test_add_missing_email_never_replaces_existing_address(authed_client):
    client, db = authed_client
    db.clienti["101"] = {"id": "101", "email": "gia-presente@example.com"}
    assert client.put("/api/clienti/101/email", json={"email": "nuova@example.com"}).status_code == 409
    assert db.clienti["101"]["email"] == "gia-presente@example.com"
    response = client.put("/api/clienti/101/email", json={"email": "GIA-PRESENTE@example.com"})
    assert response.status_code == 200
    assert all(call["operation"] == "select" for call in db.calls)


def test_add_missing_email_detects_concurrent_change(authed_client, monkeypatch):
    client, db = authed_client
    db.clienti["101"] = {"id": "101", "email": None}
    original = FakeQuery.execute
    def concurrently_updated(query):
        if query.table_name == "clienti" and query.operation == "update":
            db.clienti["101"]["email"] = "altro-operatore@example.com"
        return original(query)
    monkeypatch.setattr(FakeQuery, "execute", concurrently_updated)
    assert client.put("/api/clienti/101/email", json={"email": "nuova@example.com"}).status_code == 409
    assert db.clienti["101"]["email"] == "altro-operatore@example.com"


def test_new_profile_emails_are_used_for_couple_confirmation_with_ics(authed_client, monkeypatch):
    client, db = authed_client
    db.clienti.update({"101": {"id": "101", "nome": "Mario", "email": None}, "202": {"id": "202", "nome": "Anna", "email": ""}})
    db.servizi["20"] = {"id": "20", "nome": "Ginnastica di coppia"}
    sent = []
    def send(email, subject, body, allegati=None):
        sent.append((email, allegati))
        return {"success": True, "provider": "gmail"}
    monkeypatch.setattr(app_module, "invia_email_dettagliata", send)
    for id, email in (("101", "mario@example.com"), ("202", "anna@example.com")):
        assert client.put("/api/clienti/" + id + "/email", json={"email": email}).status_code == 200
    response = client.post("/api/appuntamenti", json={
        "servizio_id": "20", "clienti_ids": ["101", "202"], "invia_conferma_email": True,
        "start_datetime": "2026-11-11T10:00:00", "end_datetime": "2026-11-11T11:00:00",
    })
    assert response.status_code == 200
    assert response.get_json()["email_confirmation"]["sent_count"] == 2
    assert [email for email, _ in sent] == ["mario@example.com", "anna@example.com"]
    assert all(attachments[0][0].endswith(".ics") for _, attachments in sent)
    assert len(db.appuntamenti) == 1
    assert len(db.appuntamenti_clienti) == 2
