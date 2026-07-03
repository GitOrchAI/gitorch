#!/usr/bin/env python3
"""
Antigravity runtime runner for headless use.

Chama a API Gemini (generativelanguage.googleapis.com) diretamente via REST,
sem dependências externas. Substitui o SDK google-antigravity, cujo binário
localharness exige glibc 2.36+ (indisponível nesta VM Ubuntu 22.04 / glibc 2.35).

Chamado pelo Node.js via createPythonSdkRuntimeAdapter em
packages/agents/src/runtime-adapter.ts.

Usage:
    python3 run_antigravity_sdk.py "prompt" --model gemini-2.5-flash \
        [--system-instructions "..."] [--timeout 300]

Environment:
    GEMINI_API_KEY / GOOGLE_API_KEY - chaves candidatas; testadas em ordem,
        com fallback automático se uma estiver revogada (API_KEY_INVALID).
    ANTIGRAVITY_MODEL - modelo default quando --model ausente.
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from typing import Optional

API_BASE = "https://generativelanguage.googleapis.com/v1beta/models"
DEFAULT_MODEL = "gemini-2.5-flash"


def candidate_keys() -> "list[str]":
    keys = []
    for name in ("GEMINI_API_KEY", "GOOGLE_API_KEY"):
        value = os.environ.get(name, "").strip()
        if value and value not in keys:
            keys.append(value)
    return keys


def generate(
    prompt: str,
    model: str,
    api_key: str,
    system_instructions: Optional[str],
    timeout: int,
) -> str:
    payload = {"contents": [{"parts": [{"text": prompt}]}]}
    if system_instructions:
        payload["systemInstruction"] = {"parts": [{"text": system_instructions}]}

    url = f"{API_BASE}/{model}:generateContent?key={api_key}"
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        body = json.load(response)

    candidates = body.get("candidates") or []
    if not candidates:
        block = body.get("promptFeedback", {}).get("blockReason", "no candidates returned")
        raise RuntimeError(f"Gemini returned no candidates: {block}")

    parts = candidates[0].get("content", {}).get("parts", [])
    text = "".join(part.get("text", "") for part in parts)
    if not text:
        raise RuntimeError("Gemini returned an empty response")
    return text


def main() -> int:
    parser = argparse.ArgumentParser(description="Run a prompt against the Antigravity (Gemini) API")
    parser.add_argument("prompt", help="Prompt text")
    parser.add_argument("--model", default=os.environ.get("ANTIGRAVITY_MODEL") or DEFAULT_MODEL)
    parser.add_argument("--system-instructions", default=None)
    parser.add_argument("--timeout", type=int, default=300)
    args = parser.parse_args()

    keys = candidate_keys()
    if not keys:
        print("ERROR: GEMINI_API_KEY / GOOGLE_API_KEY not set", file=sys.stderr)
        return 2

    last_error = "unknown error"
    for key in keys:
        try:
            text = generate(args.prompt, args.model, key, args.system_instructions, args.timeout)
            print(text)
            return 0
        except urllib.error.HTTPError as err:
            detail = err.read().decode("utf-8", errors="replace")
            last_error = f"HTTP {err.code}: {detail[:500]}"
            # Chave revogada/inválida: tenta a próxima candidata em vez de falhar.
            if err.code in (400, 401, 403) and (
                "API_KEY_INVALID" in detail or "PERMISSION_DENIED" in detail
            ):
                print(f"WARN: key rejected ({err.code}), trying next candidate", file=sys.stderr)
                continue
            break
        except Exception as err:  # noqa: BLE001 - o adapter Node precisa do stderr completo
            last_error = str(err)
            break

    print(f"ERROR: Antigravity API call failed: {last_error}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
