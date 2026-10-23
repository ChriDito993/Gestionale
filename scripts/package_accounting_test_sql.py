"""Build a rollback-only SQL test using temporary tables, never live app tables."""
from pathlib import Path


def build_test_sql():
    root = Path(__file__).resolve().parents[1]
    fixture = (root / "tests/package_accounting_fixture.sql").read_text()
    migration = (root / "sql/package_accounting.sql").read_text()
    for line in ("CREATE SCHEMA IF NOT EXISTS gestionale_internal;\n",
                 "REVOKE ALL ON SCHEMA gestionale_internal FROM PUBLIC, anon, authenticated;\n",
                 "GRANT USAGE ON SCHEMA gestionale_internal TO service_role;\n"):
        migration = migration.replace(line, "")
    migration = migration.replace("public.", "pg_temp.").replace("gestionale_internal.", "pg_temp.")
    migration = migration.replace("table_schema = 'public'", "table_schema = (SELECT nspname FROM pg_namespace WHERE oid=pg_my_temp_schema())")
    migration = migration.replace("gestionale_package_accounting_v1", "gestionale_package_accounting_test")
    if "public." in migration or "CREATE SCHEMA" in migration or "SECURITY DEFINER" in migration:
        raise RuntimeError("Unsafe test transformation")
    cases = (root / "tests/package_accounting_cases.sql").read_text()
    return "BEGIN;\nSET LOCAL statement_timeout = '25s';\n" + fixture + "\n" + migration + "\n" + cases + "\nROLLBACK;\nSELECT true AS package_accounting_tests_passed;"


if __name__ == "__main__":
    print(build_test_sql())
