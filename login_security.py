"""Login protections independent of the database containing customer data."""
import hashlib
import os
import secrets
import sqlite3
import time
from datetime import timedelta
from werkzeug.security import check_password_hash, generate_password_hash


def required_secret(value):
    if not value or value == 'super-secret-key-change-me':
        raise RuntimeError('Impostare SECRET_KEY con un segreto casuale prima di avviare il gestionale.')
    return value


def password_hash(password):
    # Explicit portable work factor: the local Python build lacks hashlib.scrypt.
    return generate_password_hash(password, method='pbkdf2:sha256:1000000')


def valid_credentials(email, password, expected_email, expected_hash):
    # Always perform the expensive password check, including unknown email addresses.
    password_ok = check_password_hash(expected_hash, password)
    return secrets.compare_digest(email.encode(), expected_email.encode()) and password_ok


class LoginThrottle:
    """SQLite serializes attempts across Gunicorn workers on the same host.

    No forwarded IP headers are trusted. Behind a proxy several users may share
    the same bucket. Multi-instance deployments need a shared rate-limit store.
    """
    def __init__(self, path):
        self.path = path

    def consume(self, address, now=None):
        now = time.time() if now is None else now
        key = hashlib.sha256(address.encode()).hexdigest()
        with sqlite3.connect(self.path, timeout=5) as db:
            db.execute('CREATE TABLE IF NOT EXISTS login_attempts (bucket TEXT, at REAL)')
            db.execute('BEGIN IMMEDIATE')
            db.execute('DELETE FROM login_attempts WHERE at <= ?', (now - 900,))
            count, oldest = db.execute(
                'SELECT count(*), min(at) FROM login_attempts WHERE bucket = ?', (key,)
            ).fetchone()
            if count >= 10:
                return max(1, int(oldest + 900 - now) + 1)
            db.execute('INSERT INTO login_attempts VALUES (?, ?)', (key, now))
        return 0


def configure_session(app):
    app.secret_key = required_secret(os.getenv('SECRET_KEY'))
    app.config.update(
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE='Lax',
        SESSION_COOKIE_SECURE=os.getenv('SESSION_COOKIE_SECURE', 'true').lower() not in {'false', '0'},
        PERMANENT_SESSION_LIFETIME=timedelta(hours=8),
        SESSION_REFRESH_EACH_REQUEST=False,
    )
