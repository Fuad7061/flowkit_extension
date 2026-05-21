from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional
import asyncio
import aiohttp
import base64
import uuid
from agent.db import crud
from agent.services.flow_client import get_flow_client
from agent.config import IMAGE_MODELS

router = APIRouter(prefix="/generate", tags=["generate"])


class GenerateRequest(BaseModel):
    prompt: str
    aspect_ratio: Optional[str] = "16:9"
    image_model: Optional[str] = None  # NANO_BANANA_PRO or NANO_BANANA_2
    tasker: Optional[str] = "enabled"  # "enabled" or "disabled"


class GenerateResponse(BaseModel):
    url: str


def _map_aspect_to_flow(aspect: str) -> str:
    mapping = {
        "16:9": "IMAGE_ASPECT_RATIO_LANDSCAPE",
        "9:16": "IMAGE_ASPECT_RATIO_PORTRAIT",
        "1:1": "IMAGE_ASPECT_RATIO_SQUARE",
        "4:3": "IMAGE_ASPECT_RATIO_LANDSCAPE",
    }
    return mapping.get(aspect, "IMAGE_ASPECT_RATIO_LANDSCAPE")


def _get_model_key(model: Optional[str]) -> str:
    if model == "NANO_BANANA_2":
        return "NANO_BANANA_2"
    return "NANO_BANANA_PRO"  # default


@router.post("", response_model=GenerateResponse)
async def generate_image(body: GenerateRequest):
    client = get_flow_client()
    use_tasker = body.tasker.lower() != "disabled" if body.tasker else True

    if not client.connected and not use_tasker:
        raise HTTPException(503, "Extension not connected")

    client._tasker_allowed = use_tasker
    try:
        aspect_ratio = _map_aspect_to_flow(body.aspect_ratio)
        model_key = _get_model_key(body.image_model)
        model_name = IMAGE_MODELS.get(model_key, "GEM_PIX_2")

        project = await crud.create_project(
            name=f"QuickGen",
            story="Auto-generated for quick image",
            material="realistic"
        )
        project_id = project["id"]

        result = await client.generate_images(
            prompt=body.prompt,
            project_id=project_id,
            aspect_ratio=aspect_ratio,
            image_model=model_name
        )

        if result.get("error"):
            raise HTTPException(500, f"Image generation failed: {result.get('error')}")

        data = result.get("data", result)
        image_url = None

        if isinstance(data, dict):
            media = data.get("media", [])
            if media:
                image_obj = media[0].get("image", {})
                gen_img = image_obj.get("generatedImage", {})
                image_url = gen_img.get("fifeUrl")

        if not image_url:
            raise HTTPException(500, f"No image URL returned. Response: {str(data)[:200]}")

        return GenerateResponse(url=image_url)
    finally:
        client._tasker_allowed = True