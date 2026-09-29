"""Exercise the real production WSGI boundary with disposable data only."""
import io
import json
import os
import socket
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server
import security
import production


class AccountTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.old_auth = server.AUTH
        server.AUTH = security.Accounts(self.temp.name, "server", "https://fitai.test")
        self.auth = server.AUTH
        self.invite = "test-invitation-very-secret"
        with self.auth.connect() as c:
            c.execute("INSERT INTO config VALUES('invite_hash',?)", (security.password_hash(self.invite),))
            c.execute("INSERT INTO config VALUES('invite_remaining','5')")
        self.password = "correct-test-password"

    def tearDown(self):
        server.AUTH = self.old_auth
        self.temp.cleanup()

    def request(self, path, body=None, cookie="", csrf="", extra=None, method=None):
        raw = json.dumps(body).encode() if body is not None else b""
        route, _, query = path.partition("?")
        env = {"PATH_INFO": route, "QUERY_STRING": query, "REQUEST_METHOD": method or ("POST" if body is not None else "GET"),
               "wsgi.input": io.BytesIO(raw), "CONTENT_LENGTH": str(len(raw)), "CONTENT_TYPE": "application/json",
               "HTTP_HOST": "fitai.test", "HTTP_ORIGIN": "https://fitai.test", "HTTP_COOKIE": cookie,
               "HTTP_X_FITAI_TOKEN": csrf, "HTTP_X_FITAI_AUTH": "1", "REMOTE_ADDR": "127.0.0.1"}
        env.update(extra or {})
        result = {}
        def start(status, headers):
            result["status"] = int(status.split()[0]); result["headers"] = dict(headers)
        iterator = production.application(env, start)
        try:
            result["raw"] = b"".join(iterator)
        finally:
            if hasattr(iterator, "close"):
                iterator.close()
        try:
            result["body"] = json.loads(result["raw"])
        except ValueError:
            result["body"] = None
        return result

    def register(self, name="alice", invite=None):
        result = self.request("/api/auth/register", {"username": name, "password": self.password,
                                                     "invite": self.invite if invite is None else invite})
        self.assertEqual(result["status"], 200, result)
        cookie = result["headers"]["Set-Cookie"].split(";", 1)[0]
        status = self.request("/api/auth/status", cookie=cookie)
        return cookie, status["body"]["session_token"]

    def test_shared_defaults_override_clear_and_isolation(self):
        defaults = {"FITAI_SHARED_API_KEY": "site-model-secret-1234",
                    "FITAI_SHARED_TAVILY_API_KEY": "site-search-secret-5678",
                    "FITAI_SHARED_BASE_URL": "https://api.deepseek.com/v1",
                    "FITAI_SHARED_MODEL": "deepseek-flash"}
        with mock.patch.dict(os.environ, defaults):
            cookie, csrf = self.register()
            second, _ = self.register("bob")
            def save(body):
                result = self.request('/api/settings', body, cookie, csrf)
                self.assertEqual(result['status'], 200, result)
                for secret in defaults.values():
                    if 'secret' in secret:
                        self.assertNotIn(secret, result['raw'].decode())
                return result['body']['settings']
            s = save({'search_enabled': True})
            self.assertEqual(s['key_source'], 'shared')
            self.assertEqual(s['tavily_key_source'], 'shared')
            self.assertTrue(s['search_ready'])
            self.assertEqual(s['api_key_masked'], '')
            self.assertEqual(s['tavily_api_key_masked'], '')
            s = save({'api_key': 'personal-model', 'api_key_action': 'replace',
                      'base_url': 'https://api.openai.com/v1', 'text_model': 'personal-model-name',
                      'tavily_api_key': 'personal-search', 'tavily_api_key_action': 'replace'})
            self.assertEqual(s['key_source'], 'own')
            self.assertEqual(s['tavily_key_source'], 'own')
            other = self.request('/api/state', cookie=second)['body']['settings']
            self.assertEqual(other['key_source'], 'shared')
            s = save({'api_key_action': 'clear', 'tavily_api_key_action': 'clear'})
            self.assertEqual(s['key_source'], 'shared')
            self.assertEqual(s['base_url'], defaults['FITAI_SHARED_BASE_URL'])
            self.assertEqual(s['text_model'], defaults['FITAI_SHARED_MODEL'])
            self.assertTrue(s['search_ready'])
            with self.auth.connect() as c:
                uid = c.execute("SELECT id FROM users WHERE username='alice'").fetchone()[0]
            import sqlite3
            from contextlib import closing
            with closing(sqlite3.connect(self.auth.root / 'users' / uid / 'fitai.db')) as c:
                row = c.execute('SELECT api_key,tavily_api_key FROM settings').fetchone()
                self.assertEqual(row, ('', ''))
            with mock.patch('server._request_stream') as outbound:
                for base, model in [('https://api.openai.com/v1', 'deepseek-flash'),
                                    ('https://api.deepseek.com/v1', 'expensive-model')]:
                    with self.assertRaises(server.ApiError):
                        server.call_model(base, defaults['FITAI_SHARED_API_KEY'], model, [])
                outbound.assert_not_called()

    def test_anonymous_cannot_read_any_user_data(self):
        for path in ["/api/state", "/api/export", "/api/photo?id=1", "/api/coach/image?id=1",
                     "/api/weights", "/api/coach/sessions", "/api/job?id=test"]:
            self.assertEqual(self.request(path)["status"], 401)
        self.assertEqual(self.request("/api/health")["status"], 200)

    def test_server_invite_and_spoofed_localhost(self):
        body = {"username":"alice", "password":self.password}
        self.assertEqual(self.request("/api/auth/register", body)["status"], 403)
        self.assertEqual(self.request("/api/auth/register", body, extra={"HTTP_HOST":"localhost", "HTTP_ORIGIN":"http://localhost"})["status"], 403)
        self.assertEqual(self.request("/api/auth/register", body, extra={"HTTP_X_FORWARDED_HOST":"localhost"})["status"], 403)
        self.assertEqual(self.request("/api/auth/register", body, extra={"HTTP_ORIGIN":"https://evil.test"})["status"], 403)
        self.assertEqual(self.request("/api/auth/register", body, extra={"HTTP_X_FITAI_AUTH":""})["status"], 403)

    def test_local_register_needs_no_invite_but_still_login(self):
        self.auth.mode = "local"
        result = self.request("/api/auth/register", {"username":"local", "password":self.password},
                              extra={"HTTP_HOST":"localhost:8765", "HTTP_ORIGIN":"http://localhost:8765"})
        self.assertEqual(result["status"], 200)
        self.assertNotIn("; Secure", result["headers"]["Set-Cookie"])

    def test_cross_user_records_settings_photos_sessions_and_jobs(self):
        alice, acsrf = self.register()
        bob, bcsrf = self.register("bob")
        d = server.date.today().isoformat()
        self.assertEqual(self.request("/api/weight", {"date":d,"weight":71}, alice, acsrf)["status"], 200)
        self.assertEqual(self.request("/api/settings", {"api_key":"alice-secret", "api_key_action":"replace"}, alice, acsrf)["status"], 200)
        session = self.request("/api/coach/session/create", {"date":d}, alice, acsrf)["body"]
        self.assertEqual(self.request("/api/weights", cookie=bob)["body"]["weights"], [])
        self.assertFalse(self.request("/api/state", cookie=bob)["body"]["has_key"])
        self.assertNotIn(b"alice-secret", self.request("/api/state", cookie=alice)["raw"])
        sessions = self.request("/api/coach/sessions", cookie=alice)["body"]["sessions"]
        self.assertEqual(self.request("/api/coach/session?id=" + sessions[0]["id"], cookie=bob)["status"], 404)
        auser = self.auth.session({"Cookie":alice})
        context = security.identity.set(auser)
        try:
            with server.db() as c:
                c.execute("INSERT INTO meal_photos(date,meal_type,filename,mime) VALUES(?,?,?,?)", (d,"早餐","private.jpg","image/jpeg"))
            Path(server.photos_dir(), "private.jpg").write_bytes(b"alice photo")
            jid = server.submit_job("test", lambda jid: server._job_finish(jid, result={"path":server.current_db_path()}))
        finally:
            security.identity.reset(context)
        for _ in range(100):
            job = self.request("/api/job?id=" + jid, cookie=alice)
            if job["body"]["status"] != "running": break
            time.sleep(.01)
        self.assertEqual(job["body"]["result"]["path"], auser["db"])
        self.assertEqual(self.request("/api/job?id=" + jid, cookie=bob)["status"], 404)
        self.assertEqual(self.request("/api/photo?id=1", cookie=alice)["raw"], b"alice photo")
        self.assertEqual(self.request("/api/photo?id=1", cookie=bob)["status"], 404)
        self.assertEqual(self.request("/api/export", cookie=bob)["body"]["weights"], [])
        self.assertEqual(self.request("/api/weight/delete", {"date":d,"id":1}, bob, bcsrf)["status"], 200)
        self.assertEqual(len(self.request("/api/weights", cookie=alice)["body"]["weights"]), 1)

    def test_csrf_logout_expiry_and_hashed_storage(self):
        cookie, csrf = self.register()
        self.assertEqual(self.request("/api/prefs", {"display_unit":"kJ"}, cookie)["status"], 403)
        self.assertEqual(self.request("/api/auth/logout", {}, cookie)["status"], 403)
        self.assertIn("frame-ancestors 'none'", self.request("/", cookie=cookie)["headers"]["Content-Security-Policy"])
        with self.auth.connect() as c:
            self.assertNotEqual(c.execute("SELECT password FROM users").fetchone()[0], self.password)
            self.assertNotEqual(c.execute("SELECT token FROM sessions").fetchone()[0], cookie.split("=",1)[1])
            self.assertNotEqual(c.execute("SELECT value FROM config WHERE key='invite_hash'").fetchone()[0], self.invite)
        logout = self.request("/api/auth/logout", {}, cookie, csrf)
        self.assertEqual(logout["status"], 200)
        self.assertIn("Secure", logout["headers"]["Set-Cookie"])
        self.assertEqual(self.request("/api/state", cookie=cookie)["status"], 401)
        login = self.request("/api/auth/login", {"username":"alice","password":self.password})
        self.assertEqual(login["status"], 200)
        new_cookie = login["headers"]["Set-Cookie"].split(";",1)[0]
        self.assertNotEqual(new_cookie, cookie)
        with self.auth.connect() as c: c.execute("UPDATE sessions SET expires=0")
        self.assertEqual(self.request("/api/state", cookie=new_cookie)["status"], 401)

    def test_invitation_rotation_exhaustion_and_account_cap(self):
        with self.auth.connect() as c: c.execute("UPDATE config SET value='1' WHERE key='invite_remaining'")
        self.register()
        result = self.request("/api/auth/register", {"username":"bob", "password":self.password,"invite":self.invite})
        self.assertEqual(result["status"], 403)
        self.assertFalse(self.request("/api/auth/status")["body"]["registration_open"])
        with self.auth.connect() as c:
            c.execute("UPDATE config SET value=? WHERE key='invite_hash'", (security.password_hash("new-invite-long-enough"),))
            c.execute("UPDATE config SET value='5' WHERE key='invite_remaining'")
        self.assertEqual(self.request("/api/auth/register", {"username":"bob", "password":self.password,"invite":self.invite})["status"], 403)
        self.auth.max_users = 1
        self.assertEqual(self.request("/api/auth/register", {"username":"bob", "password":self.password,"invite":"new-invite-long-enough"})["status"], 403)

    def test_switching_accounts_revokes_old_session_and_csrf(self):
        alice, acsrf = self.register()
        self.register("bob")
        login = self.request("/api/auth/login", {"username":"bob","password":self.password}, cookie=alice)
        self.assertEqual(login["status"], 200)
        new_cookie = login["headers"]["Set-Cookie"].split(";",1)[0]
        self.assertEqual(self.request("/api/state", cookie=alice)["status"], 401)
        self.assertEqual(self.request("/api/auth/status", cookie=new_cookie)["body"]["user"]["username"], "bob")
        self.assertEqual(self.request("/api/prefs", {"display_unit":"kJ"}, new_cookie, acsrf)["status"], 403)

    def test_persistent_rate_limit_and_upload_limit(self):
        for _ in range(12): self.auth.limit("auth-ip:127.0.0.1", 12, 600)
        # Reopening the auth store does not reset rate counters.
        reopened = security.Accounts(self.temp.name, "server", "https://fitai.test")
        with self.assertRaises(security.SecurityError) as error:
            reopened.authenticate({"username":"alice","password":self.password}, False, "127.0.0.1")
        self.assertEqual(error.exception.status, 429)
        self.assertEqual(self.request("/api/auth/login", {}, extra={"CONTENT_LENGTH":"5000"})["status"], 413)
        self.assertEqual(self.request("/api/auth/login", {}, extra={"CONTENT_LENGTH":"-1"})["status"], 400)

    def test_server_cannot_change_model_to_internal_or_untrusted_origin(self):
        cookie, csrf = self.register()
        for url in ["http://127.0.0.1:80", "https://169.254.169.254", "https://evil.test/v1", "https://api.deepseek.com@localhost/v1"]:
            self.assertEqual(self.request("/api/settings", {"base_url":url}, cookie, csrf)["status"], 403)

    def test_global_ai_capacity_is_bounded_even_after_cancel(self):
        cookie, csrf = self.register()
        slots = [server.AI_SLOTS.acquire(False), server.AI_SLOTS.acquire(False)]
        try:
            self.assertTrue(all(slots))
            result = self.request("/api/test_key", {}, cookie, csrf)
            self.assertEqual(result["status"], 429)
        finally:
            for acquired in slots:
                if acquired: server.AI_SLOTS.release()

    def test_wsgi_streaming_yields_before_producer_finishes(self):
        # Tests queue bridge independently of the model service.
        started, release = threading.Event(), threading.Event()
        def stream(handler):
            handler._start_agent_stream()
            started.set()
            release.wait(3)
            handler._stream_event("done", {"ok":True})
        env = {"PATH_INFO":"/api/health", "REQUEST_METHOD":"GET", "HTTP_HOST":"fitai.test", "wsgi.input":io.BytesIO()}
        headers = []
        with mock.patch.object(server.Handler, "_do_GET", stream):
            response = production.application(env, lambda s,h: headers.extend(h))
            try:
                first = next(response)
                self.assertIn(b"event: status", first)
                self.assertIn(("Content-Type","text/event-stream; charset=utf-8"), headers)
                release.set()
                self.assertIn(b"event: done", b"".join(response))
            finally:
                release.set(); response.close()

    def test_parallel_initial_page_reads_do_not_spuriously_rate_limit(self):
        from concurrent.futures import ThreadPoolExecutor
        cookie, csrf = self.register()
        with ThreadPoolExecutor(max_workers=3) as pool:
            responses = list(pool.map(lambda path: self.request(path, cookie=cookie),
                                     ["/api/state", "/api/history", "/api/coach/sessions"]))
        self.assertEqual([r["status"] for r in responses], [200, 200, 200])

    def test_real_waitress_cookie_and_proxy_headers(self):
        try:
            from waitress import create_server
        except ImportError:
            self.skipTest("Install requirements-server.txt to test real Waitress sockets")
        from http.client import HTTPConnection
        http = create_server(production.application, host="127.0.0.1", port=0, threads=2)
        thread = threading.Thread(target=http.run, daemon=True)
        thread.start()
        connection = HTTPConnection("127.0.0.1", int(http.effective_port), timeout=5)
        try:
            body = json.dumps({"username":"network","password":self.password,"invite":self.invite})
            connection.request("POST", "/api/auth/register", body,
                               {"Host":"fitai.test", "Origin":"https://fitai.test", "Content-Type":"application/json",
                                "X-FitAI-Auth":"1", "X-Real-IP":"203.0.113.25"})
            response = connection.getresponse()
            self.assertEqual(response.status, 200, response.read())
            cookie = response.getheader("Set-Cookie")
            self.assertIn("Secure", cookie)
            connection.request("GET", "/api/state", headers={"Host":"fitai.test", "Cookie":cookie.split(";",1)[0]})
            response = connection.getresponse()
            self.assertEqual(response.status, 200)
            self.assertIn("session_token", json.loads(response.read()))
            with self.auth.connect() as c:
                self.assertIsNotNone(c.execute("SELECT count FROM limits WHERE key=?",
                                             (security.digest("auth-ip:203.0.113.25"),)).fetchone())
        finally:
            connection.close()
            http.task_dispatcher.shutdown()
            http.close()
            thread.join(timeout=2)


class NetworkPolicyTests(unittest.TestCase):
    def test_ssh_preview_is_explicit_localhost_only_and_retains_server_auth(self):
        with tempfile.TemporaryDirectory() as folder:
            for origin in ["http://localhost:18765", "http://evil.test:18765"]:
                with self.assertRaises(ValueError):
                    security.Accounts(folder, "server", origin)
            for origin in ["http://127.0.0.1:18765", "http://evil.test:18765", "https://evil.test", "http://localhost:80"]:
                with self.assertRaises(ValueError):
                    security.Accounts(folder, "server", origin, ssh_preview=True)
            accounts = security.Accounts(folder, "server", "http://localhost:18765", ssh_preview=True)
            self.assertFalse(accounts.invite_open())
            self.assertIn("; Secure", accounts.cookie("test"))
            accounts.check_origin({"Host":"localhost:18765", "Origin":"http://localhost:18765"})
            with self.assertRaises(security.SecurityError):
                accounts.check_origin({"Host":"localhost:18765", "Origin":"http://evil.test"})
            with self.assertRaises(security.SecurityError):
                accounts.authenticate({"username":"alice","password":"test-password-long"}, True, "127.0.0.1")

    def test_private_dns_answers_rejected_before_connect(self):
        conn = security.PinnedHTTPS("api.deepseek.com")
        for ip in ["127.0.0.1", "10.0.0.1", "169.254.169.254", "100.100.100.200", "::1"]:
            with mock.patch("security.socket.getaddrinfo", return_value=[(socket.AF_INET,socket.SOCK_STREAM,6,"",(ip,443))]):
                with self.assertRaises(security.SecurityError): conn.connect()

    def test_redirects_disabled_and_https_allowlist(self):
        self.assertIsNone(security.NoRedirect().redirect_request(None,None,302,"",{},"http://127.0.0.1"))
        for url in ["file:///etc/passwd", "http://api.deepseek.com", "https://api.deepseek.com:444", "https://api.deepseek.com.evil.test", "https://api.deepseek.com/#x"]:
            with self.assertRaises(security.SecurityError): security.allowed_url(url)
        self.assertEqual(security.allowed_url("https://api.deepseek.com/v1").hostname, "api.deepseek.com")


if __name__ == "__main__": unittest.main()
