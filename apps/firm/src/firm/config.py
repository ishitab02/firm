from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    procurer_url: str = "http://127.0.0.1:8787"
    #: Bearer token for the procurer. Unset on loopback; required once the
    #: procurer is reachable over a container network.
    procurer_auth_token: str | None = None
    vendor_index_path: Path = Path("../../data/vendor-index.json")
    database_url: str = "postgresql://firm:firm@127.0.0.1:5432/firm"
    firm_pricing_mode: Literal["QUOTED_AMOUNT", "TIERS"] = "TIERS"
    enable_treasury_books: bool = False
    treasury_books_url: str | None = Field(default=None)
    default_refund_address: str = "SIMULATED:refund-address"
    worker_stale_after_seconds: int = 300


@lru_cache
def get_settings() -> Settings:
    return Settings()
