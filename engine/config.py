from pathlib import Path
from typing import Optional

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "OVERLORD Engine"
    environment: str = "development"

    # Model execution is centralized. No direct provider SDK or local-model
    # fallback is permitted by the engine.
    llm_provider: str = "opencode"
    default_model: str = "auto"
    temperature: float = 0.7
    max_tokens: int = 2048

    # Central gateway owns OpenCode CLI execution, model allowlisting,
    # usage accounting, timeouts, and provider failure semantics.
    gateway_url: str = "http://localhost:20129"
    gateway_enabled: bool = True
    gateway_timeout_s: float = 100.0
    # Bearer token for the agent-os gateway (AGENT_OS_TOKEN env).
    gateway_token: Optional[str] = None

    # Paths
    data_dir: Path = Path(__file__).parent / "data"

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore"
    )


settings = Settings()
