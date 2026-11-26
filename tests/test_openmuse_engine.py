import json
import os
import sqlite3
import pytest

PLUGIN_JSON_PATH = os.path.join(
    os.path.dirname(__file__), "..", "extensions", "openmuse-engine", "friday.plugin.json"
)
PACKAGE_JSON_PATH = os.path.join(
    os.path.dirname(__file__), "..", "extensions", "openmuse-engine", "package.json"
)

def test_openmuse_plugin_manifest_validity():
    """Verify friday.plugin.json is valid and contains expected configuration."""
    assert os.path.exists(PLUGIN_JSON_PATH), "friday.plugin.json must exist"
    with open(PLUGIN_JSON_PATH, "r", encoding="utf-8") as f:
        data = json.load(f)
    assert data["id"] == "openmuse-engine"
    assert "OpenMuse" in data["name"]
    assert data["configSchema"]["type"] == "object"
    assert "browserProfileDir" in data["configSchema"]["properties"]
    assert "taskDbPath" in data["configSchema"]["properties"]

def test_openmuse_package_json_validity():
    """Verify package.json defines the extension export correctly."""
    assert os.path.exists(PACKAGE_JSON_PATH), "package.json must exist"
    with open(PACKAGE_JSON_PATH, "r", encoding="utf-8") as f:
        data = json.load(f)
    assert data["name"] == "@friday/openmuse-engine"
    assert "friday" in data
    assert "./index.ts" in data["friday"]["extensions"]

def test_openmuse_sqlite_schema_compatibility(tmp_path):
    """Verify SQLite database schema compatibility with Python and SQLite 3."""
    db_file = tmp_path / "test_tasks.db"
    conn = sqlite3.connect(str(db_file))
    cur = conn.cursor()

    # Replicate WAL mode and tables
    cur.execute("PRAGMA journal_mode = WAL;")
    cur.execute("""
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        status TEXT NOT NULL,
        input_json TEXT,
        result_json TEXT,
        error TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        max_retries INTEGER NOT NULL DEFAULT 3,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    """)
    cur.execute("""
      CREATE TABLE task_leases (
        task_id TEXT PRIMARY KEY,
        worker_id TEXT NOT NULL,
        lease_expires_at INTEGER NOT NULL,
        heartbeat_at INTEGER NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );
    """)

    # Insert test task and lease
    cur.execute(
        "INSERT INTO tasks (id, category, status, input_json, retry_count, max_retries, created_at, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ("task-001", "browser-navigate", "running", json.dumps({"url": "https://example.com"}), 0, 3, 1000, 1000)
    )
    cur.execute(
        "INSERT INTO task_leases (task_id, worker_id, lease_expires_at, heartbeat_at) "
        "VALUES (?, ?, ?, ?)",
        ("task-001", "worker-1", 50000, 1000)
    )
    conn.commit()

    # Query back
    cur.execute("SELECT t.id, t.status, l.worker_id FROM tasks t JOIN task_leases l ON t.id = l.task_id WHERE t.id = ?", ("task-001",))
    row = cur.fetchone()
    assert row == ("task-001", "running", "worker-1")
    conn.close()
