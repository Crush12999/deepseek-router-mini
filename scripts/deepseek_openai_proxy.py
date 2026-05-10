#!/usr/bin/env python3
"""Small OpenAI-compatible DeepSeek proxy used for xiaoyi-router E2E checks.

The proxy accepts project-local model aliases and forwards them to the actual
DeepSeek model ids. It logs both ids for every chat completion request.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any


MODEL_MAP = {
    "LLM_DeepSeekV4_Think0": "deepseek-v4-flash",
    "LLM_DeepSeekV4_Pro_Think0": "deepseek-v4-pro",
}

HOP_BY_HOP_HEADERS = {
    "connection",
    "content-length",
    "host",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
}


def trim_trailing_slash(value: str) -> str:
    return value.rstrip("/")


def parse_headers(raw_headers: Any) -> dict[str, str]:
    headers: dict[str, str] = {}
    for key, value in raw_headers.items():
        if key.lower() in HOP_BY_HOP_HEADERS:
            continue
        headers[key] = value
    return headers


def write_json(handler: BaseHTTPRequestHandler, status: int, body: dict[str, Any]) -> None:
    payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("content-type", "application/json")
    handler.send_header("content-length", str(len(payload)))
    handler.end_headers()
    handler.wfile.write(payload)


class DeepSeekProxyHandler(BaseHTTPRequestHandler):
    server: "DeepSeekProxyServer"

    def log_message(self, format: str, *args: Any) -> None:
        self.server.log("http", format % args)

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            write_json(
                self,
                200,
                {
                    "status": "ok",
                    "upstreamBaseUrl": self.server.upstream_base_url,
                    "models": MODEL_MAP,
                },
            )
            return

        if self.path in {"/v1/models", "/models"}:
            write_json(
                self,
                200,
                {
                    "object": "list",
                    "data": [
                        {
                            "id": alias,
                            "object": "model",
                            "owned_by": "xiaoyi-router-e2e",
                        }
                        for alias in MODEL_MAP
                    ],
                },
            )
            return

        write_json(self, 404, {"error": "Not Found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path not in {"/v1/chat/completions", "/chat/completions"}:
            write_json(self, 404, {"error": "Not Found"})
            return

        self.handle_chat_completions()

    def handle_chat_completions(self) -> None:
        started_at = time.monotonic()
        length_header = self.headers.get("content-length") or "0"
        try:
            length = int(length_header)
        except ValueError:
            write_json(self, 400, {"error": "Invalid content-length"})
            return

        raw_body = self.rfile.read(length)
        try:
            body = json.loads(raw_body.decode("utf-8"))
        except json.JSONDecodeError:
            write_json(self, 400, {"error": "Invalid JSON body"})
            return

        if not isinstance(body, dict):
            write_json(self, 400, {"error": "Body must be a JSON object"})
            return

        requested_model = body.get("model")
        if not isinstance(requested_model, str):
            write_json(self, 400, {"error": "Field model must be a string"})
            return

        upstream_model = MODEL_MAP.get(requested_model)
        if upstream_model is None:
            write_json(
                self,
                400,
                {
                    "error": (
                        f'Unsupported model "{requested_model}". '
                        f"Supported models: {', '.join(MODEL_MAP)}"
                    )
                },
            )
            self.server.log(
                "chat",
                f"model={requested_model} upstream_model=- status=400 duration_ms=0",
            )
            return

        upstream_body = {**body, "model": upstream_model}
        upstream_payload = json.dumps(upstream_body, ensure_ascii=False).encode("utf-8")
        upstream_headers = parse_headers(self.headers)
        upstream_headers["content-type"] = "application/json"

        if not any(key.lower() == "authorization" for key in upstream_headers):
            if self.server.api_key:
                upstream_headers["authorization"] = f"Bearer {self.server.api_key}"

        request = urllib.request.Request(
            f"{self.server.upstream_base_url}/chat/completions",
            data=upstream_payload,
            headers=upstream_headers,
            method="POST",
        )

        status = 502
        try:
            with urllib.request.urlopen(request, timeout=self.server.timeout_seconds) as response:
                status = response.status
                self.copy_upstream_response(response)
        except urllib.error.HTTPError as error:
            status = error.code
            self.copy_upstream_response(error)
        except urllib.error.URLError as error:
            write_json(self, 502, {"error": str(error.reason)})
        finally:
            duration_ms = int((time.monotonic() - started_at) * 1000)
            self.server.log(
                "chat",
                (
                    f"model={requested_model} upstream_model={upstream_model} "
                    f"status={status} duration_ms={duration_ms}"
                ),
            )

    def copy_upstream_response(self, response: Any) -> None:
        self.send_response(response.status if hasattr(response, "status") else response.code)
        for key, value in response.headers.items():
            if key.lower() in HOP_BY_HOP_HEADERS:
                continue
            self.send_header(key, value)
        self.end_headers()

        while True:
            chunk = response.read(64 * 1024)
            if not chunk:
                break
            self.wfile.write(chunk)


class DeepSeekProxyServer(ThreadingHTTPServer):
    def __init__(
        self,
        server_address: tuple[str, int],
        upstream_base_url: str,
        api_key: str | None,
        timeout_seconds: float,
    ) -> None:
        super().__init__(server_address, DeepSeekProxyHandler)
        self.upstream_base_url = trim_trailing_slash(upstream_base_url)
        self.api_key = api_key
        self.timeout_seconds = timeout_seconds

    def log(self, event: str, message: str) -> None:
        print(f"[deepseek-openai-proxy] event={event} {message}", flush=True)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="OpenAI-compatible DeepSeek proxy for xiaoyi-router E2E checks.")
    parser.add_argument("--host", default=os.environ.get("DEEPSEEK_PROXY_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("DEEPSEEK_PROXY_PORT", "19081")))
    parser.add_argument(
        "--upstream-base-url",
        default=os.environ.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com"),
    )
    parser.add_argument("--timeout", type=float, default=float(os.environ.get("DEEPSEEK_PROXY_TIMEOUT", "300")))
    return parser


def main() -> int:
    args = build_parser().parse_args()
    api_key = os.environ.get("DEEPSEEK_API_KEY") or os.environ.get("XIAOYI_API_KEY")
    server = DeepSeekProxyServer(
        (args.host, args.port),
        args.upstream_base_url,
        api_key,
        args.timeout,
    )
    server.log(
        "start",
        (
            f"listening=http://{args.host}:{args.port} "
            f"upstream={server.upstream_base_url} models={json.dumps(MODEL_MAP, sort_keys=True)}"
        ),
    )

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.log("stop", "received KeyboardInterrupt")
    finally:
        server.server_close()

    return 0


if __name__ == "__main__":
    sys.exit(main())
