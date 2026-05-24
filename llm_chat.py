"""
GlowLoader LLM Chat Nodes
Based on comfyui-pdid-llm-nodes, with fix for DeepSeek thinking=disabled via extra_body.
"""

import re
import base64
from io import BytesIO
from logging import getLogger
from dataclasses import dataclass
from typing import Callable, Optional, Literal, Tuple

import torch
import numpy as np
from PIL import Image, ImageDraw
from openai import OpenAI

Logger = getLogger(__name__)


# ─── Data Classes ────────────────────────────────────────────────

@dataclass
class DetailedArguments:
    model: str
    messages: list[dict[str, str]] | list[str]
    temperature: float = 1.0
    top_p: float = 0.95
    top_k: int = 40


@dataclass
class ClientInfo:
    client: OpenAI
    client_type: Literal["openai", "openai-responses", "ollama", "mistral", "anthropic"]
    chat_func: Callable
    arguments: DetailedArguments


@dataclass
class ExtraParameters:
    thinking: Optional[Literal["disabled", "enabled"]] = None
    reasoning_effort: Optional[Literal["minimal", "low", "medium", "high"]] = None


# ─── Utility Functions ───────────────────────────────────────────

def tensor_to_pil(tensor: torch.Tensor) -> Image.Image:
    image_np = tensor.squeeze().mul(255).clamp(0, 255).byte().numpy()
    return Image.fromarray(image_np, "RGB")


def pil_to_tensor(image: Image.Image) -> torch.Tensor:
    return torch.from_numpy(np.array(image).astype(np.float32) / 255.0).unsqueeze(0)


def pil_to_base64(image: Image.Image) -> str:
    buffered = BytesIO()
    image.save(buffered, format="PNG")
    prefix = "data:image/png;base64,"
    return prefix + str(base64.b64encode(buffered.getvalue()).decode("utf-8"))


def parse_base64_image(base64_image):
    match = re.search(r"data:(image/[^;]+);base64,", base64_image)
    return {
        "type": "base64",
        "media_type": match.group(1) if match else "image/jpeg",
        "data": base64_image.split(",")[-1] if "," in base64_image else base64_image,
    }


# ─── Client Init ─────────────────────────────────────────────────

def init_client(client_type, base_url, api_key, model, proxy=None) -> ClientInfo:
    if client_type in ["openai", "openai-responses"]:
        import httpx
        timeout = httpx.Timeout(120.0, connect=30.0)
        http_client = httpx.Client(proxy=proxy, timeout=timeout) if proxy else None
        base_client = OpenAI(base_url=base_url, api_key=api_key, http_client=http_client)
    elif client_type == "ollama":
        from ollama import Client as Ollama
        base_client = Ollama()
    elif client_type == "mistral":
        from mistralai.client import Mistral
        base_client = Mistral(api_key=api_key)
    elif client_type == "anthropic":
        from anthropic import Anthropic
        base_client = Anthropic(base_url=base_url, api_key=api_key)
    else:
        raise ValueError(f"Unsupported client type: {client_type}")

    arguments = DetailedArguments(model=model, messages=[])

    if client_type == "openai":
        chat_func = base_client.chat.completions.create
    elif client_type == "openai-responses":
        chat_func = base_client.responses.create
    elif client_type == "mistral":
        chat_func = base_client.chat.complete
    elif client_type == "ollama":
        chat_func = base_client.chat
    elif client_type == "anthropic":
        chat_func = base_client.messages.create
    else:
        raise ValueError(f"Unsupported client type: {client_type}")

    return ClientInfo(
        client=base_client,
        client_type=client_type,
        chat_func=chat_func,
        arguments=arguments,
    )


# ─── Chat Completion (Fixed) ────────────────────────────────────

def chat_completion(
    client_info: ClientInfo,
    system_prompt: str,
    user_prompt: str,
    images: list[Image.Image] | None = None,
    temperature: float = 1.0,
    top_p: float = 0.95,
    top_k: int = 40,
    max_tokens: int = 1024,
    unload_after_chat: bool = True,
    extra_parameters: Optional[ExtraParameters] = None,
) -> str:
    if images is None:
        payload_images: list = []
    elif len(images) > 4:
        Logger.warning("More than 4 images, only the first 4 will be used.")
        payload_images: list = images[:4]
    else:
        payload_images: list = images

    base64_images: list[str] = [pil_to_base64(img) for img in payload_images]
    orig_args: DetailedArguments = client_info.arguments
    messages: list[dict] = [
        {"role": "system", "content": system_prompt},
        {
            "role": "user",
            "content": [
                {"type": "text", "text": user_prompt},
                *[
                    {"type": "image_url", "image_url": {"url": b64}}
                    for b64 in base64_images
                ],
            ],
        },
    ]

    if client_info.client_type == "ollama":
        payload = {
            "model": orig_args.model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {
                    "role": "user",
                    "content": user_prompt,
                    "images": [b64 for b64 in base64_images],
                },
            ],
            "options": {
                "temperature": temperature,
                "top_p": top_p,
                "top_k": top_k,
                "num_predict": max_tokens,
            },
        }
        if extra_parameters:
            need_think = extra_parameters.thinking == "enabled"
            payload["think"] = need_think
            if need_think and extra_parameters.reasoning_effort != "minimal":
                payload["think"] = extra_parameters.reasoning_effort
        if unload_after_chat:
            payload["keep_alive"] = "0"

    elif client_info.client_type == "openai":
        payload = {
            "model": orig_args.model,
            "messages": messages,
            "temperature": temperature,
            "top_p": top_p,
            "max_tokens": max_tokens,
        }
        if extra_parameters:
            # FIX: Always pass thinking via extra_body, including "disabled"
            # DeepSeek requires extra_body={"thinking": {"type": "disabled"}} to turn off thinking
            payload["extra_body"] = {}
            payload["extra_body"]["thinking"] = {"type": extra_parameters.thinking}
            if extra_parameters.thinking == "enabled":
                payload["reasoning_effort"] = extra_parameters.reasoning_effort

    elif client_info.client_type == "openai-responses":
        payload = {
            "model": orig_args.model,
            "input": [
                {"role": "system", "content": system_prompt},
                {
                    "role": "user",
                    "content": [
                        {"type": "input_text", "text": user_prompt},
                        *[
                            {"type": "input_image", "image_url": b64}
                            for b64 in base64_images
                        ],
                    ],
                },
            ],
            "temperature": temperature,
            "top_p": top_p,
            "max_output_tokens": max_tokens,
        }
        if extra_parameters:
            model_name: str = orig_args.model
            if "seed-1-6" in model_name:
                payload["extra_body"] = {}
                payload["extra_body"]["thinking"] = {"type": extra_parameters.thinking}
            else:
                payload["reasoning"] = {}
                payload["reasoning"]["effort"] = extra_parameters.reasoning_effort

    elif client_info.client_type == "mistral":
        payload = {
            "model": orig_args.model,
            "messages": messages,
            "temperature": temperature,
            "top_p": top_p,
            "top_k": top_k,
            "max_tokens": max_tokens,
        }

    elif client_info.client_type == "anthropic":
        anthropic_messages = [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": user_prompt},
                    *[
                        {"type": "image", "source": parse_base64_image(b64)}
                        for b64 in base64_images
                    ],
                ],
            },
        ]
        payload = {
            "model": orig_args.model,
            "system": [{"text": system_prompt, "type": "text"}],
            "messages": anthropic_messages,
            "temperature": temperature,
            "top_p": top_p,
            "top_k": top_k,
            "max_tokens": max_tokens,
            "thinking": {"type": "disabled"},
        }
        if extra_parameters and extra_parameters.thinking == "enabled":
            payload["thinking"] = {"type": extra_parameters.thinking}
            if extra_parameters.reasoning_effort and extra_parameters.reasoning_effort != "minimal":
                effort_token = {"low": 1024, "medium": 2048, "high": 4096}
                payload["thinking"]["budget_tokens"] = effort_token.get(
                    extra_parameters.reasoning_effort, 1024
                )
            else:
                payload["thinking"] = {"type": "disabled"}
    else:
        raise ValueError("The client type is not supported.")

    # Call the API
    try:
        response = client_info.chat_func(**payload)
    except Exception as e:
        raise RuntimeError(f"Error in chat completion: {e}") from e

    # Parse the response
    if client_info.client_type in ["openai", "mistral"]:
        result: str = response.choices[0].message.content
    elif client_info.client_type == "openai-responses":
        result: str = response.output_text
    elif client_info.client_type == "ollama":
        result: str = response.message.content
    elif client_info.client_type == "anthropic":
        result: str = response.content[0].text
    else:
        raise ValueError("The message type is not supported.")
    return result


# ─── ComfyUI Node Definitions ───────────────────────────────────

class GlowAPILLMLoader:
    """Load the LLM client."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "base_url": ("STRING", {
                    "default": "https://api.openai.com/v1",
                    "multiline": False,
                }),
                "api_key": ("STRING", {
                    "default": "sk-1234567890",
                    "multiline": False,
                }),
                "model_name": ("STRING", {
                    "default": "gpt-4o",
                    "multiline": False,
                }),
                "client_type": (["openai", "openai-responses", "mistral", "ollama", "anthropic"], {
                    "default": "openai",
                }),
            },
            "optional": {
                "proxy": ("STRING", {
                    "default": "",
                    "multiline": False,
                    "tooltip": "HTTP proxy URL, e.g. http://127.0.0.1:7890",
                }),
            },
        }

    RETURN_TYPES = ("CLIENT_INFO",)
    RETURN_NAMES = ("client_info",)
    FUNCTION = "execute"
    CATEGORY = "GlowLoader/LLM"

    def execute(self, base_url, api_key, model_name, client_type, proxy=""):
        proxy_url = proxy.strip() if proxy and proxy.strip() else None
        client_info = init_client(
            client_type=client_type,
            base_url=base_url,
            api_key=api_key,
            model=model_name,
            proxy=proxy_url,
        )
        return (client_info,)


class GlowExtraParameters:
    """Extra parameters for chat completion (thinking mode control)."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "thinking": (["disabled", "enabled"], {
                    "default": "disabled",
                }),
                "reasoning_effort": (["minimal", "low", "medium", "high"], {
                    "default": "medium",
                }),
            },
        }

    RETURN_TYPES = ("EXTRA_PARAMETERS",)
    RETURN_NAMES = ("extra_parameters",)
    FUNCTION = "execute"
    CATEGORY = "GlowLoader/LLM"

    def execute(self, thinking, reasoning_effort):
        return (ExtraParameters(thinking=thinking, reasoning_effort=reasoning_effort),)


class GlowAPIChat:
    """Chat with the LLM model via API."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "client_info": ("CLIENT_INFO",),
                "system_prompt": ("STRING", {
                    "default": "You are a helpful assistant.",
                    "multiline": True,
                }),
                "user_prompt": ("STRING", {
                    "default": "Hello world!",
                    "multiline": True,
                }),
                "temperature": ("FLOAT", {
                    "default": 1.0, "min": 0.0, "max": 2.0, "step": 0.1,
                }),
                "top_p": ("FLOAT", {
                    "default": 0.95, "min": 0.0, "max": 2.0, "step": 0.1,
                }),
                "top_k": ("INT", {
                    "default": 40, "min": 1, "max": 99, "step": 1,
                }),
                "max_tokens": ("INT", {
                    "default": 1024, "min": 1, "max": 1000000, "step": 1,
                }),
                "unload_model_after_chat": ("BOOLEAN", {
                    "default": True,
                }),
                "enable_thinking": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "Enable thinking/reasoning mode (e.g. DeepSeek CoT).",
                }),
            },
            "optional": {
                "images": ("IMAGE",),
                "extra_parameters": ("EXTRA_PARAMETERS",),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("response",)
    FUNCTION = "execute"
    CATEGORY = "GlowLoader/LLM"

    def execute(self, client_info, system_prompt, user_prompt, temperature, top_p, top_k, max_tokens, unload_model_after_chat, enable_thinking, images=None, extra_parameters=None):
        pil_images = None
        if images is not None:
            pil_images = [tensor_to_pil(img) for img in images]

        # Build extra_parameters: node toggle takes priority, then fall back to connected node
        if extra_parameters is None:
            extra_parameters = ExtraParameters(
                thinking="enabled" if enable_thinking else "disabled",
                reasoning_effort="medium",
            )
        elif enable_thinking and extra_parameters.thinking == "disabled":
            # Node toggle overrides to enabled
            extra_parameters.thinking = "enabled"

        response = chat_completion(
            client_info=client_info,
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            images=pil_images,
            temperature=temperature,
            top_p=top_p,
            top_k=top_k,
            max_tokens=max_tokens,
            unload_after_chat=unload_model_after_chat,
            extra_parameters=extra_parameters,
        )
        return (response,)


class GlowCaptioner:
    """Image captioning via LLM API."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "client_info": ("CLIENT_INFO",),
                "image": ("IMAGE",),
                "language": ("STRING", {
                    "default": "English",
                    "multiline": False,
                }),
                "num_max_sentences": ("INT", {
                    "default": 10, "min": 1, "max": 100, "step": 1,
                }),
                "unload_model_after_chat": ("BOOLEAN", {
                    "default": True,
                }),
                "enable_thinking": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "Enable thinking/reasoning mode (e.g. DeepSeek CoT).",
                }),
            },
            "optional": {
                "extra_parameters": ("EXTRA_PARAMETERS",),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("caption",)
    FUNCTION = "execute"
    CATEGORY = "GlowLoader/LLM"

    def execute(self, client_info, image, language, num_max_sentences, unload_model_after_chat, enable_thinking, extra_parameters=None):
        pil_image = tensor_to_pil(image)

        # Build extra_parameters: node toggle takes priority, then fall back to connected node
        if extra_parameters is None:
            extra_parameters = ExtraParameters(
                thinking="enabled" if enable_thinking else "disabled",
                reasoning_effort="medium",
            )
        elif enable_thinking and extra_parameters.thinking == "disabled":
            extra_parameters.thinking = "enabled"

        system_prompt = (
            "As a professional image annotator, "
            "your primary task is to generate a detailed and natural caption for the input image, "
            "focusing on authenticity and accuracy without any generalizations. "
            "Write the caption in descriptive, flowing text, "
            "avoiding structured formats or rich text elements. "
            "Enrich the description by including specific object attributes, "
            "visual relationships between objects, and environmental context "
            "to provide a comprehensive view. "
            "If any text is visible in the image, identify it exactly as seen "
            "and highlight it within the caption using quotation marks, "
            "without translating or explaining the content. "
            "Ensure all details are grounded in what is actually present, "
            "maintaining a truthful representation of the scene. "
            "This approach guarantees a clear and informative caption "
            "that captures the essence of the image effectively."
        )
        user_prompt = (
            f"Here's the user's input. Please generate a detailed caption for the image in language {language} "
            f"with maximum {num_max_sentences} sentences."
        )

        response = chat_completion(
            client_info=client_info,
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            images=[pil_image],
            temperature=1.0,
            top_p=0.7,
            max_tokens=4096,
            unload_after_chat=unload_model_after_chat,
            extra_parameters=extra_parameters,
        )
        return (response,)


class GlowGenerateBBOX:
    """Generate bounding boxes based on LLM's grounding ability."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "client_info": ("CLIENT_INFO",),
                "items": ("STRING", {
                    "default": "dog",
                    "multiline": False,
                }),
                "unload_model_after_chat": ("BOOLEAN", {
                    "default": True,
                }),
                "image": ("IMAGE",),
            },
        }

    RETURN_TYPES = ("BBOX", "IMAGE")
    RETURN_NAMES = ("bbox", "bbox_preview")
    FUNCTION = "execute"
    CATEGORY = "GlowLoader/LLM"

    def execute(self, client_info, items, unload_model_after_chat, image):
        pil_image = tensor_to_pil(image)

        system_prompt = "You are a professional image grounding assistant."
        user_prompt = (
            f"Please locate the item '{items}' in the image accurately. "
            "Response in coordinate of the bounding box. "
            "The format is <bbox>x_min y_min x_max y_max</bbox> in percentage(0-1000). "
            "If there are multiple items, please list all bounding boxes. "
        )

        extra_parameters = ExtraParameters(thinking="enabled", reasoning_effort="medium")

        response = chat_completion(
            client_info=client_info,
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            images=[pil_image],
            temperature=1.0,
            top_p=0.7,
            max_tokens=4096,
            unload_after_chat=unload_model_after_chat,
            extra_parameters=extra_parameters,
        )

        bboxes = []
        for bbox in re.findall(r"<bbox>(.*?)</bbox>", response):
            bbox = [int(x) for x in bbox.split()]
            if len(bbox) != 4:
                raise ValueError("BBox is invalid. Please retry.")
            x_min, y_min, x_max, y_max = tuple(bbox)
            w, h = pil_image.size
            bboxes.append([
                int(x_min * w / 1000),
                int(y_min * h / 1000),
                int((x_max - x_min) * w / 1000),
                int((y_max - y_min) * h / 1000),
            ])

        draw_image = pil_image.copy()
        draw = ImageDraw.Draw(draw_image)
        for bbox in bboxes:
            if len(bbox) == 4:
                x1, y1, x2, y2 = bbox
                draw.rectangle([x1, y1, x1 + x2, y1 + y2], outline="red", width=2)

        result_image = pil_to_tensor(draw_image)
        return (bboxes, result_image)


class GlowApplyChatTemplate:
    """Apply chat template for local model text generation."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "system_prompt": ("STRING", {
                    "default": "You are a helpful assistant.",
                    "multiline": True,
                }),
                "user_prompt": ("STRING", {
                    "default": "",
                    "multiline": True,
                }),
                "chat_template": ("STRING", {
                    "default": "",
                    "multiline": True,
                    "tooltip": "Chat template from model's HuggingFace repo.",
                }),
            },
            "optional": {
                "image": ("IMAGE",),
                "video": ("IMAGE", {"tooltip": "Video frames as image batch."}),
                "audio": ("AUDIO",),
                "extra_parameters": ("EXTRA_PARAMETERS",),
            },
        }

    RETURN_TYPES = ("IMAGE", "IMAGE", "AUDIO", "STRING")
    RETURN_NAMES = ("image", "video", "audio", "formatted_prompt")
    FUNCTION = "execute"
    CATEGORY = "GlowLoader/LLM"

    def execute(self, system_prompt, user_prompt, chat_template, image=None, video=None, audio=None, extra_parameters=None):
        from jinja2 import Environment, StrictUndefined

        _num_images = image.shape[0] if image is not None else 0
        _num_video = len(video) if isinstance(video, list) else 1 if video is not None else 0
        _num_audio = len(audio) if isinstance(audio, list) else 1 if audio is not None else 0

        _user_contents = (
            [{"type": "image", "image": f"https://dummy.site/image{i}.png"} for i in range(_num_images)]
            + [{"type": "video", "image": f"https://dummy.site/video{i}.mp4"} for i in range(_num_video)]
            + [{"type": "audio", "image": f"https://dummy.site/audio{i}.wav"} for i in range(_num_audio)]
            + [{"type": "text", "text": user_prompt}]
        )

        _base_payload = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": _user_contents},
        ]

        env = Environment(undefined=StrictUndefined, trim_blocks=True, lstrip_blocks=True)
        template = env.from_string(chat_template)

        extra = {}
        if extra_parameters is not None:
            extra["reasoning_effort"] = extra_parameters.reasoning_effort
            extra["thinking"] = bool(extra_parameters.thinking == "enabled")

        _formatted_prompt = template.render(messages=_base_payload, tools=None, add_generation_prompt=True, **extra)

        return (image, video, audio, _formatted_prompt)
