"""Certbot with bounded retries for transient ACME connection failures.

Preserve standard TLS verification and protocol negotiation. Retrying reads
and HTTP error responses is limited to GET/HEAD; signed ACME POST requests
are never replayed after a read timeout or HTTP error response.
Run with /opt/fitai-certbot/bin/python3.
"""
import sys

import acme.client
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry


class RetryingHTTPAdapter(HTTPAdapter):
    def __init__(self, *args, **kwargs):
        kwargs.setdefault('max_retries', Retry(
            total=3, connect=3, read=3, status=3, other=0,
            allowed_methods=frozenset({'GET', 'HEAD'}),
            status_forcelist=(429, 500, 502, 503, 504),
            backoff_factor=1, backoff_max=30,
        ))
        super().__init__(*args, **kwargs)


if __name__ == '__main__':
    acme.client.HTTPAdapter = RetryingHTTPAdapter
    from certbot.main import main
    sys.exit(main())
