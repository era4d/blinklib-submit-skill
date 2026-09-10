#!/usr/bin/env python3
"""Fixed Blink image-upload workflow using the official Chrome DevTools MCP.

Python 3.10+ stdlib only. Reuses the bundled Node API client and an existing
Chrome session via chrome-devtools-mcp --autoConnect. Never launches a new profile.
"""
from __future__ import annotations

import argparse
from collections import deque
import hashlib
import json
import os
from pathlib import Path
import queue
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unicodedata
from urllib.parse import urlsplit, urlunsplit

VERSION = "1.9.0"
MCP_PACKAGE = "chrome-devtools-mcp@1.8.0"
HERE = Path(__file__).resolve().parent
PURPOSE_FIELDS = {"logo": "logoUrl", "preview": "previewImageUrl", "screenshots": "screenshotUrls"}


class Blocked(Exception):
    def __init__(self, status, message, **details):
        super().__init__(message)
        self.result = {"status": status, "message": message, **details}


def safe_text(value):
    """Never print credentials or signed asset/OAuth query strings."""
    value = re.sub(r"https?://[^\s\"<>]+", lambda m: m[0].split("?")[0].split("#")[0], str(value))
    value = re.sub(r"Bearer\s+\S+", "Bearer [redacted]", value, flags=re.I)
    return value


def clean_output(value):
    if isinstance(value, dict):
        return {k: clean_output(v) for k, v in value.items() if k.lower() not in {"apikey", "authorization", "accesstoken"}}
    if isinstance(value, list):
        return [clean_output(v) for v in value]
    return safe_text(value) if isinstance(value, str) else value


def progress(message):
    print(message, file=sys.stderr, flush=True)


def web_url(value):
    parts = urlsplit(value)
    if parts.scheme not in {"http", "https"} or not parts.hostname or parts.username or parts.password:
        raise Blocked("invalid_target", "Provide the authorized submission page's HTTP(S) URL.")
    return value


def normalize_url(value):
    parts = urlsplit(value)
    return urlunsplit((parts.scheme.lower(), parts.netloc.lower(), parts.path or "/", parts.query, ""))


def preference_path():
    override = os.environ.get("BLINK_BROWSER_PREFERENCES_PATH")
    if override:
        return Path(override).expanduser().resolve()
    if os.name == "nt":
        base = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        base = Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local" / "state"))
    return base / "blink-backlink-submit" / "login-preferences.json"


def load_preferences():
    path = preference_path()
    if not path.exists():
        return {"version": 1, "sites": {}}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        if value.get("version") != 1 or not isinstance(value.get("sites"), dict) or not isinstance(value.get("defaultGoogleAccount", ""), str):
            raise ValueError("Unsupported preference schema")
        if any(not isinstance(site, dict) or not isinstance(site.get("accountEmail", ""), str) or not isinstance(site.get("registrationAllowed", False), bool) for site in value["sites"].values()):
            raise ValueError("Unsupported site preference")
        return value
    except (ValueError, AttributeError) as error:
        raise Blocked("invalid_login_preferences", "Saved login preferences are invalid; preserve the file and repair it before continuing.") from error


def login_preference(url):
    host = urlsplit(web_url(url)).hostname.lower()
    data = load_preferences()
    site = data["sites"].get(host, {})
    return {"host": host, "provider": "google", "accountEmail": site.get("accountEmail", data.get("defaultGoogleAccount", "")), "registrationAllowed": site.get("registrationAllowed") is True}


def remember_login(args):
    host = urlsplit(web_url(args.url)).hostname.lower()
    email = args.account_email.strip().casefold()
    if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email):
        raise Blocked("invalid_account_email", "Provide the Google account explicitly chosen by the user.")
    data = load_preferences()
    previous = data["sites"].get(host, {})
    # A different identity never inherits another account's registration grant.
    site = dict(previous) if previous.get("accountEmail") == email else {}
    site.update({"accountEmail": email, "provider": "google", "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
    if args.registration != "unchanged":
        site["registrationAllowed"] = args.registration == "allowed"
    data["sites"][host] = site
    if args.as_default:
        data["defaultGoogleAccount"] = email
    path = preference_path()
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(prefix=".login-", suffix=".json", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(data, stream, ensure_ascii=False, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return {"status": "login_preference_saved", **login_preference(args.url)}


def mcp_command(browser_url=None):
    node = shutil.which("node")
    npx = shutil.which("npx.cmd" if os.name == "nt" else "npx")
    if not node or not npx:
        raise Blocked("missing_dependency", "Install Node.js with npm/npx; then rerun this same command.")
    connection = ["--browserUrl", browser_url] if browser_url else ["--autoConnect"]
    if os.name == "nt":
        # Invoke the installed npx JS entry directly, avoiding cmd.exe quoting.
        entry = Path(npx).parent / "node_modules" / "npm" / "bin" / "npx-cli.js"
        if not entry.is_file():
            raise Blocked("missing_dependency", "The Node installation lacks npm/bin/npx-cli.js. Repair npm and retry.")
        return [node, str(entry), "-y", MCP_PACKAGE, *connection]
    return [npx, "-y", MCP_PACKAGE, *connection]


class McpClient:
    """Newline-delimited JSON-RPC over stdio, with bounded waits and narrow roots."""
    def __init__(self, command, staging_root, timeout=90):
        self.root = Path(staging_root).resolve()
        self.timeout = timeout
        self.counter = 0
        self.inbox = queue.Queue()
        self.errors = deque(maxlen=10)
        self.tools = {}
        env = dict(os.environ)
        for key in list(env):
            if key.startswith("BLINK_"):
                env.pop(key)
        self.proc = subprocess.Popen(
            command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8", errors="replace", bufsize=1, env=env,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        self.read_thread = threading.Thread(target=self._read, daemon=True)
        self.error_thread = threading.Thread(target=self._stderr, daemon=True)
        self.read_thread.start()
        self.error_thread.start()

    def _read(self):
        try:
            for line in self.proc.stdout:
                try:
                    self.inbox.put(json.loads(line))
                except ValueError:
                    # A CLI banner is not a protocol response.
                    self.errors.append(safe_text(line[:1000]))
        finally:
            self.inbox.put(None)

    def _stderr(self):
        for line in self.proc.stderr:
            self.errors.append(safe_text(line[:1000]))

    def send(self, message):
        try:
            self.proc.stdin.write(json.dumps(message, ensure_ascii=False) + "\n")
            self.proc.stdin.flush()
        except (OSError, ValueError):
            raise Blocked("chrome_connection_failed", "Chrome MCP disconnected. Return browser_failure without requesting user action or opening another browser.")

    def request(self, method, params):
        self.counter += 1
        request_id = self.counter
        self.send({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
        deadline = time.monotonic() + self.timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise Blocked("mcp_timeout", f"Chrome MCP timed out during {method}. No action was retried.", diagnostic=" ".join(self.errors))
            try:
                item = self.inbox.get(timeout=min(remaining, 15))
            except queue.Empty:
                progress(f"Waiting for Chrome MCP: {method}")
                continue
            if item is None:
                raise Blocked("chrome_connection_failed", "Chrome MCP exited before replying.", diagnostic=" ".join(self.errors))
            if "method" in item and "id" in item:
                if item["method"] == "roots/list":
                    self.send({"jsonrpc": "2.0", "id": item["id"], "result": {"roots": [{"uri": self.root.as_uri(), "name": "Blink task images"}]}})
                else:
                    self.send({"jsonrpc": "2.0", "id": item["id"], "error": {"code": -32601, "message": "Unsupported client request"}})
                continue
            if item.get("id") != request_id:
                continue
            if "error" in item:
                raise Blocked("mcp_error", safe_text(item["error"].get("message", "MCP request failed")))
            return item.get("result", {})

    def initialize(self):
        self.request("initialize", {"protocolVersion": "2025-03-26", "capabilities": {"roots": {"listChanged": False}}, "clientInfo": {"name": "blink-browser", "version": VERSION}})
        self.send({"jsonrpc": "2.0", "method": "notifications/initialized"})
        cursor = None
        while True:
            result = self.request("tools/list", {"cursor": cursor} if cursor else {})
            self.tools.update({tool["name"]: tool for tool in result.get("tools", [])})
            cursor = result.get("nextCursor")
            if not cursor:
                break
        for name in ["list_pages", "new_page", "take_snapshot", "upload_file"]:
            if name not in self.tools:
                raise Blocked("incompatible_browser", f"Chrome MCP does not expose {name}.")

    def call(self, name, **arguments):
        # Only repeat reads after a navigation race. A timed-out mutation may
        # already have reached the site and must never be replayed here.
        for attempt in range(3):
            try:
                return self._call_once(name, **arguments)
            except Blocked as error:
                transient = re.search(r"execution context was destroyed|cannot find context|frame was detached|document is not ready", str(error), re.I)
                if name not in {"list_pages", "take_snapshot"} or not transient or attempt == 2:
                    raise
                time.sleep(0.3 * (attempt + 1))

    def _call_once(self, name, **arguments):
        if name not in self.tools:
            raise Blocked("incompatible_browser", f"Chrome MCP does not expose {name}.")
        schema = self.tools[name].get("inputSchema", {})
        if any(key not in schema.get("properties", {}) for key in arguments):
            raise Blocked("incompatible_browser", f"Unexpected {name} tool schema; update the packaged adapter before continuing.")
        result = self.request("tools/call", {"name": name, "arguments": arguments})
        text = "\n".join(block.get("text", "") for block in result.get("content", []) if block.get("type") == "text")
        if result.get("isError") or re.match(r"^(?:Error:|Access denied:)", text):
            status = "upload_access_denied" if "Access denied" in text else "browser_action_failed"
            raise Blocked(status, safe_text(text))
        return text

    def close(self):
        # End only this client/server process. Never close the user's Chrome.
        if self.proc.stdin:
            try:
                self.proc.stdin.close()
            except OSError:
                pass
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(timeout=5)
        self.read_thread.join(timeout=2)
        self.error_thread.join(timeout=2)
        if not self.read_thread.is_alive():
            self.proc.stdout.close()
        if not self.error_thread.is_alive():
            self.proc.stderr.close()


def pages_from(text):
    pages = []
    for line in text.splitlines():
        match = re.match(r"^(\d+): (.*?) \(((?:https?://|about:).*)\)(?: \[selected\])?$", line)
        if match:
            pages.append({"id": int(match[1]), "title": match[2], "url": match[3]})
    return pages


def get_page(client, url, create=False):
    pages = pages_from(client.call("list_pages"))
    if not hasattr(client, "page_bindings"):
        client.page_bindings = {}
    key = normalize_url(url)
    bound = client.page_bindings.get(key)
    if bound is not None:
        page = next((page for page in pages if page["id"] == bound), None)
        if not page:
            raise Blocked("page_closed", "The task's tab was closed. Inspect existing tabs before explicitly opening another task session.")
        original, current = urlsplit(url), urlsplit(page["url"])
        if (original.scheme, original.netloc) != (current.scheme, current.netloc):
            raise Blocked("page_origin_changed", "The bound tab moved to another origin. Inspect its current URL before continuing.")
        return page
    matches = [page for page in pages if normalize_url(page["url"]) == normalize_url(url)]
    if len(matches) > 1:
        raise Blocked("ambiguous_page", "Multiple tabs match this URL. Keep one submission tab before retrying.")
    if matches:
        client.page_bindings[key] = matches[0]["id"]
        return matches[0]
    if not create:
        raise Blocked("page_not_found", "Submission tab was not found. Run open with its exact current URL first.")
    opened = pages_from(client.call("new_page", url=url, background=False))
    # Track the new tab by its ID even if the user changes the selected tab.
    before_ids = {page["id"] for page in pages}
    created = [page for page in opened if page["id"] not in before_ids]
    if len(created) == 1:
        client.page_bindings[key] = created[0]["id"]
        return created[0]
    fresh = client.call("list_pages")
    created = [page for page in pages_from(fresh) if page["id"] not in before_ids]
    if len(created) != 1:
        raise Blocked("ambiguous_page", "Chrome opened a tab but could not uniquely identify it. Inspect before opening another tab.")
    client.page_bindings[key] = created[0]["id"]
    return created[0]


def elements(snapshot):
    result = []
    for line in snapshot.splitlines():
        match = re.match(r'^\s*uid=(\S+)\s+(\S+)(?:\s+"((?:\\.|[^"\\])*)")?', line)
        if match:
            result.append({"uid": match[1], "role": match[2], "name": match[3] or "", "line": line})
    return result


def purpose_of(label):
    label = unicodedata.normalize("NFKC", label).lower()
    patterns = {
        "logo": r"\b(?:logos?|icons?|favicons?)\b|图标|標誌|标志|商标",
        "preview": r"\b(?:banners?|covers?|previews?|hero\s+images?)\b|封面|横幅|橫幅|预览图|預覽圖",
        "screenshots": r"\b(?:screen[\s-]?shots?|gallery)\b|截图|截圖|画廊|圖庫|图库",
    }
    matches = [key for key, pattern in patterns.items() if re.search(pattern, label)]
    return matches[0] if len(matches) == 1 else None


def find_upload(snapshot, purpose, field_label=None):
    candidates = []
    nearby = None
    nearby_depth = None
    for item in elements(snapshot):
        role, name = item["role"], item["name"]
        depth = len(item["line"]) - len(item["line"].lstrip())
        if role in {"RootWebArea", "Iframe", "dialog"} or (nearby_depth is not None and depth < nearby_depth):
            nearby = None
        inferred = purpose_of(name)
        if role in {"StaticText", "heading"} and inferred:
            nearby = name
            nearby_depth = depth
        elif role in {"textbox", "combobox", "checkbox", "heading"}:
            nearby = None
        if role != "button" or re.search(r"\bdisabled\b", item["line"]):
            continue
        if re.search(r"\b(?:remove|delete|download)\b|删除|移除|下载", name, re.I):
            nearby = None
            continue
        if inferred == purpose:
            candidates.append({**item, "fieldLabel": name, "rank": 3 if "value=" in item["line"] else 1})
        elif re.search(r"choose.*(?:file|photo|image)|browse.*file|upload|选择文件|选择图片|上传|拖拽", name, re.I) and nearby and purpose_of(nearby) == purpose:
            candidates.append({**item, "fieldLabel": nearby, "rank": 2})
        elif inferred or re.search(r"next|submit|continue|下一步|提交", name, re.I):
            nearby = None
    if field_label:
        candidates = [item for item in candidates if item["fieldLabel"].casefold() == field_label.casefold()]
    if not candidates:
        raise Blocked("upload_field_not_found", f"No unambiguous {purpose} upload field is visible. Inspect the page or complete its login/previous step.")
    rank = max(item["rank"] for item in candidates)
    candidates = [item for item in candidates if item["rank"] == rank]
    if len(candidates) != 1:
        raise Blocked("ambiguous_upload_field", "Multiple matching fields are visible. Use --field-label with an exact observed label.", labels=[item["fieldLabel"] for item in candidates])
    return candidates[0]


def prepare_assets(args, page, field, staging_root):
    node = shutil.which("node")
    if not node:
        raise Blocked("missing_dependency", "Node.js is required by the bundled Blink API client.")
    command = [node, str(HERE / "blink-automation.mjs"), "prepare-upload",
               "--project-id", args.project_id, "--purpose", args.purpose,
               "--field-label", field["fieldLabel"], "--page-id", str(page["id"]), "--uid", field["uid"],
               "--browser-filesystem", "shared", "--output-dir", str(staging_root),
               "--max-size-mb", str(args.max_size_mb), "--required-count", str(args.required_count)]
    if args.connection:
        command.extend(["--connection", str(Path(args.connection).resolve())])
    try:
        response = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=240)
    except subprocess.TimeoutExpired:
        raise Blocked("asset_download_failed", "The Blink asset preparation timed out. No browser upload was attempted.")
    if response.returncode:
        status = "blink_auth_failed" if "Unauthorized" in response.stderr else "asset_download_failed"
        message = "The bundled Blink connection is not authorized. Download a fresh Skill from the intended Blink account." if status == "blink_auth_failed" else "The Blink API or image download failed; no upload was attempted."
        raise Blocked(status, message, diagnostic=safe_text(response.stderr[-1800:]))
    prepared = json.loads(response.stdout)
    for file in prepared.get("files", []):
        path = Path(file["path"]).resolve(strict=True)
        if not path.is_relative_to(staging_root.resolve()):
            raise Blocked("asset_path_mismatch", "Downloaded image escaped the task staging directory.")
        if file.get("assetPurpose") != args.purpose or file.get("sourceField") != PURPOSE_FIELDS[args.purpose]:
            raise Blocked("asset_purpose_mismatch", "Prepared image source does not match the upload field.")
        if hashlib.sha256(path.read_bytes()).hexdigest() != file["sha256"]:
            raise Blocked("asset_content_changed", "Prepared image bytes changed before upload.")
    return prepared


def upload(client, args, staging_root):
    page = get_page(client, args.url)
    field = find_upload(client.call("take_snapshot", pageId=page["id"]), args.purpose, args.field_label)
    if not hasattr(client, "upload_attempts"):
        client.upload_attempts = {}
    attempt_key = (page["id"], normalize_url(page["url"]), args.project_id, args.purpose, field["fieldLabel"])
    previous = client.upload_attempts.get(attempt_key)
    if previous and not args.replace:
        return {**previous, "reusedAttempt": True, "retryAllowed": False}
    def guard_existing(item):
        value = re.search(r'\bvalue="([^"]*)"', item["line"])
        if value and value[1] and not re.search(r"no file|未选择|未選擇|没有选择|沒有選擇", value[1], re.I) and not args.replace:
            raise Blocked("existing_attachment", "This field already has a selected file. Inspect it; use --replace only to correct that specific attachment.")
    guard_existing(field)
    progress(f"Matched {args.purpose} field: {field['fieldLabel']}. Fetching the matching Blink asset.")
    prepared = prepare_assets(args, page, field, staging_root)
    files = prepared.get("files", [])
    if not files:
        return {"status": "missing_asset", "uploaded": False, "purpose": args.purpose, "message": "The fresh API response contains no image for this purpose. Supply the matching image; no preview/Logo substitution was made."}
    # Refresh after network work; never send the old UID to a changed page.
    refreshed = get_page(client, args.url)
    if normalize_url(refreshed["url"]) != normalize_url(page["url"]):
        raise Blocked("upload_page_changed", "The form navigated while images were downloading. Inspect the new step before uploading.")
    before_snapshot = client.call("take_snapshot", pageId=page["id"])
    current = find_upload(before_snapshot, args.purpose, field["fieldLabel"])
    guard_existing(current)
    expected = [file["fileName"] for file in files]
    before_names = {item["name"] for item in elements(before_snapshot) if item["role"] in {"StaticText", "image"}}
    uncertain = {"status": "upload_unconfirmed", "uploaded": False, "selected": False, "retryAllowed": False, "message": "Upload was attempted. Inspect this field before retrying; use --replace only after resolving its actual state."}
    client.upload_attempts[attempt_key] = uncertain
    def remember(result):
        client.upload_attempts[attempt_key] = result
        return result
    progress(f"Uploading {len(files)} {args.purpose} image(s) through Chrome.")
    client.call("upload_file", pageId=page["id"], uid=current["uid"], filePaths=[file["path"] for file in files], includeSnapshot=True)
    deadline = time.monotonic() + args.upload_timeout
    selected = False
    while time.monotonic() < deadline:
        snapshot = client.call("take_snapshot", pageId=page["id"])
        selected = all(name in snapshot for name in expected)
        if re.search(r"upload failed|unsupported file|file (?:is )?too large|上传失败|格式不支持", snapshot, re.I):
            return remember({"status": "site_upload_rejected", "uploaded": False, "selected": selected, "message": "The page reports a file validation/upload error. Inspect the field before retrying."})
        controls = elements(snapshot)
        if selected and any(item["role"] == "dialog" and re.search(r"photo|image|crop|图片|裁剪", item["name"], re.I) for item in controls):
            return remember({"status": "upload_needs_confirmation", "uploaded": False, "selected": True, "message": "The image editor still requires review/crop/save. Complete that dialog and verify the attachment before advancing.", "snapshot": snapshot})
        attached = {item["name"] for item in elements(snapshot) if item["role"] in {"StaticText", "image"}}
        busy = re.search(r"Uploading|上传中|处理中", snapshot, re.I) or any(item["role"] == "progressbar" for item in controls)
        if all(name in attached - before_names for name in expected) and not busy:
            return remember({"status": "uploaded", "uploaded": True, "purpose": args.purpose, "fieldLabel": current["fieldLabel"], "files": expected, "missingCount": prepared["missingCount"], "downloadErrors": prepared.get("downloadErrors", []), "nextAction": prepared["afterUploadAction"]})
        time.sleep(1)
    return remember({**uncertain, "selected": selected})


def google_signin_controls(snapshot, allow_registration=False):
    """Recognize personalized GIS buttons only inside Google's observed frame."""
    controls = []
    frames = []
    for item in elements(snapshot):
        depth = len(item["line"]) - len(item["line"].lstrip())
        while frames and depth <= frames[-1][0]:
            frames.pop()
        if item["role"] == "RootWebArea":
            match = re.search(r'\burl="([^"]+)"', item["line"])
            origin = urlsplit(match[1]) if match else None
            trusted = bool(origin and origin.scheme == "https" and origin.hostname == "accounts.google.com" and origin.path == "/gsi/button")
            frames.append((depth, trusted))
        if item["role"] not in {"button", "link"} or re.search(r"\bdisabled\b", item["line"]):
            continue
        standard = re.search(r"(?:sign in|log in|login|continue|登录|登入|继续|繼續).*google|google.*(?:sign in|login|continue|登录|登入|继续|繼續)", item["name"], re.I)
        personalized = frames and frames[-1][1] and re.search(r"continue as\b|以.+(?:继续|繼續)", item["name"], re.I)
        registration = allow_registration and re.search(r"(?:register|sign up|注册|註冊).*google|google.*(?:register|sign up|注册|註冊)", item["name"], re.I)
        if standard or personalized or registration:
            controls.append(item)
    return controls


def authenticated_snapshot(snapshot):
    controls = elements(snapshot)
    login_prompt = any(item["role"] in {"button", "link", "heading", "dialog"} and re.fullmatch(r"sign in|log in|login|登录|登入", item["name"].strip(), re.I) for item in controls)
    return not login_prompt and not google_signin_controls(snapshot) and any(
        item["role"] in {"link", "button", "menuitem"} and not re.search(r"\bdisabled\b", item["line"])
        and re.fullmatch(r"sign out|log out|logout|退出登录|登出", item["name"].strip(), re.I)
        for item in controls
    )


def inspect_account_menu(client, page_id, snapshot, inspected):
    # Account + Dashboard alone also occur on logged-out sites. Open only an
    # observed account menu and require a real sign-out item as evidence.
    if page_id in inspected or google_signin_controls(snapshot):
        return snapshot
    menus = [item for item in elements(snapshot) if item["role"] == "button"
             and re.fullmatch(r"account|my account|profile|user menu|账户|账号|个人资料", item["name"].strip(), re.I)
             and 'haspopup="menu"' in item["line"] and "expanded" not in item["line"]
             and not re.search(r"\bdisabled\b", item["line"])]
    if len(menus) == 1:
        inspected.add(page_id)
        client.call("click", pageId=page_id, uid=menus[0]["uid"], includeSnapshot=False)
        return client.call("take_snapshot", pageId=page_id)
    return snapshot


def google_login(client, args):
    preference = login_preference(args.url)
    def is_google(url):
        parsed = urlsplit(url)
        return parsed.scheme == "https" and parsed.hostname == "accounts.google.com"

    # Keep the original tab and popup identity across commands in this session.
    # Reissuing google-login resumes observation, never creates a duplicate popup.
    if not hasattr(client, "google_attempts"):
        client.google_attempts = {}
    key = normalize_url(args.url)
    state = client.google_attempts.get(key)
    if state is None:
        page = get_page(client, args.url)
        before_pages = pages_from(client.call("list_pages"))
        before_ids = {p["id"] for p in before_pages}
        snapshot = client.call("take_snapshot", pageId=page["id"])
        inspected = set()
        snapshot = inspect_account_menu(client, page["id"], snapshot, inspected)
        if authenticated_snapshot(snapshot):
            return {"status": "login_completed", "pageUrl": page["url"], "evidence": "Visible sign-out control; Google login prompt absent."}
        if any(is_google(p["url"]) for p in before_pages):
            return {"status": "existing_google_window", "message": "An existing Google window prevents a unique attempt. Close this task tab, leave unrelated windows unchanged, defer, and continue."}
        buttons = google_signin_controls(snapshot, allow_registration=preference["registrationAllowed"])
        if len(buttons) != 1:
            return {"status": "login_inspection_required", "message": "No unique Google sign-in control is visible. Close this task tab, defer, and continue without asking.", "snapshot": snapshot}
        state = {"sourceId": page["id"], "beforeIds": before_ids, "providerId": None, "accountSelected": False, "trace": [], "inspectedMenus": inspected}
        client.google_attempts[key] = state
        state["trace"].append({"stage": "google_button_clicked", "pageId": page["id"]})
        client.call("click", pageId=page["id"], uid=buttons[0]["uid"], includeSnapshot=False)

    def outcome(status, message, **extra):
        return {"status": status, "message": message, "sourcePageId": state["sourceId"], "googlePageId": state["providerId"], "accountSelected": state["accountSelected"], "trace": list(state["trace"]), **extra}

    returned_polls = 0
    last_snapshot = ""
    deadline = time.monotonic() + args.login_timeout
    for _ in range(args.login_timeout):
        if time.monotonic() >= deadline:
            break
        pages = pages_from(client.call("list_pages"))
        source = next((p for p in pages if p["id"] == state["sourceId"]), None)
        if state["providerId"] is None:
            providers = [p for p in pages if is_google(p["url"]) and (p["id"] == state["sourceId"] or p["id"] not in state["beforeIds"])]
            if len(providers) > 1:
                return outcome("ambiguous_google_window", "Multiple new Google pages appeared. Close this task's pages, defer, and continue.")
            if len(providers) == 1:
                state["providerId"] = providers[0]["id"]
                state["trace"].append({"stage": "google_window_detected", "pageId": state["providerId"]})
                progress(f"Google login window detected: page {state['providerId']}; waiting for account controls.")
                client.call("select_page", pageId=state["providerId"], bringToFront=True)
        provider = next((p for p in pages if p["id"] == state["providerId"] and is_google(p["url"])), None)
        if provider:
            returned_polls = 0
            try:
                snapshot = client.call("take_snapshot", pageId=provider["id"])
            except Blocked as error:
                if not re.search(r"no page found|target closed|has been closed", str(error), re.I):
                    raise
                time.sleep(1)
                continue
            last_snapshot = snapshot
            # A newly opened page can be blank/loading. Wait for its real a11y
            # controls; never click an email elsewhere based on a stale URL.
            root = next((e for e in elements(snapshot) if e["role"] == "RootWebArea"), None)
            root_url = re.search(r'\burl="([^"]+)"', root["line"]) if root else None
            if root_url and not is_google(root_url[1]):
                time.sleep(1)
                continue
            if re.search(r'password|passkey|security key|verification code|verify your identity|验证码|驗證碼|密码|密碼|安全密钥|确认您的身份', snapshot, re.I):
                return outcome("awaiting_user_login", "Authentication was not confirmed. Close this task's Google and source tabs, defer it, and continue the queue.")
            if re.search(r'access blocked|couldn.t sign you in|访问被阻止|无法登录|無法登入', snapshot, re.I):
                return outcome("google_login_rejected", "Google displays a sign-in error. Close this task's pages, defer, and continue.")
            chooser = "accountchooser" in urlsplit(provider["url"]).path.lower() or re.search(r'heading "(?:Choose an account|选择账号|選擇帳戶)', snapshot, re.I)
            accounts = [e for e in elements(snapshot) if e["role"] in {"link", "button"} and re.search(r"[^\s@]+@[^\s@]+\.[^\s@]+", e["name"]) and not re.search(r"signed out|已退出|已登出|\bdisabled\b", e["line"], re.I)]
            if chooser and not state["accountSelected"]:
                preferred = preference["accountEmail"]
                matching = [e for e in accounts if preferred and preferred in [address.casefold().rstrip(".,，。") for address in re.findall(r"[^\s@,，。]+@[^\s@,，。]+\.[^\s@,，。]+", e["name"])]]
                if preferred and accounts and len(matching) != 1:
                    return outcome("preferred_google_account_unavailable", "The saved Google account is absent or ambiguous. Close this task's pages, defer, and continue.")
                if not preferred and len(accounts) > 1:
                    return outcome("awaiting_account_choice", "Multiple signed-in Google accounts are ambiguous. Close this task's pages, defer, and continue without asking.")
                selected = matching[0] if len(matching) == 1 else accounts[0] if len(accounts) == 1 else None
                if selected:
                    state["accountSelected"] = True
                    state["trace"].append({"stage": "google_account_selected", "pageId": provider["id"], "selectionSource": "saved_preference" if preferred else "sole_signed_in_account"})
                    client.call("click", pageId=provider["id"], uid=selected["uid"], includeSnapshot=False)
                    progress("Selected the saved or sole signed-in Google account. Waiting for the callback to the original site.")
            elif not chooser and any(e["role"] in {"button", "link"} and re.fullmatch(r"continue|allow|继续|繼續|允许|允許", e["name"], re.I) for e in elements(snapshot)):
                return outcome("google_consent_required", "Consent review prevents automatic login. Close this task's pages, defer, and continue.", snapshot=snapshot)
        elif source and not is_google(source["url"]):
            snapshot = client.call("take_snapshot", pageId=source["id"])
            last_snapshot = snapshot
            snapshot = inspect_account_menu(client, source["id"], snapshot, state["inspectedMenus"])
            if authenticated_snapshot(snapshot):
                state["trace"].append({"stage": "site_login_verified", "pageId": source["id"]})
                client.call("select_page", pageId=source["id"], bringToFront=True)
                return outcome("login_completed", "The original site shows a sign-out control and no Google login prompt.", pageUrl=source["url"])
            if state["providerId"] is not None:
                returned_polls += 1
                if returned_polls >= 5:
                    client.call("select_page", pageId=source["id"], bringToFront=True)
                    state["trace"].append({"stage": "returned_to_source", "pageId": source["id"]})
                    if google_signin_controls(snapshot):
                        return outcome("login_not_completed", "Google returned but authentication was not confirmed. Close the task tab, defer, and continue.")
                    return outcome("login_callback_unconfirmed", "Authentication is inconclusive. Close the task tab, defer, and continue.", pageUrl=source["url"], snapshot=snapshot)
        elif not source and not provider:
            return outcome("login_source_closed", "The original submission tab closed. Close task-related provider windows, defer, and continue.")
        time.sleep(1)
    return outcome("google_login_pending", "Login was not confirmed before timeout. Close this task's pages, defer, and continue.", snapshot=last_snapshot)


def submission_receipt(snapshot):
    """Conservative, explicit receipts. Generic thanks/navigation is not proof."""
    controls = elements(snapshot)
    if any(item["role"] == "progressbar" for item in controls):
        return None
    visible = [item["name"].strip() for item in controls if item["role"] in {"heading", "StaticText", "alert", "status"}]
    patterns = [
        ("awaiting_email_verification", r"(?:please )?(?:verify|confirm) your email (?:address )?to (?:complete|finish) (?:your |the )?submission[.!]?|请验证邮箱以完成提交[。！]?"),
        ("awaiting_approval", r"(?:your |the )?(?:submission|listing|product) (?:is |has been )?(?:pending review|awaiting approval|submitted for review)[.!]?|提交成功[，, ]*等待审核[。！]?"),
        ("submitted", r"your (?:edits|submission|listing|product) (?:have|has) been submitted[.!]?|(?:submission|listing|product) (?:submitted|received) successfully[.!]?|提交成功[。！]?"),
    ]
    for status, pattern in patterns:
        for value in visible:
            if re.fullmatch(pattern, value, re.I):
                return {"status": status, "exactResult": value, "evidenceType": "submission_receipt"}
    return None


def check_result(client, args):
    # Read-only post-submit observation. Never repeat the submit action and
    # never promote a receipt to 'published' without public listing evidence.
    last_snapshot = ""
    deadline = time.monotonic() + args.result_timeout
    for _ in range(args.result_timeout):
        if time.monotonic() >= deadline:
            break
        page = get_page(client, args.url)
        last_snapshot = client.call("take_snapshot", pageId=page["id"])
        receipt = submission_receipt(last_snapshot)
        if receipt:
            return {**receipt, "pageUrl": safe_text(page["url"]), "evidenceUrl": safe_text(page["url"]), "observedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "retryAllowed": False}
        time.sleep(1)
    return {"status": "submission_outcome_unknown", "retryAllowed": False, "message": "No explicit submission receipt was observed. Inspect validation, login, verification and the actual public listing before deciding the outcome. Do not submit again.", "snapshot": last_snapshot}


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", action="version", version=VERSION)
    parser.add_argument("--browser-url", help="Optional preconfigured conventional loopback CDP HTTP endpoint; native Chrome autoConnect is the default.")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("session", help="Keep one Chrome connection for newline-delimited JSON commands on stdin.")
    sub.add_parser("_serve", help=argparse.SUPPRESS)
    sub.add_parser("session-status", help="Read persistent connection status without starting Chrome.")
    sub.add_parser("session-stop", help="Explicitly end the persistent MCP connection; preserve Chrome.")
    sub.add_parser("browser-tools", help="Read this connection's supported tool schemas before using browser-call.")
    bridge = sub.add_parser("browser-call", help="Use a supported browser tool through the same persistent MCP connection.")
    bridge.add_argument("--tool", required=True, choices=["list_pages", "select_page", "take_snapshot", "click", "fill", "fill_form", "press_key", "hover", "evaluate_script", "take_screenshot"])
    bridge.add_argument("--arguments-json", default="{}", help="Exact JSON arguments matching this MCP tool's schema; never mix page/UIDs from another connection.")
    sub.add_parser("doctor", help="Connect to existing Chrome and check required tools.")
    preferences = sub.add_parser("login-preferences", help="Read the current user's saved login choice without starting Chrome.")
    preferences.add_argument("--url", required=True)
    remember = sub.add_parser("remember-login", help="Persist an explicitly authorized account choice and site-specific registration decision.")
    remember.add_argument("--url", required=True)
    remember.add_argument("--account-email", required=True)
    remember.add_argument("--registration", choices=["allowed", "denied", "unchanged"], default="unchanged")
    remember.add_argument("--as-default", action="store_true", help="Use this explicitly chosen Google account by default on other sites too.")
    for name in ["open", "inspect", "google-login", "check-result"]:
        command = sub.add_parser(name)
        command.add_argument("--url", required=True)
        if name == "google-login":
            command.add_argument("--login-timeout", type=int, default=45, choices=range(1, 121), metavar="SECONDS")
        if name == "check-result":
            command.add_argument("--result-timeout", type=int, default=15, choices=range(1, 121), metavar="SECONDS")
    command = sub.add_parser("upload")
    command.add_argument("--url", required=True)
    command.add_argument("--project-id", required=True)
    command.add_argument("--purpose", required=True, choices=list(PURPOSE_FIELDS))
    command.add_argument("--field-label", help="Disambiguate repeated fields with their exact observed label.")
    command.add_argument("--replace", action="store_true", help="Replace an observed incorrect attachment in this specific field.")
    command.add_argument("--connection", help="Optional existing Blink connection file; defaults to the bundled file.")
    command.add_argument("--max-size-mb", type=float, default=5)
    command.add_argument("--required-count", type=int, default=0)
    command.add_argument("--upload-timeout", type=float, default=45)
    args = parser.parse_args(argv)
    if args.browser_url:
        endpoint = urlsplit(web_url(args.browser_url))
        if endpoint.scheme != "http" or endpoint.hostname not in {"localhost", "127.0.0.1", "::1"} or endpoint.path not in {"", "/"} or endpoint.query or endpoint.fragment:
            parser.error("--browser-url must be the observed local Chrome debugging HTTP origin.")
    if hasattr(args, "url"):
        web_url(args.url)
    if args.command == "upload" and (not 0 < args.max_size_mb <= 20 or not 0 < args.upload_timeout <= 120 or not 0 <= args.required_count <= (5 if args.purpose == "screenshots" else 1)):
        parser.error("Invalid size, timeout or required count.")
    return args


def execute(client, args, staging_root):
    if args.command == "login-preferences":
        return {"status": "login_preferences", **login_preference(args.url)}
    if args.command == "remember-login":
        return remember_login(args)
    if args.command == "browser-tools":
        return {"status": "browser_result", "tools": list(client.tools.values())}
    if args.command == "browser-call":
        arguments = json.loads(args.arguments_json)
        if not isinstance(arguments, dict):
            raise Blocked("invalid_command", "Browser tool arguments must be a JSON object.")
        return {"status": "browser_result", "tool": args.tool, "output": client.call(args.tool, **arguments)}
    if args.command == "doctor":
        pages = pages_from(client.call("list_pages"))
        return {"status": "ready", "version": VERSION, "browser": "existing_chrome", "pageCount": len(pages), "uploadAvailable": True}
    if args.command in {"open", "inspect"}:
        page = get_page(client, args.url, create=args.command == "open")
        if args.command == "open":
            client.call("select_page", pageId=page["id"], bringToFront=True)
        return {"status": "page_ready", "pageUrl": page["url"], "snapshot": client.call("take_snapshot", pageId=page["id"])}
    if args.command == "google-login":
        return google_login(client, args)
    if args.command == "check-result":
        return check_result(client, args)
    return upload(client, args, staging_root)


def session_args(message):
    if not isinstance(message, dict) or message.get("command") not in {"doctor", "open", "inspect", "upload", "google-login", "check-result", "browser-call", "browser-tools", "remember-login", "login-preferences"}:
        raise Blocked("invalid_command", "Use doctor, open, inspect, upload, google-login, check-result, remember-login, login-preferences or stop.")
    arguments = [message["command"]]
    names = {"url": "url", "projectId": "project-id", "purpose": "purpose", "fieldLabel": "field-label", "connection": "connection", "maxSizeMb": "max-size-mb", "requiredCount": "required-count", "uploadTimeout": "upload-timeout", "loginTimeout": "login-timeout", "resultTimeout": "result-timeout", "accountEmail": "account-email", "registration": "registration", "tool": "tool", "argumentsJson": "arguments-json"}
    for key, value in message.items():
        if key == "command":
            continue
        if key in {"replace", "asDefault"} and isinstance(value, bool):
            if value:
                arguments.append("--replace" if key == "replace" else "--as-default")
        elif key in names and isinstance(value, (str, int, float)) and not isinstance(value, bool):
            # A single --key=value argv item also preserves values beginning with '-'.
            arguments.append(f"--{names[key]}={value}")
        else:
            raise Blocked("invalid_command", f"Unsupported command field: {key}")
    try:
        return parse_args(arguments)
    except SystemExit:
        raise Blocked("invalid_command", "Invalid arguments for this command; consult --help.")


def session(client, staging_root):
    initial = execute(client, parse_args(["doctor"]), staging_root)
    print(json.dumps(initial), flush=True)
    for line in sys.stdin:
        try:
            message = json.loads(line)
            if message == {"command": "stop"}:
                print(json.dumps({"status": "stopped", "browserPreserved": True}), flush=True)
                return 0
            result = execute(client, session_args(message), staging_root)
        except Blocked as error:
            result = error.result
        except (ValueError, OSError, KeyError, StopIteration) as error:
            result = {"status": "runner_error", "message": safe_text(error)}
        print(json.dumps(clean_output(result), ensure_ascii=False), flush=True)
    return 0


def main(argv=None):
    client = None
    try:
        args = parse_args(argv)
        if args.command in {"remember-login", "login-preferences"}:
            print(json.dumps(clean_output(execute(None, args, None)), ensure_ascii=False, indent=2))
            return 0
        import blink_session
        if args.command == "_serve":
            blink_session.serve(sys.modules[__name__], args.browser_url)
            return 0
        if args.command == "session":
            return blink_session.proxy_session(sys.modules[__name__], args)
        if args.command != "session":
            result = blink_session.dispatch(sys.modules[__name__], args)
            print(json.dumps(clean_output(result), ensure_ascii=False, indent=2))
            return 0 if result["status"] in {"ready", "page_ready", "uploaded", "login_completed", "submitted", "awaiting_approval", "awaiting_email_verification", "browser_result", "session_ready", "session_not_running", "stopped"} else 2
    except Blocked as error:
        print(json.dumps(clean_output(error.result), ensure_ascii=False, indent=2))
        return 2
    except (OSError, ValueError, KeyError, StopIteration) as error:
        print(json.dumps({"status": "runner_error", "message": safe_text(error)}, ensure_ascii=False))
        return 2
    finally:
        if client:
            client.close()


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdin.reconfigure(encoding="utf-8")
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    raise SystemExit(main())
