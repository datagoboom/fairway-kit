"""fairway — backend library for the Agent Chat Protocol (see PROTOCOL.md)."""

from .events import PROTOCOL_VERSION, TERMINAL_TYPES
from .fold import fold, fold_all
from .jobs import JobRegistry
from .router import mount_agent_chat
from .runner import Emit, Runner, TurnContext, TurnResult
from .store import Store

__all__ = [
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
]
