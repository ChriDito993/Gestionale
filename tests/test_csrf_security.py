import pytest
import app as app_module
from test_api_appuntamenti import authed_client, unauth_client


@pytest.mark.parametrize('method,path', [
    ('post', '/api/clienti'), ('put', '/api/clienti/123'),
    ('delete', '/api/clienti/123'), ('put', '/api/clienti/123/email'),
    ('post', '/api/appuntamenti'), ('put', '/api/appuntamenti/123'),
    ('delete', '/api/appuntamenti/123'), ('post', '/api/appuntamenti/123/conferme'),
    ('post', '/api/appuntamenti/conflitti'), ('post', '/api/appuntamenti/123/reminder_whatsapp'),
    ('post', '/api/clienti/123/pacchetti'), ('post', '/api/pagamenti'),
    ('put', '/api/pagamenti/123'), ('delete', '/api/pagamenti/123'),
    ('post', '/assegna_pacchetto'), ('post', '/cliente/123/note'),
    ('post', '/update_stato'), ('post', '/chiudi_pacchetto/123'),
    ('post', '/invia_promemoria/123'), ('post', '/logout'),
])
@pytest.mark.parametrize('token', ['', 'forged', 'token-è'])
def test_mutations_reject_missing_and_forged_tokens_before_side_effects(authed_client, monkeypatch, method, path, token):
    client, _ = authed_client
    class NoDatabaseAccess:
        def __getattr__(self, name):
            raise AssertionError('CSRF rejection must precede database access')
    monkeypatch.setattr(app_module, 'supabase', NoDatabaseAccess())
    response = getattr(client, method)(path, headers={'X-CSRF-Token': token})
    assert response.status_code == 400
    with client.session_transaction() as session:
        assert session['logged_in'] is True


def test_valid_form_token_logs_out_without_javascript(authed_client):
    client, _ = authed_client
    response = client.post('/logout', data={'csrf_token': 'workflow-test-token'}, headers={'X-CSRF-Token': ''})
    assert response.status_code == 302
    with client.session_transaction() as session:
        assert not session.get('logged_in')
        assert 'csrf_token' not in session


@pytest.mark.parametrize('path', ['/logout', '/invia_promemoria/123'])
def test_get_never_logs_out_or_sends_email(authed_client, path):
    client, _ = authed_client
    assert client.get(path).status_code == 405
    with client.session_transaction() as session:
        assert session.get('logged_in') is True


def test_old_session_receives_csrf_token_on_page_load(authed_client):
    client, _ = authed_client
    with client.session_transaction() as session:
        session.pop('csrf_token')
    response = client.get('/pagamenti')
    assert response.status_code == 200
    with client.session_transaction() as session:
        token = session['csrf_token']
    assert f'name="csrf-token" content="{token}"' in response.get_data(as_text=True)
    assert '/static/csrf.js' in response.get_data(as_text=True)


def test_token_from_another_session_does_not_authorize_mutation(authed_client):
    client, _ = authed_client
    with app_module.app.test_client() as other:
        with other.session_transaction() as session:
            session['logged_in'] = True
            session['csrf_token'] = 'different-browser-token'
        response = other.post('/logout', data={'csrf_token': 'workflow-test-token'})
        assert response.status_code == 400
