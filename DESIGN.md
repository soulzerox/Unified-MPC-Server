# Unified MCP Server — Obsidian Telemetry Design System

This document serves as the canonical single-source-of-truth (SSOT) for the visual language, user interface architecture, and aesthetic philosophy of the **Unified MCP Server** Local Control Plane and Telemetry SPA (`apps/web`).

---

## 1. Visual Theme & Atmosphere
- **Concept**: *Obsidian Mission Control* — A high-density, mission-critical telemetry interface built for software engineers, security architects, and AI agent operators.
- **Personality**: Precise, vigilant, technical, restrained, and calm under high throughput.
- **Emotional Intent**: The operator feels immediate confidence and spatial clarity. The interface communicates operational truth without decorative distractions or artificial delays.
- **Contrast Philosophy**: Deep obsidian canvas (`#090A0C`) with razor-sharp 1px structural dividers (`#1F2430`) and deliberate status luminescence (emerald `#10B981`, amber `#F59E0B`, rose `#EF4444`, and indigo `#6366F1`).

---

## 2. Color Palette & Semantic Roles

```css
:root {
  /* Canvas & Layers */
  --canvas:           #090A0C; /* Deepest obsidian backdrop */
  --surface-1:        #111318; /* Primary panel surface */
  --surface-2:        #181B22; /* Elevated container, table headers, form inputs */
  --surface-hover:    #222631; /* Interactive item hover state */
  --surface-active:   #2A303E; /* Active selection */

  /* Text & Content Hierarchy */
  --text-primary:     #E8EAED; /* High-contrast primary readings */
  --text-secondary:   #9AA0AE; /* Metadata, descriptions, captions */
  --text-muted:       #5F6570; /* Subtle labels, timestamps, structural borders */

  /* Structural Dividers */
  --border-subtle:    #1F2430; /* Hairline card borders and table dividers */
  --border-default:   #2C3241; /* Interactive input boundaries and active tabs */
  --border-accent:    #3B82F6; /* Focus rings and selected states */

  /* Telemetry Status Signals */
  --status-healthy:   #10B981; /* Healthy, connected, synced, passing */
  --status-syncing:   #F59E0B; /* In-flight sync, initializing, degraded */
  --status-offline:   #EF4444; /* Stopped, error, blocked, connection lost */
  --status-dormant:   #6366F1; /* Idle, optional, cached, background */

  /* Interactive Actions */
  --action-primary:   #3B82F6; /* Primary submit / execution */
  --action-danger:    #DC2626; /* Destructive actions (prune, delete, stop) */
  --action-success:   #10B981; /* Confirmed and applied */
  --action-ghost:     transparent; /* Secondary quiet actions */

  /* Font Families */
  --font-ui:          'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  --font-mono:        'JetBrains Mono', 'Fira Code', 'Menlo', monospace;
}
```

---

## 3. Typography Rules
- **Primary Body Font**: `Inter` — chosen for neutral geometric legibility at 12px–14px sizes.
- **Code / Telemetry Font**: `JetBrains Mono` — strictly used for server commands, PID/session IDs, protocol URLs, JSON payloads, and real-time logs.
- **Type Scale**:
  - **Title / Brand**: 16px / weight 600 / letter-spacing -0.015em
  - **Section Heading (h2)**: 12px / weight 600 / uppercase / letter-spacing +0.06em / color `--text-secondary`
  - **Modal Heading (h3)**: 16px / weight 600 / letter-spacing -0.01em / color `--text-primary`
  - **Body / Primary Cell**: 13px / weight 400 / line-height 1.5 / color `--text-primary`
  - **Secondary Metadata**: 12px / weight 400 / line-height 1.4 / color `--text-secondary`
  - **Micro Label / Badge**: 11px / weight 500 / mono / letter-spacing +0.02em
- **Line Length**: Max 72 characters for descriptive content.

---

## 4. Component Stylings

### Status LED Indicator
- 8x8px circle with a subtle 0 0 8px radial glow.
- Pulses rhythmically when `syncing` or `initializing`.
- Sharp solid glow when `healthy`, muted crimson when `offline`.

### Telemetry Cards
- Background: `var(--surface-1)`
- Border: 1px solid `var(--border-subtle)`
- Border-radius: `6px`
- Padding: `20px`
- Header: Flex layout with uppercase section title on the left and action buttons on the right.

### Segmented Navigation Tabs
- Clean horizontal bar with subtle bottom border.
- Active tab features a sharp 2px bottom highlight using `var(--action-primary)` and high-contrast `--text-primary`.
- Inactive tabs subtly highlight on hover without abrupt shifts.

### Data Tables
- Header: 12px uppercase, color `--text-muted`, 1px bottom border.
- Rows: 13px, padding 8px 12px, hover background `var(--surface-hover)` with 150ms transition.
- Cells: Monospaced treatment for technical IDs (`serverId`, transport, commands).

### Projects: Context vs Runtime Truth
- **Scope** and **Default** are Web/client context only. Render them with neutral/context styling; never use them as evidence that a project is Running.
- Runtime badges must come from authoritative Goal Runtime snapshots. If several Goal snapshots exist, show their exact runtime states/counts rather than collapsing them into one invented project status.
- Several registered projects may show `running` simultaneously. There is no global active-runtime indicator for Projects.
- A `goal-runtime-event` SSE delta is an invalidation signal for the WebUI, not permission to reimplement the runtime projector in the browser. Refresh the bounded authoritative snapshot and wait for that Goal snapshot's `lastEventSequence` to cover the durable event before presenting the new projection.
- While projection coverage is catching up, keep the last authoritative snapshot visible and label the lag neutrally. Do not fabricate completion or a newer runtime state.
- `integrationState: unknown` and `workspaceState: unknown` must remain visibly unknown until authoritative evidence changes them.
- Preferred Goal selection is a context affordance labeled **Select Goal**; it does not start, resume, pause, or own execution.

### Modal Dialogs
- Backdrop: `rgba(0, 0, 0, 0.75)` with `backdrop-filter: blur(6px)`.
- Content: Centered, max-width 540px, `var(--surface-1)` with `var(--border-default)`.
- Smooth fade-in and scale entrance (`150ms ease-out`).

### Telemetry Stream Terminal (Logs View)
- Monospaced terminal container with `var(--surface-1)` and deep inset styling.
- Colored log levels: `[INFO]` (blue), `[SUCCESS]` (emerald), `[WARN]` (amber), `[ERROR]` (rose).
- Auto-scroll lock toggle, level filters, and quick copy-to-clipboard button.

---

## 5. Layout & Spacing
- **Baseline Grid**: 4px / 8px baseline rhythm.
- **Spacing Scale**: 4px, 8px, 12px, 16px, 20px, 24px, 32px, 48px.
- **Max Width**: 1280px container centered with 24px padding.
- **Dashboard Grid**: Two-column responsive layout:
  - Main Telemetry Stage: `2fr` (Status, Topology Canvas, Servers, Skills, Policies)
  - Mission Control Sidebar: `1fr` (ChatGPT Web Bridge Gating, Bifurcated Ingestion CTAs, Quick Stats)
- **Full View Mode**: Tab views (Servers, Skills, Install, Policies, ChatGPT Web, Logs) expand to 100% width for maximum information bandwidth.

---

## 6. Depth & Elevation
- **Hairline Precision**: Rely primarily on 1px crisp borders (`var(--border-subtle)`) with 1-2 tone contrast differences between canvas and surfaces.
- **Shadow Tokens**:
  - Modal: `0 12px 36px rgba(0, 0, 0, 0.7)`
  - Toast: `0 4px 16px rgba(0, 0, 0, 0.6)`
  - Dropdown/Popover: `0 6px 20px rgba(0, 0, 0, 0.5)`
- **No Heavy Blurred Dropshadows**: Never use muddy 20px+ soft grey drop shadows on cards.

---

## 7. Do's and Don'ts (Anti-AI Slop Guardrails)
- ❌ **DON'T** use purple or pink gradients on buttons, headers, or backgrounds.
- ❌ **DON'T** use generic 16px or 24px border-radius on everything (maintain crisp 4px–6px radius).
- ❌ **DON'T** put all-caps tracked eyebrows with meaningless numbers (`01 / OVERVIEW`) on every section.
- ❌ **DON'T** use emojis as primary icons in production telemetry tables (use clean SVG or geometric indicators).
- ❌ **DON'T** render empty paragraphs or marketing buzzwords ("Revolutionize your AI workflow").
- ✅ **DO** show concrete operational data: loopback port, gateway connection state, target IDEs, exact server commands.
- ✅ **DO** provide clear confirmation dialogs before pruning servers or skills.
- ✅ **DO** enforce loopback Origin policy and display meaningful error toasts on 403 or 412 status codes.

---

## 8. Responsive Behavior
- **Mobile (< 640px)**:
  - Header brand stacks above navigation links.
  - Horizontal nav scrolls smoothly with overflow indicator.
  - Grid collapses to 1 column.
  - Tables enable horizontal scroll with sticky column indicators.
  - Minimum touch target: 44x44px.
- **Tablet (640px – 1024px)**:
  - Grid adjusts to single column or 3:2 layout.
- **Desktop (> 1024px)**:
  - Full two-column dashboard grid or full-width specialized views.

---

## 9. Agent Prompt Guide
When extending the UI, use these prompt patterns:
- *"Add a telemetry gauge card to the Dashboard view adhering strictly to DESIGN.md tokens."*
- *"Implement a new filter in the Servers view matching the existing table styling."*
- *"Create an export action for the Logs terminal following the button secondary styling rules."*

