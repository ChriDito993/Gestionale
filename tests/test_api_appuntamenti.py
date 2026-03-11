import os

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


class FakeSupabase:
    def __init__(self):
        self.next_appuntamento_id = 1
        self.appuntamenti = {}
        self.appuntamenti_clienti = []
        self.pacchetti_cliente = {}
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
