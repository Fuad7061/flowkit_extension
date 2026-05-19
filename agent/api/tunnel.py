"""Ngrok tunnel management — start/stop/status via subprocess."""
import asyncio
import logging
import os
import shutil
import subprocess
from typing import Optional

import aiohttp
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/tunnel", tags=["tunnel"])

# ─── Global state ────────────────────────────────────────────
_ngrok_process: Optional[subprocess.Popen] = None
_tunnel_url: Optional[str] = None
_tunnel_status: str = "stopped"   # stopped | starting | active | error
_tunnel_error: Optional[str] = None


# ─── Models ──────────────────────────────────────────────────

class TunnelStartRequest(BaseModel):
    auth_token: str
    domain: str


class TunnelStatusResponse(BaseModel):
    status: str
    url: Optional[str] = None
    error: Optional[str] = None


# ─── Helpers ─────────────────────────────────────────────────

def _find_ngrok() -> Optional[str]:
    """Locate the ngrok binary across common install paths."""
    candidates = [
        shutil.which("ngrok"),
        "/usr/local/bin/ngrok",
        "/opt/homebrew/bin/ngrok",
        os.path.expanduser("~/bin/ngrok"),
        os.path.expanduser("~/.local/bin/ngrok"),
    ]
    for p in candidates:
        if p and os.path.isfile(p):
            return p
    return None


async def _poll_ngrok_api(timeout: int = 20) -> Optional[str]:
    """Poll ngrok's local REST API (port 4040) until a HTTPS tunnel URL appears."""
    loop = asyncio.get_event_loop()
    deadline = loop.time() + timeout
    async with aiohttp.ClientSession() as session:
        while loop.time() < deadline:
            try:
                async with session.get(
                    "http://127.0.0.1:4040/api/tunnels",
                    timeout=aiohttp.ClientTimeout(total=2),
                ) as resp:
                    if resp.status == 200:
                        data = await resp.json()
                        tunnels = data.get("tunnels", [])
                        # Prefer HTTPS tunnel
                        for t in tunnels:
                            if t.get("proto") == "https":
                                return t.get("public_url")
                        if tunnels:
                            return tunnels[0].get("public_url")
            except Exception:
                pass
            await asyncio.sleep(1)
    return None


def _check_process_alive() -> bool:
    global _ngrok_process
    if _ngrok_process is None:
        return False
    return _ngrok_process.poll() is None


# ─── Routes ──────────────────────────────────────────────────

@router.post("/start", response_model=TunnelStatusResponse)
async def start_tunnel(body: TunnelStartRequest):
    global _ngrok_process, _tunnel_url, _tunnel_status, _tunnel_error

    # If already running, return current state
    if _check_process_alive():
        return TunnelStatusResponse(status=_tunnel_status, url=_tunnel_url)

    ngrok_bin = _find_ngrok()
    if not ngrok_bin:
        raise HTTPException(
            404,
            "ngrok binary not found. Install with: brew install ngrok"
        )

    # Configure auth token (writes to ~/.config/ngrok/ngrok.yml)
    try:
        result = subprocess.run(
            [ngrok_bin, "config", "add-authtoken", body.auth_token],
            capture_output=True,
            timeout=10,
            text=True,
        )
        if result.returncode != 0:
            raise HTTPException(500, f"ngrok auth failed: {result.stderr[:200]}")
    except subprocess.TimeoutExpired:
        raise HTTPException(500, "ngrok auth token configuration timed out")

    # Start ngrok tunnel
    _tunnel_status = "starting"
    _tunnel_url = None
    _tunnel_error = None

    try:
        _ngrok_process = subprocess.Popen(
            [ngrok_bin, "http", "8100", "--domain", body.domain, "--log", "false"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except Exception as e:
        _tunnel_status = "error"
        _tunnel_error = str(e)
        raise HTTPException(500, f"Failed to start ngrok: {e}")

    # Poll for the public URL
    url = await _poll_ngrok_api(timeout=20)

    if url:
        _tunnel_url = url
        _tunnel_status = "active"
        logger.info("Ngrok tunnel active at: %s", url)
        return TunnelStatusResponse(status="active", url=url)

    # Process died before we got a URL
    if not _check_process_alive():
        _tunnel_status = "error"
        _tunnel_error = "ngrok process exited unexpectedly. Check your auth token and domain."
        return TunnelStatusResponse(status="error", error=_tunnel_error)

    _tunnel_status = "error"
    _tunnel_error = "Tunnel started but URL not available. ngrok may still be connecting."
    return TunnelStatusResponse(status="error", error=_tunnel_error)


@router.post("/stop", response_model=TunnelStatusResponse)
async def stop_tunnel():
    global _ngrok_process, _tunnel_url, _tunnel_status, _tunnel_error

    if _ngrok_process:
        _ngrok_process.terminate()
        try:
            _ngrok_process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            _ngrok_process.kill()
        _ngrok_process = None

    _tunnel_url = None
    _tunnel_status = "stopped"
    _tunnel_error = None
    logger.info("Ngrok tunnel stopped")
    return TunnelStatusResponse(status="stopped")


@router.get("/status", response_model=TunnelStatusResponse)
async def tunnel_status():
    global _ngrok_process, _tunnel_url, _tunnel_status, _tunnel_error

    # Detect if process died unexpectedly
    if _ngrok_process is not None and not _check_process_alive():
        _tunnel_status = "stopped"
        _tunnel_url = None
        _ngrok_process = None
        _tunnel_error = "Tunnel process exited unexpectedly"

    return TunnelStatusResponse(
        status=_tunnel_status,
        url=_tunnel_url,
        error=_tunnel_error,
    )
