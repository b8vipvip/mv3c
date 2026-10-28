"""GitHub Actions ONLY: restricted local CONNECT proxy for official GHCR acceptance.

This server is not installed on hosts or used by the production updater.
It is an ephemeral bridge for CI, where GHCR is already reachable directly.
"""
import selectors
import socket
import socketserver
import sys

ALLOWED = {"ghcr.io", "pkg-containers.githubusercontent.com"}


class Tunnel(socketserver.StreamRequestHandler):
    def handle(self):
        line = self.rfile.readline(2048)
        try:
            method, target, protocol = line.decode("ascii").strip().split()
            host, port = target.rsplit(":", 1)
            if (method != "CONNECT" or protocol not in ("HTTP/1.1", "HTTP/1.0")
                    or host.lower() not in ALLOWED or port != "443"):
                raise ValueError("Rejected proxy target")
            while self.rfile.readline(8192) not in (b"\r\n", b"\n", b""):
                pass
        except (ValueError, UnicodeError):
            self.wfile.write(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
            return
        try:
            upstream = socket.create_connection((host, 443), timeout=20)
        except OSError:
            self.wfile.write(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n")
            return
        with upstream:
            upstream.settimeout(None)
            self.wfile.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            self.wfile.flush()
            with selectors.DefaultSelector() as select:
                select.register(self.connection, selectors.EVENT_READ, upstream)
                select.register(upstream, selectors.EVENT_READ, self.connection)
                while True:
                    for key, _ in select.select(timeout=120):
                        data = key.fileobj.recv(128 * 1024)
                        if not data:
                            return
                        key.data.sendall(data)


class Proxy(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    print("CI-only GHCR CONNECT proxy on 127.0.0.1:11808", flush=True)
    with Proxy(("127.0.0.1", 11808), Tunnel) as server:
        server.serve_forever()
