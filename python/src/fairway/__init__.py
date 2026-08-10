"""fairway — dev kit backend for local agent-backed apps (see PROTOCOL.md)."""

from . import events
from .backends import Backend, MySQLBackend, PostgresBackend, SQLiteBackend, backend_from_url
from .events import PROTOCOL_VERSION, TERMINAL_TYPES
from .fold import fold, fold_all
from .jobs import JobRegistry
from .router import mount_agent_chat
from .runner import Emit, Runner, TurnContext, TurnResult
from .store import Store

__all__ = [
    "events",
    "PROTOCOL_VERSION",
    "TERMINAL_TYPES",
    "fold",
    "fold_all",
    "JobRegistry",
    "mount_agent_chat",
    "Emit",
    "Runner",
    "TurnContext",
    "TurnResult",
    "Store",
    "Backend",
    "backend_from_url",
    "SQLiteBackend",
    "PostgresBackend",
    "MySQLBackend",
]
