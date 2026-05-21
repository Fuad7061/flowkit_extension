from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional
import aiohttp
import base64
import uuid
import logging
from agent.db import crud
from agent.services.flow_client import get_flow_client
from agent.config import IMAGE_MODELS

router = APIRouter(prefix="/edit", tags=["edit"])


class EditRequest(BaseModel):
    image_url: str
    prompt: str
    aspect_ratio: Optional[str] = "16:9"
    image_model: Optional[str] = None  # GEM_PIX_2 or NARWHAL
    tasker: Optional[str] = "enabled"  # "enabled" or "disabled"


class EditResponse(BaseModel):
    url: str


def _map_aspect_to_flow(aspect: str) -> str:
    mapping = {
        "16:9": "IMAGE_ASPECT_RATIO_LANDSCAPE",
        "9:16": "IMAGE_ASPECT_RATIO_PORTRAIT",
        "1:1": "IMAGE_ASPECT_RATIO_SQUARE",
        "4:3": "IMAGE_ASPECT_RATIO_LANDSCAPE",
    }
    return mapping.get(aspect, "IMAGE_ASPECT_RATIO_LANDSCAPE")


async def _download_image(url: str) -> tuple[bytes, str]:
    """Download image from URL and return (bytes, mime_type)."""
    async with aiohttp.ClientSession() as session:
        async with session.get(url) as resp:
            if resp.status != 200:
                raise HTTPException(400, f"Failed to download image: {resp.status}")
            content = await resp.read()
            content_type = resp.headers.get("Content-Type", "image/jpeg")
            return content, content_type


def _get_mime_type(filename: str) -> str:
    if ".png" in filename.lower():
        return "image/png"
    if ".webp" in filename.lower():
        return "image/webp"
    return "image/jpeg"


@router.post("", response_model=EditResponse)
async def edit_image(body: EditRequest):
    client = get_flow_client()
    use_tasker = body.tasker.lower() != "disabled" if body.tasker else True

    if not client.connected and not use_tasker:
        raise HTTPException(503, "Extension not connected")

    client._tasker_allowed = use_tasker
    try:
        image_bytes, content_type = await _download_image(body.image_url)
        image_b64 = base64.b64encode(image_bytes).decode()

        project = await crud.create_project(
            name=f"QuickEdit",
            story="Auto-generated for image edit",
            material="realistic"
        )
        project_id = project["id"]

        upload_result = await client.upload_image(
            image_b64,
            mime_type=content_type,
            project_id=project_id,
            file_name=f"edit_{uuid.uuid4()}.jpg"
        )

        if upload_result.get("error"):
            raise HTTPException(500, f"Upload failed: {upload_result.get('error')}")

        source_media_id = upload_result.get("_mediaId")
        if not source_media_id:
            raise HTTPException(500, "Failed to get media_id from upload")

        aspect_ratio = _map_aspect_to_flow(body.aspect_ratio)

        model_key = "NANO_BANANA_PRO"  # default
        if body.image_model == "NANO_BANANA_2":
            model_key = "NANO_BANANA_2"
        image_model = IMAGE_MODELS.get(model_key)

        edit_result = await client.edit_image(
            prompt=body.prompt,
            source_media_id=source_media_id,
            project_id=project_id,
            aspect_ratio=aspect_ratio,
            image_model=image_model
        )

        if edit_result.get("error"):
            raise HTTPException(500, f"Edit failed: {edit_result.get('error')}")

        data = edit_result.get("data", edit_result)
        image_url = None

        if isinstance(data, dict):
            media = data.get("media", [])
            if media:
                image_obj = media[0].get("image", {})
                image_url = image_obj.get("fifeUrl")
                if not image_url:
                    gen_img = image_obj.get("generatedImage", {})
                    image_url = gen_img.get("fifeUrl")

        if not image_url:
            raise HTTPException(500, f"No edited image URL returned. Response: {str(data)[:300]}")

        return EditResponse(url=image_url)
    finally:
        client._tasker_allowed = True