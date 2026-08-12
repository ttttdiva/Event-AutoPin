from typing import Any, Dict, List, Optional, Tuple


Attempt = Dict[str, Any]


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
    primary_provider: Optional[str],
    primary_model: Optional[str],
    cli_model_map: Optional[Dict[str, str]],
    cli_effort_map: Optional[Dict[str, str]],
    fallback_provider: Optional[str],
    fallback_model: Optional[str],
    fallback_effort: Optional[str],
) -> List[Attempt]:
    attempts: List[Attempt] = []
    cli_model_map = cli_model_map or {}
    cli_effort_map = cli_effort_map or {}

    primary_kind, primary_name = split_primary_provider(primary_provider)
    if primary_kind == "cli":
        attempts.append(
            {
                "kind": "cli",
                "provider": primary_name,
                "model": cli_model_map.get(primary_name) or primary_model,
                "effort": cli_effort_map.get(primary_name),
            }
        )
    elif primary_model:
        attempts.append(
            {
                "kind": "api",
                "provider": primary_name,
                "model": primary_model,
            }
        )

    fallback_kind, fallback_name = split_fallback_provider(fallback_provider)
    if fallback_kind == "cli":
        attempts.append(
            {
                "kind": "cli",
                "provider": fallback_name,
                "model": fallback_model,
                "effort": fallback_effort,
            }
        )
    elif fallback_model:
        attempts.append(
            {
                "kind": "api",
                "provider": fallback_name,
                "model": fallback_model,
                "effort": fallback_effort,
            }
        )

    return attempts


def build_image_llm_attempts(
    primary_provider: Optional[str],
    primary_model: Optional[str],
    primary_effort: Optional[str],
    fallback_provider: Optional[str],
    fallback_model: Optional[str],
    fallback_effort: Optional[str],
) -> List[Attempt]:
    attempts: List[Attempt] = []

    primary_kind, primary_name = split_fallback_provider(primary_provider, "gemini")
    if primary_model:
        attempts.append(
            {
                "kind": primary_kind,
                "provider": primary_name,
                "model": primary_model,
                "effort": primary_effort,
            }
        )

    fallback_kind, fallback_name = split_fallback_provider(fallback_provider)
    if fallback_model:
        attempts.append(
            {
                "kind": fallback_kind,
                "provider": fallback_name,
                "model": fallback_model,
                "effort": fallback_effort,
            }
        )

    return attempts
