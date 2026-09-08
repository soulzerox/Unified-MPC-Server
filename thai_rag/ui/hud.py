"""Always-on-Top Floating HUD & System Tray for Thai RAG Indexing Progress."""
import os
import sys
import time
import json
import socket
import select
import threading
import queue
from pathlib import Path
import tkinter as tk
from tkinter import font as tkfont

PROGRESS_SOCK_PATH = Path.home() / ".cache" / "thai-rag-mcp" / "progress.sock"

# Try importing pystray and PIL for system tray support
HAS_TRAY = False
try:
    from PIL import Image, ImageDraw
    import pystray
    HAS_TRAY = True
except Exception:
    HAS_TRAY = False


def create_tray_icon_image(percent: float = 0.0):
    """Generate a clean 64x64 tray icon with progress ring."""
    image = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    
    # Background circle
    draw.ellipse((4, 4, 60, 60), fill=(30, 30, 46, 240), outline=(49, 50, 68, 255), width=2)
    
    # Progress arc
    if percent > 0:
        angle = int((percent / 100.0) * 360)
        draw.arc((8, 8, 56, 56), start=-90, end=-90 + angle, fill=(137, 180, 250, 255), width=4)
        
    # Center dot/symbol
    draw.ellipse((26, 26, 38, 38), fill=(166, 227, 161, 255))
    return image


class HUDWindow:
    def __init__(self, root: tk.Tk, event_queue: queue.Queue):
        self.root = root
        self.event_queue = event_queue
        self.tray_icon = None
        self.is_visible = True
        self.drag_start_x = 0
        self.drag_start_y = 0

        # Colors (Catppuccin Mocha)
        self.bg_color = "#1e1e2e"
        self.surface_color = "#252538"
        self.border_color = "#313244"
        self.text_main = "#cdd6f4"
        self.text_sub = "#a6adc8"
        self.text_muted = "#6c7086"
        self.accent_blue = "#89b4fa"
        self.accent_green = "#a6e3a1"
        self.accent_orange = "#fab387"

        self.is_closing = False
        self.last_activity = time.time()

        self.init_window()
        self.init_widgets()
        self.init_tray()
        self.poll_events()

    def init_window(self):
        self.root.overrideredirect(True)
        self.root.wm_attributes("-topmost", True)
        self.root.configure(bg=self.border_color)

        # Dimensions & screen placement (Bottom Right corner)
        width = 390
        height = 135
        screen_w = self.root.winfo_screenwidth()
        screen_h = self.root.winfo_screenheight()
        x = max(10, screen_w - width - 25)
        y = max(10, screen_h - height - 55)
        self.root.geometry(f"{width}x{height}+{x}+{y}")

        # Drag-to-move support anywhere on the card
        self.root.bind("<Button-1>", self.on_drag_start)
        self.root.bind("<B1-Motion>", self.on_drag_motion)

    def init_widgets(self):
        # Inner container for 1px border effect
        self.frame = tk.Frame(self.root, bg=self.bg_color, padx=12, pady=10)
        self.frame.pack(fill="both", expand=True, padx=1, pady=1)

        # Bind drag events to inner frame as well
        self.frame.bind("<Button-1>", self.on_drag_start)
        self.frame.bind("<B1-Motion>", self.on_drag_motion)

        # Row 1: Header + Close Button
        header_frame = tk.Frame(self.frame, bg=self.bg_color)
        header_frame.pack(fill="x", side="top")
        header_frame.bind("<Button-1>", self.on_drag_start)
        header_frame.bind("<B1-Motion>", self.on_drag_motion)

        title_lbl = tk.Label(
            header_frame,
            text="⚡ Thai RAG Indexer",
            font=("DejaVu Sans", 10, "bold"),
            fg=self.accent_blue,
            bg=self.bg_color,
        )
        title_lbl.pack(side="left")
        title_lbl.bind("<Button-1>", self.on_drag_start)
        title_lbl.bind("<B1-Motion>", self.on_drag_motion)

        self.percent_lbl = tk.Label(
            header_frame,
            text="0%",
            font=("DejaVu Sans", 10, "bold"),
            fg=self.accent_green,
            bg=self.bg_color,
        )
        self.percent_lbl.pack(side="left", padx=8)

        # Header action buttons (Minimize to Tray & Exit)
        btn_box = tk.Frame(header_frame, bg=self.bg_color)
        btn_box.pack(side="right")

        # Minimize to System Tray button
        min_btn = tk.Label(
            btn_box,
            text="—",
            font=("DejaVu Sans", 9, "bold"),
            fg=self.text_muted,
            bg=self.bg_color,
            cursor="hand2",
            padx=4,
        )
        min_btn.pack(side="left")
        min_btn.bind("<Button-1>", lambda e: self.hide_window())
        min_btn.bind("<Enter>", lambda e: min_btn.config(fg=self.accent_blue))
        min_btn.bind("<Leave>", lambda e: min_btn.config(fg=self.text_muted))

        # Close / Exit button
        close_btn = tk.Label(
            btn_box,
            text="✕",
            font=("DejaVu Sans", 10, "bold"),
            fg=self.text_muted,
            bg=self.bg_color,
            cursor="hand2",
            padx=4,
        )
        close_btn.pack(side="left")
        close_btn.bind("<Button-1>", lambda e: self.close_app())
        close_btn.bind("<Enter>", lambda e: close_btn.config(fg="#f38ba8"))
        close_btn.bind("<Leave>", lambda e: close_btn.config(fg=self.text_muted))

        # Row 2: Current File Label
        self.file_lbl = tk.Label(
            self.frame,
            text="Starting indexer...",
            font=("DejaVu Sans", 9),
            fg=self.text_sub,
            bg=self.bg_color,
            anchor="w",
        )
        self.file_lbl.pack(fill="x", pady=(6, 4))
        self.file_lbl.bind("<Button-1>", self.on_drag_start)
        self.file_lbl.bind("<B1-Motion>", self.on_drag_motion)

        # Row 3: Progress Bar (Canvas)
        self.canvas = tk.Canvas(
            self.frame,
            height=8,
            bg=self.surface_color,
            highlightthickness=0,
            bd=0,
        )
        self.canvas.pack(fill="x", pady=(2, 6))
        self.bar_id = self.canvas.create_rectangle(0, 0, 0, 8, fill=self.accent_blue, width=0)

        # Row 4: Details (Queue count & ETA)
        details_frame = tk.Frame(self.frame, bg=self.bg_color)
        details_frame.pack(fill="x", side="bottom")
        details_frame.bind("<Button-1>", self.on_drag_start)
        details_frame.bind("<B1-Motion>", self.on_drag_motion)

        self.queue_lbl = tk.Label(
            details_frame,
            text="Initializing queue...",
            font=("DejaVu Sans", 8),
            fg=self.text_muted,
            bg=self.bg_color,
        )
        self.queue_lbl.pack(side="left")

        self.eta_lbl = tk.Label(
            details_frame,
            text="⏱️ ETA: calculating...",
            font=("DejaVu Sans", 8, "bold"),
            fg=self.accent_orange,
            bg=self.bg_color,
        )
        self.eta_lbl.pack(side="right")

    def init_tray(self):
        if not HAS_TRAY:
            return

        def run_tray():
            menu = pystray.Menu(
                pystray.MenuItem("Show HUD", lambda: self.root.after(0, self.show_window), default=True),
                pystray.MenuItem("Hide HUD", lambda: self.root.after(0, self.hide_window)),
                pystray.MenuItem("Exit", lambda: self.root.after(0, self.close_app)),
            )
            img = create_tray_icon_image(0)
            self.tray_icon = pystray.Icon("thai_rag", img, "Thai RAG Indexer", menu)
            try:
                self.tray_icon.run()
            except Exception:
                pass

        t = threading.Thread(target=run_tray, daemon=True)
        t.start()

    def update_progress(self, percent: float, file_name: str, queue_str: str, eta_str: str):
        self.last_activity = time.time()
        # Truncate filename if needed
        max_chars = 44
        disp_name = file_name
        if len(disp_name) > max_chars:
            disp_name = "..." + disp_name[-(max_chars - 3):]

        self.percent_lbl.config(text=f"{percent:.1f}%")
        self.file_lbl.config(text=disp_name)
        self.queue_lbl.config(text=queue_str)
        self.eta_lbl.config(text=f"⏱️ ETA: ~{eta_str}")

        # Update progress bar fill
        canvas_w = self.canvas.winfo_width()
        if canvas_w <= 1:
            canvas_w = 360
        fill_w = int((percent / 100.0) * canvas_w)
        self.canvas.coords(self.bar_id, 0, 0, fill_w, 8)

        # Update tray if available
        if self.tray_icon:
            try:
                self.tray_icon.title = f"Thai RAG: {percent:.0f}% (ETA: {eta_str})"
            except Exception:
                pass

    def on_drag_start(self, event):
        self.drag_start_x = event.x
        self.drag_start_y = event.y

    def on_drag_motion(self, event):
        deltax = event.x - self.drag_start_x
        deltay = event.y - self.drag_start_y
        x = self.root.winfo_x() + deltax
        y = self.root.winfo_y() + deltay
        self.root.geometry(f"+{x}+{y}")

    def toggle_window(self):
        if self.is_visible:
            self.hide_window()
        else:
            self.show_window()

    def hide_window(self):
        self.root.withdraw()
        self.is_visible = False

    def show_window(self):
        self.root.deiconify()
        self.root.wm_attributes("-topmost", True)
        self.is_visible = True

    def poll_events(self):
        try:
            while True:
                data = self.event_queue.get_nowait()
                self.last_activity = time.time()
                ev_type = data.get("event_type")

                if ev_type == "start":
                    total = data.get("total_files", 0)
                    self.show_window()
                    self.update_progress(0.0, "Preparing workspace...", f"0 / {total} files", "calculating...")

                elif ev_type == "progress":
                    pct = data.get("percent", 0.0)
                    fname = data.get("file_name", "")
                    idx = data.get("current_index", 0)
                    tot = data.get("total_files", 0)
                    rem = data.get("remaining_files", 0)
                    eta = data.get("eta_str", "0s")
                    q_str = f"File {idx}/{tot} ({rem} left)"
                    self.update_progress(pct, fname, q_str, eta)

                elif ev_type == "finish":
                    self.is_closing = True
                    self.canvas.itemconfig(self.bar_id, fill=self.accent_green)
                    canvas_w = self.canvas.winfo_width() or 360
                    self.canvas.coords(self.bar_id, 0, 0, canvas_w, 8)
                    self.percent_lbl.config(text="100%", fg=self.accent_green)
                    self.file_lbl.config(text="✅ Indexing Completed Successfully!")
                    self.queue_lbl.config(text=data.get("summary", "Complete"))
                    self.eta_lbl.config(text="Done 🎉", fg=self.accent_green)
                    
                    if self.tray_icon:
                        try:
                            self.tray_icon.title = "Thai RAG: Indexing Complete"
                        except Exception:
                            pass

                    # Auto-dismiss after 1.5 seconds and cleanly terminate process
                    self.root.after(1500, self.close_app)

                elif ev_type == "disconnected":
                    # Client disconnected: if not already closing, auto dismiss after 1.2 seconds
                    if not self.is_closing:
                        self.is_closing = True
                        self.root.after(1200, self.close_app)

                elif ev_type == "error":
                    self.is_closing = True
                    self.canvas.itemconfig(self.bar_id, fill="#f38ba8")
                    self.file_lbl.config(text=f"⚠️ {data.get('summary', 'Error')}", fg="#f38ba8")
                    self.root.after(3000, self.close_app)

        except queue.Empty:
            pass

        # Inactivity watchdog: close if idle for > 45s without activity
        if not self.is_closing and (time.time() - self.last_activity > 45.0):
            self.close_app()
            return

        self.root.after(40, self.poll_events)

    def close_app(self):
        if self.is_closing and hasattr(self, "_already_closed"):
            os._exit(0)
        self.is_closing = True
        self._already_closed = True

        if self.tray_icon:
            try:
                self.tray_icon.stop()
            except Exception:
                pass
        if PROGRESS_SOCK_PATH.exists():
            try:
                PROGRESS_SOCK_PATH.unlink()
            except Exception:
                pass
        try:
            self.root.quit()
        except Exception:
            pass
        try:
            self.root.destroy()
        except Exception:
            pass
        # Guarantee full process exit so no zombie HUD processes linger
        os._exit(0)


def socket_server_thread(event_queue: queue.Queue):
    """Listens for connections on ~/.cache/thai-rag-mcp/progress.sock."""
    PROGRESS_SOCK_PATH.parent.mkdir(parents=True, exist_ok=True)
    if PROGRESS_SOCK_PATH.exists():
        try:
            PROGRESS_SOCK_PATH.unlink()
        except Exception:
            pass

    server_sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server_sock.bind(str(PROGRESS_SOCK_PATH))
    server_sock.listen(5)
    server_sock.settimeout(0.5)

    buffer = ""
    while True:
        try:
            conn, _ = server_sock.accept()
        except socket.timeout:
            continue
        except Exception:
            break

        conn.setblocking(False)
        while True:
            r, _, _ = select.select([conn], [], [], 0.2)
            if not r:
                continue
            try:
                chunk = conn.recv(4096)
                if not chunk:
                    event_queue.put({"event_type": "disconnected"})
                    break
                buffer += chunk.decode("utf-8", errors="ignore")
                while "\n" in buffer:
                    line, buffer = buffer.split("\n", 1)
                    line = line.strip()
                    if line:
                        try:
                            data = json.loads(line)
                            event_queue.put(data)
                        except Exception:
                            pass
            except Exception:
                event_queue.put({"event_type": "disconnected"})
                break
        try:
            conn.close()
        except Exception:
            pass

    try:
        server_sock.close()
    except Exception:
        pass
    if PROGRESS_SOCK_PATH.exists():
        try:
            PROGRESS_SOCK_PATH.unlink()
        except Exception:
            pass


def simulate_demo(event_queue: queue.Queue):
    """Simulate indexing progress for visual testing."""
    total = 35
    event_queue.put({"event_type": "start", "total_files": total})
    time.sleep(0.5)

    sample_files = [
        "src/ui/wizard/promptpay-frame.ts",
        "src/webtrans/server-url.ts",
        "src/storage/sqlite_manager.py",
        "src/components/CheckoutModal.tsx",
        "src/api/payment_webhook.py",
        "src/models/user_profile.py",
        "docs/architecture/flow.md",
        "tests/test_integration.py",
    ]

    for i in range(1, total + 1):
        time.sleep(0.12)
        fname = sample_files[(i - 1) % len(sample_files)]
        pct = round((i / total) * 100, 1)
        rem = total - i
        eta = f"{int(rem * 0.12)}s"
        event_queue.put({
            "event_type": "progress",
            "file_name": fname,
            "current_index": i,
            "total_files": total,
            "remaining_files": rem,
            "percent": pct,
            "eta_str": eta,
        })

    time.sleep(0.3)
    event_queue.put({
        "event_type": "finish",
        "summary": f"Indexed {total} files in 4.5s",
    })


def main():
    if not (os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")):
        sys.exit(0)

    event_queue = queue.Queue()

    if len(sys.argv) > 1 and sys.argv[1] == "--demo":
        sim_t = threading.Thread(target=simulate_demo, args=(event_queue,), daemon=True)
        sim_t.start()
    else:
        # Start socket listener thread
        sock_t = threading.Thread(target=socket_server_thread, args=(event_queue,), daemon=True)
        sock_t.start()

        # Wait briefly for socket creation
        for _ in range(20):
            if PROGRESS_SOCK_PATH.exists():
                break
            time.sleep(0.05)

    root = tk.Tk()
    app = HUDWindow(root, event_queue)
    try:
        root.mainloop()
    except Exception:
        pass
    finally:
        app.close_app()


if __name__ == "__main__":
    main()
