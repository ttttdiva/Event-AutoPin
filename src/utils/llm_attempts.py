from typing import Any, Dict, List, Optional, Tuple


Attempt = Dict[str, Any]


# Keep all implicit routing defaults in one place.  Callers may still provide
# an explicit provider/model/effort, but an omitted value must never silently
# turn an image attempt into the Gemini API or inherit the text effort.
DEFAULT_TEXT_PRIMARY_PROVIDER = "api"
DEFAULT_TEXT_PRIMARY_MODEL = "gpt-5.6-luna"
DEFAULT_TEXT_PRIMARY_EFFORT = "max"
DEFAULT_TEXT_FALLBACK_PROVIDER = "cli:codex"
DEFAULT_TEXT_FALLBACK_MODEL = "gpt-5.5"
DEFAULT_TEXT_FALLBACK_EFFORT = "medium"

DEFAULT_IMAGE_PRIMARY_PROVIDER = "cli:antigravity"
DEFAULT_IMAGE_PRIMARY_MODEL = "gemini-3.8-flash-medium"
DEFAULT_IMAGE_PRIMARY_EFFORT = "none"
DEFAULT_IMAGE_FALLBACK_PROVIDER = "api:openai"
DEFAULT_IMAGE_FALLBACK_MODEL = "gpt-5.6-sol"
DEFAULT_IMAGE_FALLBACK_EFFORT = "medium"

# Short aliases are useful to integrations that refer to the contract as
# ``TEXT_PRIMARY_*``/``IMAGE_PRIMARY_*``.  Keep the canonical DEFAULT_* names
# above for readability in application code.
TEXT_PRIMARY_PROVIDER = DEFAULT_TEXT_PRIMARY_PROVIDER
TEXT_PRIMARY_MODEL = DEFAULT_TEXT_PRIMARY_MODEL
TEXT_PRIMARY_EFFORT = DEFAULT_TEXT_PRIMARY_EFFORT
IMAGE_PRIMARY_PROVIDER = DEFAULT_IMAGE_PRIMARY_PROVIDER
IMAGE_PRIMARY_MODEL = DEFAULT_IMAGE_PRIMARY_MODEL
IMAGE_PRIMARY_EFFORT = DEFAULT_IMAGE_PRIMARY_EFFORT
IMAGE_FALLBACK_PROVIDER = DEFAULT_IMAGE_FALLBACK_PROVIDER
IMAGE_FALLBACK_MODEL = DEFAULT_IMAGE_FALLBACK_MODEL
IMAGE_FALLBACK_EFFORT = DEFAULT_IMAGE_FALLBACK_EFFORT


def split_primary_provider(provider: Optional[str]) -> Tuple[str, str]:
    value = provider or "api"
    if value.startswith("api:"):
        return "api", value.split(":", 1)[1]
    if value.startswith("cli:"):
        return "cli", value.split(":", 1)[1]
    if value == "api":
        return "api", ""
    return "cli", value


def split_fallback_provider(provider: Optional[str], default_api_provider: str = "openai") -> Tuple[str, str]:
    value = provider or default_api_provider
    if value.startswith("api:"):
        return "api", value.split(":", 1)[1]
    if value.startswith("cli:"):
        return "cli", value.split(":", 1)[1]
    return "api", value


def unique_models(models: List[Optional[str]]) -> List[str]:
    result: List[str] = []
    for model in models:
        if model and model not in result:
            result.append(model)
    return result


def api_models_from_attempts(attempts: List[Attempt]) -> List[str]:
    return unique_models(
        [
            attempt.get("model")
            for attempt in attempts
            if attempt.get("kind") == "api"
        ]
    )


def build_text_llm_attempts(
    primary_provider: Optional[str] = None,
    primary_model: Optional[str] = None,
    cli_model_map: Optional[Dict[str, str]] = None,
    cli_effort_map: Optional[Dict[str, str]] = None,
    fallback_provider: Optional[str] = None,
    fallback_model: Optional[str] = None,
    fallback_effort: Optional[str] = None,
    primary_effort: Optional[str] = None,
) -> List[Attempt]:
    attempts: List[Attempt] = []
    cli_model_map = cli_model_map or {}
    cli_effort_map = cli_effort_map or {}

    primary_was_omitted = not primary_provider
    primary_kind, primary_name = split_primary_provider(
        primary_provider or DEFAULT_TEXT_PRIMARY_PROVIDER
    )
    if primary_kind == "cli":
        attempts.append(
            {
                "kind": "cli",
                "provider": primary_name,
                "model": cli_model_map.get(primary_name) or primary_model,
                "effort": cli_effort_map.get(primary_name)
                or primary_effort
                or (DEFAULT_TEXT_PRIMARY_EFFORT if primary_was_omitted else None),
            }
        )
    elif primary_model or primary_was_omitted:
        attempts.append(
            {
                "kind": "api",
                "provider": primary_name,
                "model": primary_model or DEFAULT_TEXT_PRIMARY_MODEL,
                "effort": primary_effort
                or (DEFAULT_TEXT_PRIMARY_EFFORT if primary_was_omitted else None),
            }
        )

    effective_fallback_provider = fallback_provider or (
        DEFAULT_TEXT_FALLBACK_PROVIDER if primary_was_omitted else None
    )
    effective_fallback_model = fallback_model or (
        DEFAULT_TEXT_FALLBACK_MODEL if primary_was_omitted else None
    )
    effective_fallback_effort = fallback_effort or (
        DEFAULT_TEXT_FALLBACK_EFFORT if primary_was_omitted else None
    )
    fallback_kind, fallback_name = split_fallback_provider(effective_fallback_provider)
    if fallback_kind == "cli":
        attempts.append(
            {
                "kind": "cli",
                "provider": fallback_name,
                "model": effective_fallback_model,
                "effort": effective_fallback_effort,
            }
        )
    elif effective_fallback_model:
        attempts.append(
            {
                "kind": "api",
                "provider": fallback_name,
                "model": effective_fallback_model,
                "effort": effective_fallback_effort,
            }
        )

    return attempts


def build_image_llm_attempts(
    primary_provider: Optional[str] = None,
    primary_model: Optional[str] = None,
    primary_effort: Optional[str] = None,
    fallback_provider: Optional[str] = None,
    fallback_model: Optional[str] = None,
    fallback_effort: Optional[str] = None,
) -> List[Attempt]:
    attempts: List[Attempt] = []

    primary_was_omitted = not primary_provider and not primary_model and not primary_effort
    # A bare provider in the primary slot follows the primary-provider
    # contract (``antigravity`` is CLI).  The old implementation used the
    # fallback parser here and accidentally routed it to a Gemini API.
    effective_primary_provider = primary_provider or (
        DEFAULT_IMAGE_PRIMARY_PROVIDER if primary_was_omitted else None
    )
    primary_kind, primary_name = split_primary_provider(effective_primary_provider)
    effective_primary_model = primary_model or (
        DEFAULT_IMAGE_PRIMARY_MODEL if primary_was_omitted else None
    )
    effective_primary_effort = primary_effort or (
        DEFAULT_IMAGE_PRIMARY_EFFORT if primary_was_omitted else None
    )
    if effective_primary_provider and effective_primary_model:
        attempts.append(
            {
                "kind": primary_kind,
                "provider": primary_name,
                "model": effective_primary_model,
                "effort": effective_primary_effort,
            }
        )

    # For backwards compatibility, an explicit primary with no fallback
    # remains CLI/API single-attempt.  Fully omitted configuration gets the
    # new CLI-primary + OpenAI-Sol fallback contract.
    effective_fallback_provider = fallback_provider or (
        DEFAULT_IMAGE_FALLBACK_PROVIDER if primary_was_omitted else None
    )
    effective_fallback_model = fallback_model or (
        DEFAULT_IMAGE_FALLBACK_MODEL if primary_was_omitted else None
    )
    effective_fallback_effort = fallback_effort or (
        DEFAULT_IMAGE_FALLBACK_EFFORT if primary_was_omitted else None
    )
    fallback_kind, fallback_name = split_fallback_provider(effective_fallback_provider)
    if effective_fallback_provider and effective_fallback_model:
        attempts.append(
            {
                "kind": fallback_kind,
                "provider": fallback_name,
                "model": effective_fallback_model,
                "effort": effective_fallback_effort,
            }
        )

    return attempts
