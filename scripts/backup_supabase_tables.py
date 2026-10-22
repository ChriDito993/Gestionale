"""Private JSON export of the seven application tables; never prints their data.

This is a logical Data API export, not a pg_dump of the whole project and not a
cross-table transactional snapshot. Run before changing application permissions.
"""
import argparse
import hashlib
import json
import logging
import os
from pathlib import Path
import subprocess
from datetime import datetime, timezone

from dotenv import dotenv_values
from supabase import create_client


ROOT = Path(__file__).resolve().parents[1]
TABLES = ("clienti", "servizi", "tipi_pacchetto", "pacchetti_cliente",
          "appuntamenti", "appuntamenti_clienti", "pagamenti")


def private_json(path, value):
    payload = (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode()
    descriptor = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "wb") as stream:
        stream.write(payload)
        stream.flush()
        os.fsync(stream.fileno())
    digest = hashlib.sha256(payload).hexdigest()
    if hashlib.sha256(path.read_bytes()).hexdigest() != digest:
        raise RuntimeError("Backup checksum mismatch")
    return digest


def export_table(client, table):
    before = client.table(table).select("id", count="exact", head=True).execute().count
    rows = []
    offset = 0
    while True:
        page = client.table(table).select("*").order("id").range(offset, offset + 499).execute().data
        if not isinstance(page, list):
            raise RuntimeError("Unexpected response")
        rows.extend(page)
        offset += len(page)
        if len(page) < 500:
            break
    after = client.table(table).select("id", count="exact", head=True).execute().count
    if before != after or before != len(rows) or len({str(row["id"]) for row in rows}) != len(rows):
        raise RuntimeError("Table changed during export; repeat backup before migration")
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", help="Existing, ignored directory under .backups containing access-before.json")
    args = parser.parse_args()
    backup_root = ROOT / ".backups"
    directory = Path(args.directory).resolve()
    if backup_root.is_symlink() or backup_root.resolve() not in directory.parents:
        raise RuntimeError("Backup must be inside the private .backups directory")
    if not directory.is_dir() or not (directory / "access-before.json").is_file():
        raise RuntimeError("Metadata snapshot required first")
    ignored = subprocess.run(["git", "check-ignore", "--quiet", str(directory / "manifest.json")],
                             cwd=ROOT, check=False)
    if ignored.returncode != 0:
        raise RuntimeError("Backup directory is not excluded from Git")
    os.chmod(backup_root, 0o700)
    os.chmod(directory, 0o700)
    os.chmod(directory / "access-before.json", 0o600)
    values = dotenv_values(ROOT / ".env")
    url = os.environ.get("SUPABASE_URL") or values.get("SUPABASE_URL") or ""
    key = os.environ.get("SUPABASE_KEY") or values.get("SUPABASE_KEY") or ""
    if url.rstrip("/") != "https://pxgvchgntplegqqzrzkn.supabase.co" or not key.startswith("sb_secret_"):
        raise RuntimeError("Expected project and backend secret key required")
    client = create_client(url, key)
    manifest = {"project": "pxgvchgntplegqqzrzkn", "created_at": datetime.now(timezone.utc).isoformat(),
                "format": "logical-data-api-json-export", "transactional_snapshot": False,
                "tables": {}, "metadata_sha256": hashlib.sha256((directory / "access-before.json").read_bytes()).hexdigest()}
    for table in TABLES:
        rows = export_table(client, table)
        digest = private_json(directory / (table + ".json"), rows)
        manifest["tables"][table] = {"rows": len(rows), "sha256": digest}
        print(table + ": esportazione e checksum verificati", flush=True)
    private_json(directory / "manifest.json", manifest)
    print("Backup completato: " + str(directory), flush=True)


if __name__ == "__main__":
    logging.disable(logging.CRITICAL)
    try:
        main()
    except Exception as error:
        # Never expose provider responses, credentials, row contents or tracebacks.
        print("Backup non completato; tipo=" + type(error).__name__ + ". Nessuna modifica remota eseguita.", flush=True)
        raise SystemExit(1)
