"""Account boundary and outbound network policy; no web framework dependency."""
import contextvars
import hashlib
import hmac
import ipaddress
import os
import re
import secrets
import socket
import sqlite3
import ssl
import threading
import time
import urllib.request
import http.client
from contextlib import contextmanager
from http.cookies import SimpleCookie, CookieError
from pathlib import Path
from urllib.parse import urlsplit


identity = contextvars.ContextVar("fitai_identity", default=None)
hash_slot = threading.BoundedSemaphore(1)


class SecurityError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def password_hash(value, salt=None):
    salt = salt or secrets.token_hex(16)
    key = hashlib.scrypt(value.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=5, dklen=32)
    return "scrypt$" + salt + "$" + key.hex()


def verify(value, encoded):
    try:
        _, salt, _ = encoded.split("$")
        return hmac.compare_digest(password_hash(value, salt), encoded)
    except (ValueError, TypeError):
        return False


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def credentials(body):
    name, password = body.get("username"), body.get("password")
    if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_-]{3,32}", name):
        raise SecurityError("用户名需为 3–32 位字母、数字、下划线或短横线")
    if not isinstance(password, str) or not 12 <= len(password) <= 128:
        raise SecurityError("密码需为 12–128 个字符")
    return name.lower(), password


class Accounts:
    def __init__(self, root, mode="local", origin="", max_users=20, ssh_preview=False):
        if mode not in ("local", "server"):
            raise ValueError("FITAI_MODE must be local or server")
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.mode, self.origin, self.max_users = mode, origin.rstrip("/"), max_users
        self.ssh_preview = ssh_preview
        if mode == "server":
            parsed = urlsplit(self.origin)
            private_origin = (ssh_preview and parsed.scheme == "http" and parsed.hostname == "localhost"
                              and parsed.port is not None and 1024 <= parsed.port <= 65535)
            if ((parsed.scheme != "https" and not private_origin) or not parsed.hostname or parsed.username or parsed.password
                    or parsed.path or parsed.query or parsed.fragment):
                raise ValueError("server mode requires FITAI_PUBLIC_ORIGIN=https://your-domain")
            if ssh_preview and not private_origin:
                raise ValueError("SSH preview requires http://localhost:<unprivileged-port>; no public proxy")
        self.session_seconds = 12 * 3600
        self.locks = [threading.RLock() for _ in range(64)]
        self.dummy = password_hash(secrets.token_urlsafe(32))
        with self.connect() as c:
            c.executescript("""
                CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL,
                    password TEXT NOT NULL, created REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, uid TEXT NOT NULL,
                    csrf TEXT NOT NULL, expires REAL NOT NULL);
                CREATE INDEX IF NOT EXISTS sessions_uid ON sessions(uid);
                CREATE TABLE IF NOT EXISTS config(key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS limits(key TEXT PRIMARY KEY, count INTEGER, expires REAL);
            """)

    @contextmanager
    def connect(self):
        c = sqlite3.connect(str(self.root / "accounts.db"), timeout=10)
        c.row_factory = sqlite3.Row
        try:
            c.execute("PRAGMA journal_mode=WAL")
            yield c
            c.commit()
        except Exception:
            c.rollback()
            raise
        finally:
            c.close()

    def lock(self, uid):
        return self.locks[int(digest(uid)[:8], 16) % len(self.locks)]

    def limit(self, key, maximum, seconds):
        now = time.time()
        blocked = False
        with self.connect() as c:
            c.execute("BEGIN IMMEDIATE")
            c.execute("DELETE FROM limits WHERE expires < ?", (now,))
            row = c.execute("SELECT count FROM limits WHERE key=?", (digest(key),)).fetchone()
            if row:
                blocked = row[0] >= maximum
                if not blocked:
                    c.execute("UPDATE limits SET count=count+1 WHERE key=?", (digest(key),))
            elif c.execute("SELECT count(*) FROM limits").fetchone()[0] >= 5000:
                blocked = True
            else:
                c.execute("INSERT INTO limits VALUES(?,1,?)", (digest(key), now + seconds))
        if blocked:
            raise SecurityError("请求过于频繁，请稍后再试", 429)

    def check_origin(self, headers):
        host = headers.get("Host", "").lower()
        origin = headers.get("Origin", "").rstrip("/")
        if self.mode == "server":
            valid = host == urlsplit(self.origin).netloc.lower() and (not origin or origin == self.origin)
        else:
            try:
                parsed = urlsplit("http://" + host)
                valid = (parsed.hostname in ("localhost", "127.0.0.1", "::1")
                         and not parsed.username and parsed.netloc == host
                         and (not origin or origin == "http://" + host))
            except ValueError:
                valid = False
        if not valid or headers.get("Sec-Fetch-Site") == "cross-site":
            raise SecurityError("请求来源不受信任", 403)

    def cookie(self, token, clear=False):
        return ("fitai_session=" + token + "; Path=/; HttpOnly; SameSite=Strict; Max-Age="
                + ("0" if clear else str(self.session_seconds))
                + ("; Secure" if self.mode == "server" else ""))

    def session(self, headers):
        cookie = SimpleCookie()
        try:
            cookie.load(headers.get("Cookie", ""))
            raw = cookie["fitai_session"].value
        except (KeyError, ValueError, CookieError):
            return None
        if len(raw) > 128:
            return None
        with self.connect() as c:
            row = c.execute("SELECT users.id,username,csrf,token FROM sessions JOIN users ON users.id=sessions.uid "
                            "WHERE token=? AND expires>?", (digest(raw), time.time())).fetchone()
        if not row:
            return None
        result = dict(row)
        result["db"] = str(self.root / "users" / result["id"] / "fitai.db")
        return result

    def invite_open(self):
        with self.connect() as c:
            config = dict(c.execute("SELECT key,value FROM config").fetchall())
            count = c.execute("SELECT count(*) FROM users").fetchone()[0]
        return (count < self.max_users and (self.mode == "local" or
                bool(config.get("invite_hash") and int(config.get("invite_remaining", "0")) > 0)))

    def authenticate(self, body, register, ip):
        self.limit("auth-global", 60, 600)
        self.limit("auth-ip:" + ip, 12, 600)
        name, password = credentials(body)
        self.limit("auth-user:" + name, 15, 600)
        if register:
            self.limit("register-ip:" + ip, 5, 3600)
            self.limit("register-global", 20, 86400)
        if not hash_slot.acquire(blocking=False):
            raise SecurityError("登录服务繁忙，请稍后再试", 429)
        try:
            with self.connect() as c:
                row = c.execute("SELECT * FROM users WHERE username=?", (name,)).fetchone()
                config = dict(c.execute("SELECT key,value FROM config").fetchall())
            if register:
                invite = body.get("invite", "")
                if not isinstance(invite, str) or len(invite) > 128:
                    raise SecurityError("邀请码无效", 403)
                if self.mode == "server" and (not config.get("invite_hash") or
                        not verify(invite, config["invite_hash"])):
                    raise SecurityError("邀请码无效或注册未开放", 403)
                if row:
                    raise SecurityError("无法注册该用户名", 409)
                encoded = password_hash(password)
                uid = secrets.token_hex(16)
                with self.connect() as c:
                    c.execute("BEGIN IMMEDIATE")
                    if c.execute("SELECT count(*) FROM users").fetchone()[0] >= self.max_users:
                        raise SecurityError("注册名额已满", 403)
                    if self.mode == "server":
                        current = dict(c.execute("SELECT key,value FROM config").fetchall())
                        if (current.get("invite_hash") != config.get("invite_hash") or
                                int(current.get("invite_remaining", "0")) <= 0):
                            raise SecurityError("邀请码已失效或名额已用完", 403)
                        c.execute("UPDATE config SET value=? WHERE key='invite_remaining'",
                                  (str(int(current["invite_remaining"]) - 1),))
                    c.execute("INSERT INTO users VALUES(?,?,?,?)", (uid, name, encoded, time.time()))
            else:
                if not verify(password, row["password"] if row else self.dummy) or not row:
                    raise SecurityError("用户名或密码错误", 401)
                uid = row["id"]
            raw, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
            with self.connect() as c:
                c.execute("DELETE FROM sessions WHERE expires<=?", (time.time(),))
                # At most five simultaneous devices per account.
                c.execute("DELETE FROM sessions WHERE uid=? AND token NOT IN "
                          "(SELECT token FROM sessions WHERE uid=? ORDER BY expires DESC LIMIT 4)", (uid, uid))
                c.execute("INSERT INTO sessions VALUES(?,?,?,?)",
                          (digest(raw), uid, csrf, time.time() + self.session_seconds))
            return raw
        finally:
            hash_slot.release()

    def revoke(self, session):
        with self.connect() as c:
            c.execute("DELETE FROM sessions WHERE token=?", (session["token"],))


def allowed_url(url):
    """Admin-owned exact origin allowlist; users cannot add destinations."""
    parsed = urlsplit(url)
    allowed = {s.strip().rstrip("/") for s in os.environ.get(
        "FITAI_MODEL_ORIGINS", "https://api.deepseek.com,https://api.openai.com").split(",") if s.strip()}
    allowed.add("https://api.tavily.com")
    origin = parsed.scheme + "://" + parsed.netloc
    if (parsed.scheme != "https" or origin not in allowed or parsed.username or parsed.password
            or parsed.fragment or "\\" in url or any(ord(c) < 33 for c in url)):
        raise SecurityError("服务器不允许此模型地址，请联系管理员配置可信 HTTPS 地址", 403)
    return parsed


class PinnedHTTPS(http.client.HTTPSConnection):
    def connect(self):
        # Resolve once, reject *all* non-public answers, connect to validated IP,
        # but retain the original hostname for TLS certificate verification/SNI.
        addresses = socket.getaddrinfo(self.host, self.port, type=socket.SOCK_STREAM)
        if not addresses or any(not ipaddress.ip_address(a[4][0]).is_global for a in addresses):
            raise SecurityError("禁止访问内网、回环或云元数据地址", 403)
        last = None
        for family, kind, proto, _, sockaddr in addresses:
            sock = socket.socket(family, kind, proto)
            try:
                sock.settimeout(self.timeout)
                sock.connect(sockaddr)
                self.sock = self._context.wrap_socket(sock, server_hostname=self.host)
                return
            except OSError as exc:
                last = exc
                sock.close()
        raise last


class PinnedHandler(urllib.request.HTTPSHandler):
    def https_open(self, request):
        return self.do_open(PinnedHTTPS, request, context=ssl.create_default_context())


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def safe_open(request, timeout):
    allowed_url(request.full_url)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), PinnedHandler(), NoRedirect())
    return opener.open(request, timeout=timeout)
