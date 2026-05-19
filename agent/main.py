"""Flow Kit — Minimal API Server for Image Generation"""
import asyncio
import json
import logging
import secrets
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from agent.config import API_HOST, API_PORT
from agent.db.schema import init_db, close_db
from agent.api.generate import router as generate_router
from agent.api.edit import router as edit_router
from agent.api.tunnel import router as tunnel_router
from agent.services.flow_client import get_flow_client

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
logger = logging.getLogger(__name__)

_CALLBACK_SECRET = secrets.token_urlsafe(32)

@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    logger.info("Flow Image API starting on %s:%d", API_HOST, API_PORT)
    yield
    await close_db()
    logger.info("Flow Image API stopped")


app = FastAPI(title="Flow Image API", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(generate_router, prefix="/api")
app.include_router(edit_router, prefix="/api")
app.include_router(tunnel_router, prefix="/api")


@app.post("/api/ext/callback")
async def ext_callback(request: Request):
    data = await request.json()
    client = get_flow_client()
    req_id = data.get("id")
    if req_id and req_id in client._pending:
        future = client._pending[req_id]
        try:
            future.set_result(data)
        except asyncio.InvalidStateError:
            pass
        return {"ok": True}
    return {"ok": False, "reason": "no matching pending request"}


@app.get("/health")
async def health():
    client = get_flow_client()
    return {
        "status": "ok",
        "version": "1.0.0",
        "extension_connected": client.connected,
    }

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    client = get_flow_client()
    client.add_extension(websocket)
    logger.info("Extension connected to /ws endpoint")

    await websocket.send_text(json.dumps({"type": "callback_secret", "secret": _CALLBACK_SECRET}))

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                data = json.loads(raw)
                await client.handle_message(websocket, data)
            except json.JSONDecodeError:
                logger.warning("Invalid JSON from extension")
            except Exception as e:
                logger.exception("Error handling extension message: %s", e)
    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.warning(f"WebSocket Error: {e}")
    finally:
        client.remove_extension(websocket)
        logger.info("Extension disconnected from /ws endpoint")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "agent.main:app",
        host=API_HOST,
        port=API_PORT,
    )