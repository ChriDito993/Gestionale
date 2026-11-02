import pytest
from login_security import LoginThrottle, required_secret, valid_credentials, password_hash
from test_api_appuntamenti import unauth_client
import app as app_module


@pytest.mark.parametrize('value', [None, '', 'super-secret-key-change-me'])
def test_missing_or_known_secret_refuses_startup(value):
    with pytest.raises(RuntimeError):
        required_secret(value)


def test_password_hash_and_unknown_email():
    hashed = password_hash('correct-password')
    assert valid_credentials('a@example.com', 'correct-password', 'a@example.com', hashed)
    assert not valid_credentials('b@example.com', 'correct-password', 'a@example.com', hashed)
    assert not valid_credentials('a@example.com', 'wrong', 'a@example.com', hashed)


def test_limit_shared_across_instances_and_expires(tmp_path):
    path = str(tmp_path / 'attempts.sqlite3')
    for _ in range(10):
        assert LoginThrottle(path).consume('127.0.0.1', now=1000) == 0
    assert LoginThrottle(path).consume('127.0.0.1', now=1001) == 900
    assert LoginThrottle(path).consume('127.0.0.2', now=1001) == 0
    assert LoginThrottle(path).consume('127.0.0.1', now=1900) == 0


@pytest.mark.parametrize('token', [None, 'forged-token'])
def test_login_rejects_missing_or_forged_csrf(unauth_client, token):
    unauth_client.get('/login')
    response = unauth_client.post('/login', data={'csrf_token': token or ''})
    assert response.status_code == 400
    with unauth_client.session_transaction() as session:
        assert not session.get('logged_in')


def test_csrf_token_from_other_browser_is_rejected(unauth_client):
    unauth_client.get('/login')
    with app_module.app.test_client() as other:
        other.get('/login')
        with other.session_transaction() as session:
            token = session['login_csrf']
    assert unauth_client.post('/login', data={'csrf_token': token}).status_code == 400


def test_login_throttle_is_not_bypassed_by_forwarded_header(unauth_client):
    unauth_client.get('/login')
    with unauth_client.session_transaction() as session:
        token = session['login_csrf']
    for n in range(10):
        assert unauth_client.post('/login', data={'csrf_token': token}, headers={'X-Forwarded-For': str(n)}).status_code == 200
    response = unauth_client.post('/login', data={'csrf_token': token})
    assert response.status_code == 429
    assert int(response.headers['Retry-After']) > 0
    assert response.headers['Cache-Control'] == 'no-store'


def test_session_cookie_security(unauth_client):
    response = unauth_client.get('/login')
    cookie = response.headers['Set-Cookie']
    assert 'HttpOnly' in cookie
    assert 'SameSite=Lax' in cookie
    assert app_module.app.config['PERMANENT_SESSION_LIFETIME'].total_seconds() == 28800
