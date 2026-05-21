"""Tasker/AutoRemote service - sends wake-up triggers to Android devices."""
import asyncio
import logging
from typing import Optional

import httpx

logger = logging.getLogger(__name__)


class TaskerService:
    """Manages Tasker/AutoRemote device endpoints and sends wake-up notifications."""

    def __init__(self):
        self._devices: list[dict] = []

    def register_device(self, tasker_url: str, device_name: str) -> dict:
        """Register a Tasker/AutoRemote endpoint."""
        for dev in self._devices:
            if dev["tasker_url"] == tasker_url:
                dev["device_name"] = device_name
                logger.info("Updated Tasker device: %s", device_name)
                return dev

        device = {
            "tasker_url": tasker_url,
            "device_name": device_name,
        }
        self._devices.append(device)
        logger.info("Registered Tasker device: %s (%s)", device_name, tasker_url[:50])
        return device

    def unregister_device(self, tasker_url: str) -> bool:
        """Remove a Tasker endpoint."""
        before = len(self._devices)
        self._devices = [d for d in self._devices if d["tasker_url"] != tasker_url]
        removed = len(self._devices) < before
        if removed:
            logger.info("Unregistered Tasker device: %s", tasker_url[:50])
        return removed

    def list_devices(self) -> list[dict]:
        """List all registered devices."""
        return list(self._devices)

    async def send_wake_up(self, tasker_url: str, message: str = "WakeKiwi") -> bool:
        """Send wake-up message to a Tasker/AutoRemote endpoint.

        AutoRemote URL format:
        https://autoremotejoaomgcd.appspot.com/?key=YOUR_KEY&message=MESSAGE

        Returns True if HTTP request succeeded (2xx), False otherwise.
        """
        try:
            if "autoremote" in tasker_url.lower():
                url = tasker_url
                if "message=" not in url:
                    sep = "&" if "?" in url else "?"
                    url = f"{url}{sep}message={message}"
            else:
                async with httpx.AsyncClient(timeout=10) as client:
                    resp = await client.post(
                        tasker_url,
                        json={"action": "wake_kiwi", "message": message},
                    )
                    if resp.status_code < 300:
                        logger.info("Wake-up sent to Tasker device: %s", tasker_url[:50])
                        return True
                    else:
                        logger.warning("Tasker webhook returned %d: %s", resp.status_code, tasker_url[:50])
                        return False

            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.get(url)
                if resp.status_code < 300:
                    logger.info("Wake-up sent to AutoRemote device: %s", tasker_url[:50])
                    return True
                else:
                    logger.warning("AutoRemote returned %d: %s", resp.status_code, tasker_url[:50])
                    return False

        except httpx.RequestError as e:
            logger.error("Failed to send wake-up to %s: %s", tasker_url[:50], e)
            return False
        except Exception as e:
            logger.error("Unexpected error sending wake-up: %s", e)
            return False

    async def broadcast_wake_up(self, message: str = "WakeKiwi") -> int:
        """Send wake-up to all registered devices. Returns count of successful sends."""
        if not self._devices:
            logger.warning("No Tasker devices registered")
            return 0

        results = await asyncio.gather(
            *[self.send_wake_up(d["tasker_url"], message) for d in self._devices],
            return_exceptions=True,
        )
        success_count = sum(1 for r in results if r is True)
        logger.info("Wake-up broadcast: %d/%d devices notified", success_count, len(self._devices))
        return success_count


_tasker_service: Optional[TaskerService] = None


def get_tasker_service() -> TaskerService:
    global _tasker_service
    if _tasker_service is None:
        _tasker_service = TaskerService()
    return _tasker_service
