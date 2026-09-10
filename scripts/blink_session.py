"""Authenticated loopback broker retaining one Chrome MCP across CLI calls."""
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request


def state_path(runner):
    override = os.environ.get("BLINK_BROWSER_SESSION_PATH")
    return Path(override).expanduser().resolve() if override else runner.preference_path().parent / "browser-session.json"


def read_state(path):
    try:
        state = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    if not isinstance(state, dict) or not isinstance(state.get("port"), int) or not 0 < state["port"] < 65536 or not isinstance(state.get("token"), str) or len(state["token"]) < 32:
        raise ValueError("Invalid browser session state. Preserve it for inspection.")
    return state


def write_state(path, state):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(prefix=".browser-session-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(state, stream)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def request(state, message=None, timeout=310):
    # Ignore proxy environment variables: IPC must stay on this machine.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    data = json.dumps(message).encode() if message is not None else None
    req = urllib.request.Request(f"http://127.0.0.1:{state['port']}/command" if data else f"http://127.0.0.1:{state['port']}/status", data=data,
                                 headers={"Authorization": "Bearer " + state["token"], "Content-Type": "application/json"})
    try:
        with opener.open(req, timeout=timeout) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        return json.load(error)


def handler_for(runner, shared):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def reply(self, value, status=200):
            body = json.dumps(runner.clean_output(value), ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass  # The action's result remains in the same running broker.

        def authorized(self):
            supplied = self.headers.get("Authorization", "")
            expected = "Bearer " + shared["token"]
            return not self.headers.get("Origin") and hmac.compare_digest(supplied.encode(), expected.encode())

        def do_GET(self):
            if not self.authorized():
                return self.reply({"status": "session_access_denied"}, 403)
            if self.path != "/status":
                return self.reply({"status": "invalid_command"}, 404)
            self.reply({"status": shared["status"], "version": runner.VERSION, "sessionId": shared["sessionId"], "busy": shared["lock"].locked()})

        def do_POST(self):
            if not self.authorized():
                return self.reply({"status": "session_access_denied"}, 403)
            if self.path != "/command" or self.headers.get("Content-Type") != "application/json":
                return self.reply({"status": "invalid_command"}, 400)
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 1024 * 1024:
                    raise ValueError("Invalid command length")
                self.connection.settimeout(5)
                message = json.loads(self.rfile.read(length))
            except (ValueError, OSError):
                return self.reply({"status": "invalid_command"}, 400)
            if not shared["lock"].acquire(blocking=False):
                return self.reply({"status": "session_busy", "retryAllowed": False, "message": "Another command is still running. Wait for its result; do not start another Chrome connection."}, 409)
            try:
                if message == {"command": "stop"}:
                    self.reply({"status": "stopped", "browserPreserved": True})
                    shared["stop"].set()
                    return
                if shared["status"] != "session_ready":
                    return self.reply({"status": shared["status"], "message": "Keep this connection; inspect the broker log if initialization failed."}, 503)
                try:
                    value = runner.execute(shared["client"], runner.session_args(message), shared["root"])
                except runner.Blocked as error:
                    value = error.result
                except (ValueError, OSError, KeyError, StopIteration) as error:
                    value = {"status": "runner_error", "message": runner.safe_text(error)}
                self.reply({**value, "sessionId": shared["sessionId"], "connectionReused": True})
            finally:
                shared["lock"].release()
    return Handler


def serve(runner, browser_url=None):
    path = state_path(runner)
    shared = {"token": secrets.token_urlsafe(32), "sessionId": secrets.token_hex(12), "status": "session_starting", "lock": threading.Lock(), "stop": threading.Event()}
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler_for(runner, shared))
    server.daemon_threads = True
    state = {"port": server.server_port, "token": shared["token"], "sessionId": shared["sessionId"], "version": runner.VERSION, "browserUrl": browser_url}
    client = None
    worker = None
    try:
        write_state(path, state)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        shared["root"] = Path(tempfile.mkdtemp(prefix="blink-runner-")).resolve()
        client = runner.McpClient(runner.mcp_command(browser_url), shared["root"])
        client.initialize()
        shared["client"] = client
        shared["status"] = "session_ready"
        # Explicit session-stop or process/Chrome shutdown ends the connection.
        # No timer silently creates a new connection during a long campaign.
        shared["stop"].wait()
    except Exception as error:
        if worker is None:
            raise
        shared["status"] = "session_failed"
        print(runner.safe_text(error), file=sys.stderr, flush=True)
        shared["stop"].wait()
    finally:
        if worker:
            server.shutdown()
        server.server_close()
        if client:
            client.close()
        current = read_state(path)
        if current and current.get("sessionId") == shared["sessionId"]:
            path.unlink(missing_ok=True)


def ensure_session(runner, browser_url=None):
    path = state_path(runner)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    state = read_state(path)
    if state:
        if state.get("version") != runner.VERSION or state.get("browserUrl") != browser_url:
            raise runner.Blocked("session_configuration_changed", "An existing broker uses another version/Chrome endpoint. Finish it and explicitly run session-stop before starting the updated session.")
        return state
    lock_path = path.with_suffix(".starting")
    try:
        descriptor = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        descriptor = None
    try:
        if descriptor is not None:
            os.close(descriptor)
            # Another caller may have finished startup while we took the lock.
            state = read_state(path)
            if state:
                return state
            command = [sys.executable, str(runner.HERE / "blink-browser.py")]
            if browser_url:
                command.extend(["--browser-url", browser_url])
            command.append("_serve")
            log_fd = os.open(path.with_suffix(".log"), os.O_CREAT | os.O_APPEND | os.O_WRONLY, 0o600)
            with os.fdopen(log_fd, "ab") as log:
                process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                                           start_new_session=os.name != "nt", creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
                # Reap it if this caller remains alive, without tying the
                # broker's lifetime to the caller or blocking caller exit.
                threading.Thread(target=process.wait, daemon=True).start()
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            state = read_state(path)
            if state:
                return state
            time.sleep(0.2)
        raise runner.Blocked("session_start_failed", "The local broker did not start. Inspect browser-session.log; no second broker was started.")
    finally:
        if descriptor is not None:
            lock_path.unlink(missing_ok=True)


def dispatch(runner, args):
    path = state_path(runner)
    if args.command in {"session-status", "session-stop"}:
        state = read_state(path)
        if not state:
            return {"status": "session_not_running", "browserPreserved": True}
    else:
        state = ensure_session(runner, args.browser_url)
    try:
        if args.command == "session-stop":
            return request(state, {"command": "stop"}, timeout=10)
        deadline = time.monotonic() + 20
        while True:
            health = request(state, timeout=5)
            if health["status"] != "session_starting" or args.command == "session-status":
                break
            if time.monotonic() >= deadline:
                return health
            time.sleep(0.3)
        if args.command == "session-status" or health["status"] != "session_ready":
            return health
        fields = {"project_id": "projectId", "field_label": "fieldLabel", "max_size_mb": "maxSizeMb", "required_count": "requiredCount", "upload_timeout": "uploadTimeout", "login_timeout": "loginTimeout", "result_timeout": "resultTimeout", "arguments_json": "argumentsJson"}
        message = {fields.get(key, key): value for key, value in vars(args).items() if key != "browser_url" and value is not None}
        return request(state, message)
    except (OSError, ValueError) as error:
        # Do not reconnect after an ambiguous IPC response: the action can be
        # running/completed in the broker. Preserve its Chrome and upload state.
        if args.command == "session-stop" and isinstance(error, urllib.error.URLError) and isinstance(error.reason, ConnectionRefusedError):
            path.unlink(missing_ok=True)
            return {"status": "stopped", "browserPreserved": True}
        raise runner.Blocked("session_unreachable", "The saved connection is unavailable or its response is uncertain. Inspect session-status and browser-session.log; do not start another MCP or replay a mutation.") from error


def proxy_session(runner, args):
    initial = runner.parse_args(["doctor"])
    initial.browser_url = args.browser_url
    print(json.dumps(runner.clean_output(dispatch(runner, initial))), flush=True)
    for line in sys.stdin:
        try:
            message = json.loads(line)
            command = runner.parse_args(["session-stop"]) if message == {"command": "stop"} else runner.session_args(message)
            command.browser_url = args.browser_url
            result = dispatch(runner, command) if command.command not in {"remember-login", "login-preferences"} else runner.execute(None, command, None)
        except runner.Blocked as error:
            result = error.result
        except (ValueError, OSError, KeyError) as error:
            result = {"status": "runner_error", "message": runner.safe_text(error)}
        print(json.dumps(runner.clean_output(result), ensure_ascii=False), flush=True)
        if result["status"] == "stopped":
            return 0
    # A shell tool's stdin EOF must not destroy the authorized MCP connection.
    return 0
