"""Loopback-only browser test server. Never import this from the production app."""
import os
import logging
from pathlib import Path
import socket
import sys
import tempfile
import uuid
from datetime import timedelta
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT), str(ROOT / 'tests')]

# Explicit synthetic configuration overrides inherited production values before app import.
os.environ.update(
    SUPABASE_URL='https://example.supabase.co', SUPABASE_KEY='e2e-no-live-key',
    ADMIN_EMAIL='browser@example.invalid', ADMIN_PASSWORD='browser-test-password',
    ADMIN_PASSWORD_HASH='', SECRET_KEY='browser-tests-only-session-secret',
    SESSION_COOKIE_SECURE='false', SENTRY_DSN='', SHOW_PAYMENTS='false',
    PYTHON_DOTENV_DISABLED='1', EMAIL_PROVIDER='invalid',
)
import dotenv
dotenv.load_dotenv = lambda *a, **kw: False  # Also works with older dotenv versions.
import supabase
supabase.create_client = lambda *a, **kw: None  # Do not even construct a live client.
from test_api_appuntamenti import FakeQuery, FakeSupabase, FakePackageRpc
import app as application
from services import mail_transport
from flask import request, jsonify

# Defense in depth: outbound sockets and every email transport fail closed.
original_connect = socket.socket.connect
original_connect_ex = socket.socket.connect_ex


def allowed_address(address):
    return isinstance(address, tuple) and address[0] in ('127.0.0.1', '::1', 'localhost')


def connect(sock, address):
    if not allowed_address(address):
        raise RuntimeError('External connections disabled in browser tests')
    return original_connect(sock, address)


def connect_ex(sock, address):
    if not allowed_address(address):
        raise RuntimeError('External connections disabled in browser tests')
    return original_connect_ex(sock, address)


socket.socket.connect = connect
socket.socket.connect_ex = connect_ex
email_attempts = []


def blocked_email(*args, **kwargs):
    email_attempts.append(True)
    raise RuntimeError('Email transport disabled in browser tests')


mail_transport.smtplib.SMTP_SSL = blocked_email
mail_transport.requests.post = blocked_email
mail_transport.invia_email_dettagliata = blocked_email


class BrowserQuery(FakeQuery):
    def select(self, columns, count=None, head=False):
        super().select(columns)
        self.count_requested = count
        self.head = head
        return self

    def order(self, column, desc=False):
        self._orders.append((column, desc))
        return self

    def lte(self, column, value):
        self.filters.append(('lte', column, value))
        return self

    def execute(self):
        db = self.fake_supabase
        collection = getattr(db, self.table_name)
        rows = list(collection.values()) if isinstance(collection, dict) else collection
        db.calls.append({'table': self.table_name, 'operation': self.operation})
        filtered = []
        for row in rows:
            include = True
            for op, column, value in self.filters:
                current = row.get(column)
                if op == 'eq':
                    import json
                    include = current == json.loads(value) if column == 'email_conferme' else str(current) == str(value)
                elif op == 'is': include = current is None if value == 'null' else current == value
                elif op == 'in': include = current in value
                elif op == 'gte': include = current is not None and str(current) >= str(value)
                elif op == 'gt': include = current is not None and str(current) > str(value)
                elif op == 'lt': include = current is not None and str(current) < str(value)
                elif op == 'lte': include = current is not None and str(current) <= str(value)
                else: raise AssertionError('Unsupported test filter: ' + op)
                if not include: break
            if include: filtered.append(row)
        if self.operation == 'insert':
            row = dict(self.payload)
            row.setdefault('id', str(uuid.uuid4()))
            if not isinstance(collection, dict):
                collection.append(row)
            else: collection[row['id']] = row
            return SimpleNamespace(data=[dict(row)], count=1)
        if self.operation == 'update':
            for row in filtered: row.update(self.payload)
        if self.operation not in ('select', 'update'):
            raise AssertionError('Unsupported test operation: ' + str(self.operation))
        count = len(filtered)
        for column, desc in reversed(self._orders):
            filtered.sort(key=lambda row: str(row.get(column) or ''), reverse=desc)
        if self._range is not None:
            filtered = filtered[self._range[0]: self._range[1] + 1]
        if self._limit is not None: filtered = filtered[:self._limit]
        data = [db.joined(self.table_name, row) for row in filtered]
        return SimpleNamespace(data=(data[0] if data else None) if self._single else data, count=count)


class BrowserDatabase(FakeSupabase):
    def __init__(self):
        super().__init__()
        self.pagamenti = {}
        self.clienti = {
            '101': {'id': '101', 'nome': 'Mario', 'cognome': 'Bianchi', 'telefono': '393330000001',
                    'email': 'mario@example.invalid', 'data_nascita': '1990-01-01', 'note_cliniche': ''},
            '202': {'id': '202', 'nome': 'Élodie', 'cognome': 'Rossi', 'telefono': None,
                    'email': None, 'data_nascita': None, 'note_cliniche': ''},
        }
        self.servizi = {'10': {'id': '10', 'nome': 'Massoterapia', 'durata_minuti': 60, 'colore_calendario': '#16827b'}}
        self.tipi_pacchetto = {'30': {'id': '30', 'nome': 'Percorso 10 sedute', 'numero_sedute': 10, 'servizio_id': '10'}}
        self.pacchetti_cliente = {'50': {'id': '50', 'cliente_id': '101', 'tipo_pacchetto_id': '30',
            'stato': 'attivo', 'chiusura_manuale': False, 'sedute_totali': 10, 'sedute_effettuate': 0,
            'sedute_rimanenti': 10, 'data_attivazione': '2026-01-01T00:00:00', 'data_scadenza': None,
            'tipi_pacchetto': dict(self.tipi_pacchetto['30'])}}

    def table(self, name):
        if name not in ('clienti', 'servizi', 'tipi_pacchetto', 'pacchetti_cliente', 'appuntamenti', 'appuntamenti_clienti', 'pagamenti'):
            raise AssertionError('Unexpected table')
        return BrowserQuery(self, name)

    def joined(self, table, row):
        result = dict(row)
        if table == 'tipi_pacchetto': result['servizi'] = self.servizi.get(row['servizio_id'])
        if table == 'pacchetti_cliente':
            result['tipi_pacchetto'] = self.joined('tipi_pacchetto', self.tipi_pacchetto[row['tipo_pacchetto_id']])
            result['clienti'] = self.clienti.get(row['cliente_id'])
        if table == 'appuntamenti':
            result['servizi'] = self.servizi.get(row['servizio_id'])
            result['pacchetti_cliente'] = self.pacchetti_cliente.get(row.get('pacchetto_cliente_id'))
            result['appuntamenti_clienti'] = [dict(link, clienti=self.clienti.get(str(link['cliente_id'])))
                for link in self.appuntamenti_clienti if str(link['appuntamento_id']) == str(row['id'])]
        if table == 'appuntamenti_clienti': result['clienti'] = self.clienti.get(str(row['cliente_id']))
        return result

    def rpc(self, name, params):
        assert name == 'gestionale_package_operation'
        return FakePackageRpc(self, params)


app = application.app
app.config.update(TESTING=True, SESSION_COOKIE_SECURE=False)
logging.getLogger('werkzeug').setLevel(logging.ERROR)
temporary = tempfile.TemporaryDirectory(prefix='gestionale-browser-')


def reset_state():
    application.supabase = BrowserDatabase()
    application.login_throttle = application.LoginThrottle(str(Path(temporary.name) / (uuid.uuid4().hex + '.sqlite3')))
    application.invalidate_calendar_cache()
    application.invalidate_dashboard_caches()
    email_attempts.clear()


reset_state()


@app.before_request
def protect_test_controls():
    if request.path.startswith('/__e2e__/') and request.path != '/__e2e__/ready':
        if request.remote_addr not in ('127.0.0.1', '::1') or request.headers.get('X-E2E-Control') != 'isolated-browser-suite':
            return '', 403


@app.get('/__e2e__/ready')
def ready():
    return jsonify({'test_server': 'isolated-browser-suite'})


@app.post('/__e2e__/reset')
def reset():
    reset_state()
    return jsonify({'date': (application.studio_now().date() + timedelta(days=1)).isoformat()})


@app.get('/__e2e__/state')
def state():
    db = application.supabase
    return jsonify({'clienti': list(db.clienti.values()), 'appuntamenti': list(db.appuntamenti.values()),
        'partecipanti': db.appuntamenti_clienti, 'pacchetti': list(db.pacchetti_cliente.values()),
        'email_attempts': len(email_attempts)})


if __name__ == '__main__':
    # No environment override for bind address or port, and no reloader/debugger.
    from werkzeug.serving import run_simple
    # Browsers open parallel/speculative HTTP connections; a single-threaded server
    # can stall on an idle socket, especially with WebKit.
    run_simple('127.0.0.1', 39781, app, use_reloader=False, use_debugger=False, threaded=True)
