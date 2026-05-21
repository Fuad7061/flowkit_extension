"""Tasker device management API endpoints."""
import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from agent.services.tasker_service import get_tasker_service
from agent.db import crud

logger = logging.getLogger(__name__)

router = APIRouter(tags=["tasker"])


class RegisterRequest(BaseModel):
    tasker_url: str
    device_name: str


class UnregisterRequest(BaseModel):
    tasker_url: str


@router.post("/tasker/register")
async def register_device(req: RegisterRequest):
    """Register a Tasker/AutoRemote endpoint for wake-up triggers."""
    service = get_tasker_service()
    await service._ensure_loaded()
    device = service.register_device(req.tasker_url, req.device_name)
    await crud.create_tasker_device(req.tasker_url, req.device_name)
    return {"ok": True, "device": device}


@router.post("/tasker/unregister")
async def unregister_device(req: UnregisterRequest):
    """Remove a registered Tasker endpoint."""
    service = get_tasker_service()
    await service._ensure_loaded()
    removed = service.unregister_device(req.tasker_url)
    if not removed:
        raise HTTPException(status_code=404, detail="Device not found")
    await crud.delete_tasker_device(req.tasker_url)
    return {"ok": True}


@router.get("/tasker/devices")
async def list_devices():
    """List all registered Tasker devices."""
    service = get_tasker_service()
    await service._ensure_loaded()
    return {"devices": service.list_devices(), "count": len(service.list_devices())}


@router.post("/tasker/test/{device_index}")
async def test_wake_up(device_index: int):
    """Send a test wake-up message to a specific device (by index)."""
    service = get_tasker_service()
    await service._ensure_loaded()
    devices = service.list_devices()
    if device_index < 0 or device_index >= len(devices):
        raise HTTPException(status_code=404, detail="Device not found")

    device = devices[device_index]
    success = await service.send_wake_up(device["tasker_url"], "w")
    if not success:
        raise HTTPException(status_code=500, detail="Failed to send wake-up")
    return {"ok": True, "message": "Test wake-up sent"}
