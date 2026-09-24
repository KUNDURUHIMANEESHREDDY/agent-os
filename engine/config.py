from pathlib import Path
from typing import Optional
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "Loom AI Agent"
    environment: str = "development"
    
    # LLM Settings
    llm_provider: str = "deepseek"  # google, deepseek, groq, ollama, mock
    default_model: str = "deepseek-chat"
    temperature: float = 0.7
    max_tokens: int = 2048

    # API Keys & URLs
    google_api_key: Optional[str] = None
    deepseek_api_key: Optional[str] = None
    groq_api_key: Optional[str] = None
    nvidia_api_key: Optional[str] = None  # set via NVIDIA_API_KEY env, never hardcode
    ollama_base_url: str = "http://localhost:11434/v1"

    # agent-os: single LLM gateway (owns ROUTER_KEY + ollama fallback + mock).
    # All providers route here first; direct provider calls below are fallback only.
    gateway_url: str = "http://localhost:20129"
    gateway_enabled: bool = True
    gateway_timeout_s: float = 40.0

    # Paths
    data_dir: Path = Path(__file__).parent / "data"

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore"
    )


settings = Settings()
