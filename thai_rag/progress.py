"""Embedding & Indexing Progress Reporting via non-blocking IPC."""
from __future__ import annotations

import os
import sys
import time
import json
import socket
import subprocess
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Optional

PROGRESS_SOCK_PATH = Path.home() / ".cache" / "thai-rag-mcp" / "progress.sock"


def format_duration(seconds: float) -> str:
    """Format seconds into human-friendly duration (e.g. '1m 24s', '45s')."""
    if seconds <= 0:
        return "0s"
    if seconds < 60:
        return f"{int(seconds)}s"
    minutes = int(seconds // 60)
    secs = int(seconds % 60)
    if minutes < 60:
        return f"{minutes}m {secs:02d}s"
    hours = int(minutes // 60)
    mins = int(minutes % 60)
    return f"{hours}h {mins:02d}m"


@dataclass
class ProgressEvent:
    event_type: str  # "start", "progress", "finish", "error"
    file_name: str = ""
    current_index: int = 0
    total_files: int = 0
    percent: float = 0.0
    eta_seconds: float = 0.0
    eta_str: str = "0s"
    speed_s_per_file: float = 0.0
    remaining_files: int = 0
    skipped: bool = False
    chunks: int = 0
    summary: str = ""

    def to_json(self) -> str:
        return json.dumps(asdict(self)) + "\n"


class BaseProgressReporter:
    """Base interface for progress reporters."""

    def notify_start(self, total_files: int, workspace: str) -> None:
        pass

    def notify_step(
        self,
        file_name: str,
        index: int,
        total: int,
        skipped: bool = False,
        chunks: int = 0,
    ) -> None:
        pass

    def notify_finish(self, indexed: int, skipped: int, duration_s: float) -> None:
        pass

    def notify_error(self, message: str) -> None:
        pass

    def close(self) -> None:
        pass


class NullProgressReporter(BaseProgressReporter):
    """No-op progress reporter for unit tests and headless environments."""
    pass


class ProgressReporter(BaseProgressReporter):
    """Real-time progress reporter calculating EWMA ETA and broadcasting via IPC socket."""

    def __init__(
        self,
        sock_path: Path = PROGRESS_SOCK_PATH,
        alpha: float = 0.35,
        auto_launch_hud: bool = True,
    ):
        self.sock_path = Path(sock_path)
        self.alpha = alpha
        self.auto_launch_hud = auto_launch_hud
        self.sock: Optional[socket.socket] = None
        self.total_files = 0
        self.start_time = 0.0
        self.last_step_time = 0.0
        self.ewma_time_per_file = 0.0
        self._connected = False

    def _ensure_connection(self) -> bool:
        if self._connected and self.sock:
            return True

        # Check if GUI is feasible
        has_display = bool(os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY"))
        hud_disabled = os.environ.get("PROGRESS_HUD", "1").lower() in ("0", "false", "no")

        if not self.sock_path.exists():
            if self.auto_launch_hud and has_display and not hud_disabled:
                self._spawn_hud()
                # Brief pause to let socket initialize
                time.sleep(0.15)

        if not self.sock_path.exists():
            return False

        try:
            self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self.sock.settimeout(0.08)
            self.sock.connect(str(self.sock_path))
            self._connected = True
            return True
        except Exception:
            self.sock = None
            self._connected = False
            return False

    def _spawn_hud(self) -> None:
        """Launch background HUD process detached from current terminal/session."""
        try:
            cmd = [sys.executable, "-m", "thai_rag.ui.hud"]
            subprocess.Popen(
                cmd,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
                close_fds=True,
            )
        except Exception:
            pass

    def _send_event(self, event: ProgressEvent) -> None:
        if not self._ensure_connection() or not self.sock:
            return
        try:
            self.sock.sendall(event.to_json().encode("utf-8"))
        except Exception:
            # If socket fails (e.g. closed), mark disconnected
            try:
                if self.sock:
                    self.sock.close()
            except Exception:
                pass
            self.sock = None
            self._connected = False

    def notify_start(self, total_files: int, workspace: str) -> None:
        self.total_files = total_files
        self.start_time = time.time()
        self.last_step_time = self.start_time
        self.ewma_time_per_file = 0.0

        event = ProgressEvent(
            event_type="start",
            total_files=total_files,
            remaining_files=total_files,
            summary=f"Indexing workspace: {workspace}",
        )
        self._send_event(event)

    def notify_step(
        self,
        file_name: str,
        index: int,
        total: int,
        skipped: bool = False,
        chunks: int = 0,
    ) -> None:
        now = time.time()
        step_duration = max(0.001, now - self.last_step_time)
        self.last_step_time = now

        # Update EWMA only for actively processed files to keep ETA realistic
        if not skipped:
            if self.ewma_time_per_file <= 0.0:
                self.ewma_time_per_file = step_duration
            else:
                self.ewma_time_per_file = (
                    self.alpha * step_duration + (1.0 - self.alpha) * self.ewma_time_per_file
                )

        remaining = max(0, total - index)
        eta_sec = round(remaining * self.ewma_time_per_file, 1)
        percent = round((index / max(1, total)) * 100.0, 1)

        event = ProgressEvent(
            event_type="progress",
            file_name=file_name,
            current_index=index,
            total_files=total,
            percent=percent,
            eta_seconds=eta_sec,
            eta_str=format_duration(eta_sec),
            speed_s_per_file=round(self.ewma_time_per_file, 2),
            remaining_files=remaining,
            skipped=skipped,
            chunks=chunks,
        )
        self._send_event(event)

    def notify_finish(self, indexed: int, skipped: int, duration_s: float) -> None:
        event = ProgressEvent(
            event_type="finish",
            percent=100.0,
            eta_seconds=0.0,
            eta_str="Done",
            remaining_files=0,
            summary=f"Completed {indexed} indexed, {skipped} skipped in {duration_s:.1f}s",
        )
        self._send_event(event)
        self.close()

    def notify_error(self, message: str) -> None:
        event = ProgressEvent(
            event_type="error",
            summary=message,
        )
        self._send_event(event)
        self.close()

    def close(self) -> None:
        if self.sock:
            try:
                self.sock.close()
            except Exception:
                pass
            self.sock = None
        self._connected = False
