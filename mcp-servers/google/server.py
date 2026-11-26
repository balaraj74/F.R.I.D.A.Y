#!/usr/bin/env python3
"""FRIDAY Google MCP server: Calendar, Gmail and Tasks as MCP tools.

Runs over stdio (started by FRIDAY's gateway, see `friday mcp list`). Uses Sir's own OAuth
sign-in stored in ~/.friday/google_token.json; `server.py login` runs Google's browser sign-in
(Sir types his password on Google's page, never here) and `server.py check` tests the token.
"""

from __future__ import annotations

import base64
import datetime as dt
import json
import os
import sys
from email.mime.text import MIMEText
from pathlib import Path

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

HOME = Path.home() / ".friday"
TOKEN_FILE = HOME / "google_token.json"
CLIENT_FILE = Path(os.environ.get("FRIDAY_GOOGLE_CLIENT", HOME / "client_secret.json"))
SCOPES = [
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/tasks",
    # The HUD's Workspace panel also uses these; keep both sign-in routes equal.
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/documents",
    "https://www.googleapis.com/auth/spreadsheets",
]
BODY_CAP = 8000


def _save(creds: Credentials) -> None:
    TOKEN_FILE.write_text(creds.to_json())
    os.chmod(TOKEN_FILE, 0o600)


def creds() -> Credentials:
    if not TOKEN_FILE.exists():
        raise RuntimeError("Not signed in to Google. Sir needs to run: friday-google-login")
    c = Credentials.from_authorized_user_file(str(TOKEN_FILE))
    if not c.valid:
        if not c.refresh_token:
            raise RuntimeError("Google sign-in has no refresh token. Sir needs to sign in again.")
        try:
            c.refresh(Request())
        except Exception as e:  # expired/revoked refresh token
            raise RuntimeError(f"Google sign-in expired ({e}). Sir needs to sign in again.") from e
        _save(c)
    return c


def svc(name: str, version: str):
    return build(name, version, credentials=creds(), cache_discovery=False)


def login() -> None:
    from google_auth_oauthlib.flow import InstalledAppFlow

    flow = InstalledAppFlow.from_client_secrets_file(str(CLIENT_FILE), SCOPES)
    c = flow.run_local_server(port=0, open_browser=True, prompt="consent", access_type="offline")
    _save(c)
    print("Signed in to Google. FRIDAY can now use Calendar, Gmail and Tasks.")


# --- helpers -------------------------------------------------------------------------------

def _event(e: dict) -> dict:
    return {
        "id": e.get("id"),
        "summary": e.get("summary", "(no title)"),
        "start": e.get("start", {}).get("dateTime") or e.get("start", {}).get("date"),
        "end": e.get("end", {}).get("dateTime") or e.get("end", {}).get("date"),
        "location": e.get("location"),
        "attendees": len(e.get("attendees", [])),
        "link": e.get("htmlLink"),
    }


def _header(msg: dict, name: str) -> str:
    for h in msg.get("payload", {}).get("headers", []):
        if h.get("name", "").lower() == name.lower():
            return h.get("value", "")
    return ""


def _plain_body(payload: dict) -> str:
    if payload.get("mimeType") == "text/plain" and payload.get("body", {}).get("data"):
        return base64.urlsafe_b64decode(payload["body"]["data"]).decode("utf-8", "replace")
    for part in payload.get("parts", []) or []:
        text = _plain_body(part)
        if text:
            return text
    return ""


# --- MCP tools -----------------------------------------------------------------------------

def make_server():
    import functools

    try:  # mcp >= 2
        from mcp.server.mcpserver import MCPServer as Server
        from mcp.server.mcpserver.exceptions import ToolError
    except ImportError:  # mcp 1.x
        from mcp.server.fastmcp import FastMCP as Server
        from mcp.server.fastmcp.exceptions import ToolError

    server = Server("google")

    class _Tools:
        """`@mcp.tool()` that reports the real reason a call failed (e.g. sign-in expired)."""

        def tool(self):
            def register(fn):
                @functools.wraps(fn)
                def wrapped(*args, **kwargs):
                    try:
                        return fn(*args, **kwargs)
                    except ToolError:
                        raise
                    except Exception as e:
                        raise ToolError(str(e)) from e

                return server.tool()(wrapped)

            return register

    mcp = _Tools()

    @mcp.tool()
    def calendar_upcoming(days: int = 7, max_results: int = 20) -> list[dict]:
        """Sir's upcoming Google Calendar events (primary calendar) for the next `days` days."""
        now = dt.datetime.now(dt.timezone.utc)
        items = (
            svc("calendar", "v3")
            .events()
            .list(
                calendarId="primary",
                timeMin=now.isoformat(),
                timeMax=(now + dt.timedelta(days=max(1, min(days, 60)))).isoformat(),
                singleEvents=True,
                orderBy="startTime",
                maxResults=max(1, min(max_results, 100)),
            )
            .execute()
            .get("items", [])
        )
        return [_event(e) for e in items]

    @mcp.tool()
    def calendar_create_event(summary: str, start: str, end: str, description: str = "", location: str = "") -> dict:
        """Create an event on Sir's primary calendar. start/end: ISO 8601 with timezone offset."""
        body = {"summary": summary, "description": description, "location": location,
                "start": {"dateTime": start}, "end": {"dateTime": end}}
        return _event(svc("calendar", "v3").events().insert(calendarId="primary", body=body).execute())

    @mcp.tool()
    def gmail_search(query: str = "is:unread in:inbox", max_results: int = 10) -> list[dict]:
        """Search Sir's Gmail (Gmail search syntax). Returns sender, subject, date and a snippet."""
        g = svc("gmail", "v1")
        ids = g.users().messages().list(userId="me", q=query, maxResults=max(1, min(max_results, 50))).execute().get("messages", [])
        out = []
        for m in ids:
            msg = g.users().messages().get(userId="me", id=m["id"], format="metadata",
                                           metadataHeaders=["From", "Subject", "Date"]).execute()
            out.append({"id": m["id"], "from": _header(msg, "From"), "subject": _header(msg, "Subject"),
                        "date": _header(msg, "Date"), "snippet": msg.get("snippet", ""),
                        "unread": "UNREAD" in msg.get("labelIds", [])})
        return out

    @mcp.tool()
    def gmail_read(message_id: str) -> dict:
        """Read one email (plain-text body, capped)."""
        msg = svc("gmail", "v1").users().messages().get(userId="me", id=message_id, format="full").execute()
        body = _plain_body(msg.get("payload", {})) or msg.get("snippet", "")
        return {"id": message_id, "from": _header(msg, "From"), "to": _header(msg, "To"),
                "subject": _header(msg, "Subject"), "date": _header(msg, "Date"), "body": body[:BODY_CAP]}

    @mcp.tool()
    def gmail_send(to: str, subject: str, body: str) -> dict:
        """Send an email from Sir's Gmail. Only when Sir explicitly asked for this exact email."""
        mime = MIMEText(body)
        mime["to"], mime["subject"] = to, subject
        raw = base64.urlsafe_b64encode(mime.as_bytes()).decode()
        sent = svc("gmail", "v1").users().messages().send(userId="me", body={"raw": raw}).execute()
        return {"sent": True, "id": sent.get("id"), "to": to}

    @mcp.tool()
    def tasks_list(max_results: int = 20) -> list[dict]:
        """Sir's open Google Tasks (default list)."""
        items = svc("tasks", "v1").tasks().list(tasklist="@default", showCompleted=False,
                                                maxResults=max(1, min(max_results, 100))).execute().get("items", [])
        return [{"id": t["id"], "title": t.get("title"), "notes": t.get("notes"), "due": t.get("due")} for t in items]

    @mcp.tool()
    def tasks_add(title: str, notes: str = "", due: str = "") -> dict:
        """Add a task to Sir's default Google Tasks list. due: RFC 3339 date-time (optional)."""
        body = {"title": title, "notes": notes}
        if due:
            body["due"] = due
        t = svc("tasks", "v1").tasks().insert(tasklist="@default", body=body).execute()
        return {"id": t["id"], "title": t.get("title"), "due": t.get("due")}

    return server


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "serve"
    if cmd == "login":
        login()
    elif cmd == "check":
        try:
            svc("calendar", "v3").events().list(calendarId="primary", maxResults=1).execute()
            print(json.dumps({"ok": True}))
        except Exception as e:
            print(json.dumps({"ok": False, "error": str(e)[:300]}))
            sys.exit(1)
    else:
        make_server().run()
