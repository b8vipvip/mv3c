#!/usr/bin/env python3
"""Initialize local mv3c environment with stable secrets and no hardcoded API key."""
from __future__ import annotations

import argparse
import getpass
import ipaddress
import os
import re
import secrets
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]

def validate_url(value: str, *, endpoint: bool = False) -> str:
    value = value.strip().rstrip("/")
    parsed = urlsplit(value)
    if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("URL must be http(s)://host[:port] without embedded credentials")
    if parsed.query or parsed.fragment:
        raise ValueError("URL must not contain a query string or fragment")
    if endpoint and not parsed.path.endswith("/v1"):
        raise ValueError("chat2api base URL must end with /v1")
    if parsed.scheme == "http":
        host = parsed.hostname.lower()
        try:
            private = ipaddress.ip_address(host).is_private
        except ValueError:
            private = False
        if not (host in {"localhost", "127.0.0.1", "host.docker.internal", "chat2api"} or private):
            raise ValueError("Public endpoints must use HTTPS to protect the chat2api API key")
    return value

def initialize(base_url: str, domain: str, key: str) -> Path:
    base_url = validate_url(base_url, endpoint=True)
    domain = validate_url(domain)
    if not key or re.search(r"[\s#\x00-\x1f\$'\"]", key):
        raise ValueError("Invalid API key characters; expected a single-line opaque token")
    template = (ROOT / ".env.mv3c.example").read_text(encoding="utf-8")
    values = {
        "CHAT2API_BASE_URL": base_url,
        "CHAT2API_API_KEY": key,
        "DOMAIN_CLIENT": domain,
        "DOMAIN_SERVER": domain,
        "JWT_SECRET": secrets.token_hex(32),
        "JWT_REFRESH_SECRET": secrets.token_hex(32),
        "CREDS_KEY": secrets.token_hex(32),
        "CREDS_IV": secrets.token_hex(16),
    }
    for name, value in values.items():
        before = re.compile(r"(?m)^" + re.escape(name) + r"=.*$")
        if len(before.findall(template)) != 1:
            raise ValueError(f"Missing/duplicate environment variable: {name}")
        template = before.sub(lambda _: name + "=" + value, template)
    dest = ROOT / ".env"
    fd = os.open(dest, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            output.write(template)
    except BaseException:
        dest.unlink(missing_ok=True)
        raise
    return dest

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Create a private .env for mv3c")
    parser.add_argument("--base-url", required=True, help="chat2api endpoint ending in /v1")
    parser.add_argument("--domain", default="http://localhost:3080", help="public mv3c origin")
    args = parser.parse_args()
    key = os.environ.get("MV3C_CHAT2API_KEY") or getpass.getpass("chat2api API Key (hidden): ")
    try:
        path = initialize(args.base_url, args.domain, key)
    except (ValueError, FileExistsError) as exc:
        parser.error(str(exc))
    print(f"Created {path.name} with unique persistent secrets (chmod 600); API key not printed.")
