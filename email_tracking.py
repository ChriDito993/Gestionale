"""Persistent, per-recipient confirmation state with compare-and-swap updates."""
import hashlib
import json
import uuid
from datetime import datetime, timezone


class TrackingUnavailable(Exception):
    pass


def confirmation_fingerprint(appointment, email):
    values = [appointment.get(key) for key in (
        "start_datetime", "end_datetime", "servizio_id", "pacchetto_cliente_id", "numero_seduta"
    )] + [(email or "").strip().casefold()]
    return hashlib.sha256(json.dumps(values, default=str).encode()).hexdigest()


def sending_is_recent(state):
    try:
        when = datetime.fromisoformat(state["updated_at"].replace("Z", "+00:00"))
        return (datetime.now(timezone.utc) - when).total_seconds() < 120
    except (ValueError, KeyError, TypeError):
        return False


class ConfirmationStore:
    def __init__(self, client):
        self.client = client

    def read(self, appointment_id):
        row = self.client.table("appuntamenti").select("email_conferme").eq("id", appointment_id).single().execute().data
        if not row or not isinstance(row.get("email_conferme"), dict):
            raise TrackingUnavailable()
        return row["email_conferme"]

    def _swap(self, appointment_id, old, new):
        return bool(self.client.table("appuntamenti").update({"email_conferme": new})
                    .eq("id", appointment_id)
                    .eq("email_conferme", json.dumps(old, separators=(",", ":")))
                    .execute().data)

    def claim(self, appointment_id, client_id, fingerprint, allow_uncertain=False):
        key = str(client_id)
        for _ in range(3):
            snapshot = self.read(appointment_id)
            old = snapshot.get(key) or {}
            status = old.get("status")
            if status == "sent" and old.get("fingerprint") == fingerprint:
                return {"acquired": False, "reason": "already_sent"}
            if status == "sending" and sending_is_recent(old):
                return {"acquired": False, "reason": "send_in_progress"}
            if status in {"sending", "unknown"} and not allow_uncertain:
                return {"acquired": False, "reason": "delivery_unknown"}
            attempt_id = uuid.uuid4().hex
            state = {"status": "sending", "attempt_id": attempt_id, "fingerprint": fingerprint,
                     "updated_at": datetime.now(timezone.utc).isoformat(), "error_code": None}
            if self._swap(appointment_id, snapshot, {**snapshot, key: state}):
                return {"acquired": True, "attempt_id": attempt_id}
        return {"acquired": False, "reason": "send_in_progress"}

    def finish(self, appointment_id, client_id, attempt_id, status, error_code=None, provider=None):
        key = str(client_id)
        for _ in range(3):
            snapshot = self.read(appointment_id)
            current = snapshot.get(key) or {}
            if current.get("attempt_id") != attempt_id:
                raise TrackingUnavailable()
            state = {**current, "status": status, "error_code": error_code, "provider": provider,
                     "updated_at": datetime.now(timezone.utc).isoformat()}
            if self._swap(appointment_id, snapshot, {**snapshot, key: state}):
                return
        raise TrackingUnavailable()
