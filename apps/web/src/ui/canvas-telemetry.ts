export function renderCanvasTopologySvg(): string {
  return `
  <div class="canvas-card" id="topology-canvas-container">
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
      <div style="display: flex; align-items: center; gap: 8px;">
        <span style="font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-secondary);">Control Plane Architecture</span>
      </div>
      <div class="mono" style="font-size: 11px; color: var(--text-muted);">
        Loopback Boundary: <span style="color: var(--text-primary);">127.0.0.1:18765</span> &bull; Full Bypass Guard
      </div>
    </div>
    <svg class="canvas-svg" viewBox="0 0 760 210" fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <!-- Background Grid Pattern -->
        <pattern id="grid-pattern" width="20" height="20" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="0.75" fill="#1F2430" />
        </pattern>
        <!-- Gradients -->
        <linearGradient id="core-glow" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#1E293B" />
          <stop offset="100%" stop-color="#0F172A" />
        </linearGradient>
        <linearGradient id="link-gradient" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stop-color="#3B82F6" stop-opacity="0.2" />
          <stop offset="50%" stop-color="#3B82F6" stop-opacity="0.8" />
          <stop offset="100%" stop-color="#10B981" stop-opacity="0.2" />
        </linearGradient>
        <filter id="glow-filter" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="3" result="blur" />
          <feComposite in="SourceGraphic" in2="blur" operator="over" />
        </filter>
      </defs>

      <!-- Background Pattern Fill -->
      <rect width="760" height="210" fill="url(#grid-pattern)" rx="6" />

      <!-- Interconnection Data Lines -->
      <!-- IDEs to Core -->
      <path d="M 130 60 C 200 60, 240 105, 300 105" stroke="#2C3241" stroke-width="1.5" stroke-dasharray="3 3" />
      <path d="M 130 150 C 200 150, 240 105, 300 105" stroke="#2C3241" stroke-width="1.5" stroke-dasharray="3 3" />

      <!-- Core to ChatGPT Gateway -->
      <path d="M 460 105 C 520 105, 560 60, 630 60" stroke="#2C3241" stroke-width="1.5" />
      <!-- Core to Policy & Downstream -->
      <path d="M 460 105 C 520 105, 560 150, 630 150" stroke="#2C3241" stroke-width="1.5" />

      <!-- Animated Pulse Particles on Lines -->
      <circle cx="215" cy="82" r="2.5" fill="#3B82F6" filter="url(#glow-filter)">
        <animate attributeName="opacity" values="0.3;1;0.3" dur="2s" repeatCount="indefinite" />
      </circle>
      <circle cx="545" cy="82" r="2.5" fill="#10B981" filter="url(#glow-filter)">
        <animate attributeName="opacity" values="1;0.3;1" dur="2.4s" repeatCount="indefinite" />
      </circle>
      <circle cx="545" cy="128" r="2.5" fill="#6366F1" filter="url(#glow-filter)">
        <animate attributeName="opacity" values="0.4;1;0.4" dur="3s" repeatCount="indefinite" />
      </circle>

      <!-- LEFT NODE: Host Clients & IDEs -->
      <g transform="translate(20, 35)">
        <rect width="110" height="50" rx="5" fill="#111318" stroke="#1F2430" stroke-width="1" />
        <circle cx="15" cy="25" r="4" fill="#3B82F6" />
        <text x="26" y="22" font-family="'JetBrains Mono', monospace" font-size="11" font-weight="600" fill="#E8EAED">MCP Clients</text>
        <text x="26" y="36" font-family="sans-serif" font-size="9" fill="#9AA0AE">Web / CLI / IDEs</text>
      </g>

      <g transform="translate(20, 125)">
        <rect width="110" height="50" rx="5" fill="#111318" stroke="#1F2430" stroke-width="1" />
        <circle cx="15" cy="25" r="4" fill="#3B82F6" />
        <text x="26" y="22" font-family="'JetBrains Mono', monospace" font-size="11" font-weight="600" fill="#E8EAED">Host Adapters</text>
        <text x="26" y="36" font-family="sans-serif" font-size="9" fill="#9AA0AE">Cline / OpenCode +</text>
      </g>

      <!-- CENTER NODE: Unified-MPC-Server Control Plane Core -->
      <g transform="translate(300, 70)">
        <rect width="160" height="70" rx="6" fill="url(#core-glow)" stroke="#2C3241" stroke-width="1.5" />
        <!-- Accent Status Stripe -->
        <rect x="0" y="0" width="3" height="70" rx="1.5" fill="#10B981" />
        <text x="14" y="26" font-family="'JetBrains Mono', monospace" font-size="12" font-weight="700" fill="#E8EAED">UNIFIED CONTROL</text>
        <text x="14" y="42" font-family="sans-serif" font-size="10" fill="#9AA0AE">Local Control Plane</text>
        <rect x="14" y="48" width="70" height="15" rx="3" fill="rgba(16, 185, 129, 0.15)" />
        <text x="19" y="59" font-family="'JetBrains Mono', monospace" font-size="8" font-weight="600" fill="#10B981">PORT: 18765</text>
        <rect x="90" y="48" width="56" height="15" rx="3" fill="rgba(59, 130, 246, 0.15)" />
        <text x="96" y="59" font-family="'JetBrains Mono', monospace" font-size="8" font-weight="600" fill="#60A5FA">ORIGIN: OK</text>
      </g>

      <!-- RIGHT TOP NODE: ChatGPT Companion Gateway -->
      <g transform="translate(630, 35)" id="canvas-gateway-node">
        <rect width="115" height="50" rx="5" fill="#111318" stroke="#1F2430" stroke-width="1" />
        <circle cx="15" cy="25" r="4" fill="#F59E0B" id="canvas-gateway-dot" />
        <text x="26" y="22" font-family="'JetBrains Mono', monospace" font-size="11" font-weight="600" fill="#E8EAED">CF Gateway</text>
        <text x="26" y="36" font-family="sans-serif" font-size="9" fill="#9AA0AE">ChatGPT Bridge</text>
      </g>

      <!-- RIGHT BOTTOM NODE: Subsystem Servers & Policy Engine -->
      <g transform="translate(630, 125)">
        <rect width="115" height="50" rx="5" fill="#111318" stroke="#1F2430" stroke-width="1" />
        <circle cx="15" cy="25" r="4" fill="#10B981" />
        <text x="26" y="22" font-family="'JetBrains Mono', monospace" font-size="11" font-weight="600" fill="#E8EAED">Policies & MCP</text>
        <text x="26" y="36" font-family="sans-serif" font-size="9" fill="#9AA0AE">P1-Pn Runtime Policy</text>
      </g>
    </svg>
  </div>
  `;
}

