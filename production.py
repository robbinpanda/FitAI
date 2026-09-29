"""Bounded WSGI streaming adapter, served by Waitress behind nginx HTTPS.

Business handlers are shared with the local server. No HTTP is parsed by
http.server here: Waitress parses requests; this adapter supplies typed headers
and bounded body streams, forwarding SSE through a bounded queue.
"""
import queue
import threading
from concurrent.futures import ThreadPoolExecutor
from email.message import Message
from http import HTTPStatus

import server

WORKERS = ThreadPoolExecutor(max_workers=6, thread_name_prefix="fitai-http")
SLOTS = threading.BoundedSemaphore(6)


def application(environ, start_response):
    if server.AUTH is None:
        start_response("503 Service Unavailable", [("Content-Type", "text/plain")])
        return [b"Accounts not initialized; use python production.py"]
    if not SLOTS.acquire(blocking=False):
        start_response("503 Service Unavailable", [("Content-Type", "text/plain"), ("Retry-After", "5")])
        return [b"Server busy"]
    messages = queue.Queue(maxsize=8)
    stopped = threading.Event()

    def put(value):
        while not stopped.is_set():
            try:
                messages.put(value, timeout=0.5)
                return
            except queue.Full:
                pass
        raise BrokenPipeError("client disconnected")

    class Writer:
        def write(self, value):
            for offset in range(0, len(value), 65536):
                put(("body", value[offset:offset + 65536]))
            return len(value)

        def flush(self):
            pass

    class WSGIHandler(server.Handler):
        def send_response(self, code, message=None):
            self.status = "%d %s" % (code, HTTPStatus(code).phrase)
            self.response_headers = []

        def send_header(self, name, value):
            if name.lower() not in ("connection", "transfer-encoding"):
                self.response_headers.append((name, str(value)))

        def end_headers(self):
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("X-Frame-Options", "DENY")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
            put(("headers", (self.status, self.response_headers)))

    def run():
        try:
            handler = WSGIHandler.__new__(WSGIHandler)
            handler.path = environ.get("PATH_INFO", "/")
            if environ.get("QUERY_STRING"):
                handler.path += "?" + environ["QUERY_STRING"]
            handler.headers = Message()
            for key, value in environ.items():
                if key.startswith("HTTP_"):
                    handler.headers[key[5:].replace("_", "-")] = value
            for key in ("CONTENT_LENGTH", "CONTENT_TYPE"):
                if environ.get(key):
                    handler.headers[key.replace("_", "-")] = environ[key]
            handler.client_address = (environ.get("REMOTE_ADDR", "127.0.0.1"), 0)
            handler.rfile, handler.wfile = environ["wsgi.input"], Writer()
            method = environ.get("REQUEST_METHOD", "GET")
            if method == "GET":
                handler.do_GET()
            elif method == "POST":
                handler.do_POST()
            else:
                handler._send(405, {"error": "Method not allowed"}, headers={"Allow": "GET, POST"})
        finally:
            try:
                put(("end", None))
            except BrokenPipeError:
                pass
            SLOTS.release()

    WORKERS.submit(run)

    def response():
        try:
            while True:
                kind, value = messages.get()
                if kind == "headers":
                    start_response(*value)
                elif kind == "body":
                    yield value
                else:
                    return
        finally:
            stopped.set()
    return response()


if __name__ == "__main__":
    from waitress import serve
    server.configure_accounts()
    if server.AUTH.mode != "server":
        raise SystemExit("Set FITAI_MODE=server and FITAI_PUBLIC_ORIGIN=https://your-domain")
    serve(application, host="127.0.0.1", port=server.PORT, threads=6,
          connection_limit=32, channel_timeout=180, max_request_body_size=8 * 1024 * 1024,
          max_request_header_size=16384, outbuf_overflow=262144,
          outbuf_high_watermark=524288, ident="FitAI")
