export function getClientScriptJs(): string {
  return `
    (function () {
      let activeTab = 'dashboard';
      let currentLogs = [];
      let cachedServers = [];
      let cachedSkills = [];
      let cachedPolicies = [];
      let cachedWorkspaces = [];
      let workspaceSelection = null;

      function showToast(message, isError = false) {
        const toast = document.getElementById('toast');
        if (!toast) return;
        toast.textContent = message;
        toast.style.borderColor = isError ? 'var(--status-offline)' : 'var(--action-primary)';
        toast.style.display = 'block';
        setTimeout(() => { toast.style.display = 'none'; }, 4000);
      }

      function errorMessage(data, fallback) {
        const error = data?.error ?? data?.message;
        if (typeof error === 'string') return error;
        if (error && typeof error.message === 'string') return error.message;
        return fallback;
      }

      async function mutationJson(url, init) {
        const res = await fetch(url, init);
        if (res.status === 401) {
          showToast('Dashboard session expired; reloading...', true);
          logEvent('WARN', 'Capability expired; reloading dashboard');
          window.location.reload();
        }
        return res;
      }

      function logEvent(level, msg) {
        const now = new Date();
        const timeStr = now.toTimeString().split(' ')[0];
        currentLogs.push({ time: timeStr, level, msg });
        renderLogs();
      }

      // Tab Routing
      function setTab(tabId) {
        activeTab = tabId;
        const tabs = ['dashboard', 'projects', 'servers', 'skills', 'install', 'policies', 'chatgpt', 'logs'];
        for (const t of tabs) {
          const navEl = document.getElementById('nav-' + t);
          const panelEl = document.getElementById('view-' + t);
          if (navEl) {
            if (t === tabId) navEl.classList.add('active');
            else navEl.classList.remove('active');
          }
          if (panelEl) {
            if (t === tabId) panelEl.classList.add('active');
            else panelEl.classList.remove('active');
          }
        }
        if (window.location.hash !== '#' + tabId) {
          history.replaceState(null, '', '#' + tabId);
        }
      }

      const tabs = ['dashboard', 'projects', 'servers', 'skills', 'install', 'policies', 'chatgpt', 'logs'];
      for (const t of tabs) {
        const navEl = document.getElementById('nav-' + t);
        if (navEl) {
          navEl.addEventListener('click', (e) => {
            e.preventDefault();
            setTab(t);
          });
        }
      }

      // Read initial hash if present
      const initialHash = window.location.hash.replace('#', '');
      if (tabs.includes(initialHash)) {
        setTab(initialHash);
      }

      async function loadStatus() {
        try {
          const res = await fetch('/api/status');
          if (!res.ok) throw new Error('Status request failed');
          const data = await res.json();
          const led = document.getElementById('status-led');
          if (led) led.className = 'led';
          const tel = document.getElementById('servers-telemetry');
          if (tel) {
            tel.innerHTML =
              '<div style="line-height: 1.8;">' +
              '<div>Status: <span style="color: var(--status-healthy);">' + data.status + '</span></div>' +
              '<div>Gateway State: ' + (data.gateway?.state || 'STOPPED') + '</div>' +
              '<div>Local Loopback Port: ' + (data.gateway?.localPort || 18765) + '</div>' +
              '</div>';
          }
          const portEl = document.getElementById('stat-loopback-port');
          if (portEl) portEl.textContent = String(data.gateway?.localPort || 18765);
        } catch (err) {
          const led = document.getElementById('status-led');
          if (led) led.className = 'led offline';
          const tel = document.getElementById('servers-telemetry');
          if (tel) tel.textContent = 'Unable to reach backend: ' + err.message;
          logEvent('ERROR', 'Failed to reach status endpoint: ' + err.message);
        }
      }

      async function loadPolicies() {
        try {
          const res = await fetch('/api/policies');
          if (!res.ok) throw new Error('Policies request failed');
          const data = await res.json();
          cachedPolicies = (data.policies || []).map((policy) => ({
            ...policy,
            requiredTools: Array.isArray(policy.requiredTools) ? [...policy.requiredTools] : [],
            readOnlyTools: Array.isArray(policy.readOnlyTools) ? [...policy.readOnlyTools] : [],
          }));
          const countEl = document.getElementById('stat-policies-count');
          if (countEl) countEl.textContent = cachedPolicies.length === 0 ? '0' : 'P1-P' + cachedPolicies.length;
          renderPolicyTables();
        } catch (err) {
          const tbody = document.getElementById('policy-table-body');
          const detailedBody = document.getElementById('policies-detailed-table-body');
          if (tbody) tbody.replaceChildren(emptyRow(5, 'Failed to load policies: ' + err.message));
          if (detailedBody) detailedBody.replaceChildren(emptyRow(9, 'Failed to load policies: ' + err.message));
        }
      }

      function addCell(row, value, className) {
        const cell = document.createElement('td');
        cell.textContent = value == null ? '' : String(value);
        if (className) cell.className = className;
        row.appendChild(cell);
        return cell;
      }

      function emptyRow(colspan, message) {
        const row = document.createElement('tr');
        const cell = document.createElement('td');
        cell.colSpan = colspan;
        cell.textContent = message;
        cell.style.color = 'var(--text-muted)';
        cell.style.textAlign = 'center';
        row.appendChild(cell);
        return row;
      }

      function renderPolicyTables() {
        const summaryBody = document.getElementById('policy-table-body');
        const detailedBody = document.getElementById('policies-detailed-table-body');

        if (summaryBody) {
          summaryBody.replaceChildren();
          if (cachedPolicies.length === 0) {
            summaryBody.appendChild(emptyRow(5, 'No policies configured'));
          } else {
            cachedPolicies.forEach((policy, index) => {
              const row = document.createElement('tr');
              addCell(row, 'P' + (index + 1), 'mono');
              addCell(row, policy.resourceId);
              addCell(row, policy.resourceType);
              addCell(row, policy.enforcement);
              addCell(row, policy.directive);
              summaryBody.appendChild(row);
            });
          }
        }

        if (!detailedBody) return;
        detailedBody.replaceChildren();
        if (cachedPolicies.length === 0) {
          detailedBody.appendChild(emptyRow(9, 'No policies configured. Add one to define P1.'));
          return;
        }

        cachedPolicies.forEach((policy, index) => {
          const row = document.createElement('tr');
          const priorityCell = document.createElement('td');
          const priorityInput = document.createElement('input');
          priorityInput.type = 'number';
          priorityInput.min = '1';
          priorityInput.max = String(cachedPolicies.length);
          priorityInput.value = String(index + 1);
          priorityInput.className = 'form-control mono policy-priority-input';
          priorityInput.style.width = '72px';
          priorityInput.setAttribute('aria-label', 'Priority position for ' + policy.id);
          priorityInput.addEventListener('change', () => {
            const target = Math.max(1, Math.min(cachedPolicies.length, Number.parseInt(priorityInput.value, 10) || index + 1)) - 1;
            movePolicy(index, target);
          });
          priorityCell.appendChild(priorityInput);
          row.appendChild(priorityCell);

          const addTextEditor = (value, field, width) => {
            const cell = document.createElement('td');
            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'form-control mono';
            input.value = value || '';
            if (width) input.style.minWidth = width;
            input.addEventListener('input', () => { cachedPolicies[index] = { ...cachedPolicies[index], [field]: input.value }; });
            cell.appendChild(input);
            row.appendChild(cell);
            return input;
          };

          addTextEditor(policy.id, 'id', '180px');
          addTextEditor(policy.resourceId, 'resourceId', '160px');

          const typeCell = document.createElement('td');
          const typeSelect = document.createElement('select');
          typeSelect.className = 'form-control';
          for (const value of ['server', 'skill']) {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = value;
            option.selected = policy.resourceType === value;
            typeSelect.appendChild(option);
          }
          typeSelect.addEventListener('change', () => { cachedPolicies[index] = { ...cachedPolicies[index], resourceType: typeSelect.value }; });
          typeCell.appendChild(typeSelect);
          row.appendChild(typeCell);

          const mandatoryCell = document.createElement('td');
          const mandatory = document.createElement('input');
          mandatory.type = 'checkbox';
          mandatory.checked = policy.mandatory === true;
          mandatory.setAttribute('aria-label', 'Mandatory policy');
          mandatory.addEventListener('change', () => { cachedPolicies[index] = { ...cachedPolicies[index], mandatory: mandatory.checked }; });
          mandatoryCell.appendChild(mandatory);
          row.appendChild(mandatoryCell);

          addTextEditor(policy.enforcement, 'enforcement', '130px');

          const toolsCell = document.createElement('td');
          const tools = document.createElement('input');
          tools.type = 'text';
          tools.className = 'form-control mono';
          tools.style.minWidth = '180px';
          tools.value = (policy.requiredTools || []).join(', ');
          tools.placeholder = 'tool_a, tool_b';
          tools.addEventListener('input', () => {
            cachedPolicies[index] = {
              ...cachedPolicies[index],
              requiredTools: tools.value.split(',').map((value) => value.trim()).filter(Boolean),
            };
          });
          toolsCell.appendChild(tools);
          row.appendChild(toolsCell);

          addTextEditor(policy.directive, 'directive', '280px');

          const actionCell = document.createElement('td');
          const remove = document.createElement('button');
          remove.type = 'button';
          remove.className = 'btn btn-danger btn-sm';
          remove.textContent = 'Remove';
          remove.addEventListener('click', () => removePolicy(index));
          actionCell.appendChild(remove);
          row.appendChild(actionCell);
          detailedBody.appendChild(row);
        });
      }

      function movePolicy(fromIndex, toIndex) {
        if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= cachedPolicies.length || toIndex >= cachedPolicies.length) return;
        const [policy] = cachedPolicies.splice(fromIndex, 1);
        cachedPolicies.splice(toIndex, 0, policy);
        renderPolicyTables();
      }

      function addPolicy() {
        const suffix = globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : Date.now().toString(36);
        cachedPolicies.push({
          id: 'custom:' + suffix,
          resourceId: '',
          resourceType: 'server',
          mandatory: false,
          enforcement: 'ON_DEMAND',
          directive: 'Describe when this policy should run.',
          requiredTools: [],
        });
        renderPolicyTables();
      }

      function removePolicy(index) {
        cachedPolicies.splice(index, 1);
        renderPolicyTables();
      }

      function persistablePolicies() {
        return cachedPolicies.map((policy) => ({
          id: String(policy.id || '').trim(),
          resourceId: String(policy.resourceId || '').trim(),
          resourceType: policy.resourceType === 'skill' ? 'skill' : 'server',
          mandatory: policy.mandatory === true,
          enforcement: String(policy.enforcement || '').trim(),
          directive: String(policy.directive || '').trim(),
          requiredTools: [...new Set((policy.requiredTools || []).map((tool) => String(tool).trim()).filter(Boolean))],
          readOnlyTools: [...new Set((policy.readOnlyTools || []).map((tool) => String(tool).trim()).filter(Boolean))],
        }));
      }

      async function savePolicies(quiet = false) {
        try {
          const res = await mutationJson('/api/policies', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(persistablePolicies()),
          });
          const snapshot = await res.json();
          if (!res.ok || !snapshot || !Array.isArray(snapshot.policies)) {
            throw new Error(errorMessage(snapshot, 'Failed to save policies'));
          }
          cachedPolicies = [...snapshot.policies];
          renderPolicyTables();
          logEvent('SUCCESS', 'Saved ' + cachedPolicies.length + ' runtime policies in user-selected priority order');
          if (!quiet) showToast('Policies saved');
          return true;
        } catch (err) {
          if (!quiet) showToast('Save failed: ' + err.message, true);
          logEvent('ERROR', 'Policy save failed: ' + err.message);
          return false;
        }
      }

      async function loadWorkspaces() {
        const body = document.getElementById('projects-table-body');
        try {
          const res = await fetch('/api/workspaces');
          if (!res.ok) throw new Error('Workspace request failed');
          const data = await res.json();
          cachedWorkspaces = Array.isArray(data.workspaces) ? data.workspaces : [];
          workspaceSelection = data.selection || null;
          renderWorkspaces();
        } catch (err) {
          if (body) body.replaceChildren(emptyRow(5, 'Failed to load projects: ' + err.message));
          logEvent('ERROR', 'Project refresh failed: ' + err.message);
        }
      }

      function renderWorkspaces() {
        const body = document.getElementById('projects-table-body');
        if (!body) return;
        body.replaceChildren();
        if (cachedWorkspaces.length === 0) {
          body.appendChild(emptyRow(5, 'No registered project workspaces'));
          return;
        }
        const activeIds = new Set(workspaceSelection?.activeWorkspaceIds || []);
        const primaryId = workspaceSelection?.primaryWorkspaceId || '';
        for (const workspace of cachedWorkspaces) {
          const active = activeIds.has(workspace.id);
          const primary = primaryId === workspace.id;
          const row = document.createElement('tr');
          addCell(row, workspace.displayName || workspace.id);
          addCell(row, workspace.realRootPath || workspace.rootPath || '', 'mono');
          addCell(row, active ? 'Active' : 'Inactive');
          addCell(row, primary ? 'Primary' : '—');
          const action = document.createElement('td');
          const activeButton = document.createElement('button');
          activeButton.type = 'button';
          activeButton.className = active ? 'btn btn-secondary btn-sm' : 'btn btn-sm';
          activeButton.textContent = active ? 'Deactivate' : 'Activate';
          activeButton.disabled = primary;
          activeButton.title = primary ? 'Choose another Primary Project before deactivating this project' : '';
          activeButton.addEventListener('click', () => updateWorkspaceSelection(workspace.id, active ? 'deactivate' : 'activate'));
          action.appendChild(activeButton);
          if (!primary) {
            const primaryButton = document.createElement('button');
            primaryButton.type = 'button';
            primaryButton.className = 'btn btn-secondary btn-sm';
            primaryButton.style.marginLeft = '8px';
            primaryButton.textContent = 'Make Primary';
            primaryButton.addEventListener('click', () => updateWorkspaceSelection(workspace.id, 'primary'));
            action.appendChild(primaryButton);
          }
          row.appendChild(action);
          body.appendChild(row);
        }
      }

      async function updateWorkspaceSelection(workspaceId, operation) {
        try {
          const endpoint = '/api/workspaces/' + encodeURIComponent(workspaceId) + '/' + (operation === 'primary' ? 'primary' : 'active');
          const method = operation === 'deactivate' ? 'DELETE' : 'PUT';
          const res = await mutationJson(endpoint, { method });
          const data = await res.json();
          if (!res.ok || !data.selection) throw new Error(errorMessage(data, 'Workspace selection failed'));
          workspaceSelection = data.selection;
          renderWorkspaces();
          showToast(operation === 'primary' ? 'Primary Project updated' : 'Active Projects updated');
          logEvent('SUCCESS', 'Workspace selection updated for ' + workspaceId + ' (' + operation + ')');
        } catch (err) {
          showToast('Project update failed: ' + err.message, true);
          logEvent('ERROR', 'Workspace selection update failed: ' + err.message);
        }
      }

      async function loadInventory() {
        const serverBody = document.getElementById('server-table-body');
        const skillBody = document.getElementById('skill-table-body');
        const detailedServerBody = document.getElementById('server-table-detailed-body');
        const detailedSkillBody = document.getElementById('skill-table-detailed-body');

        try {
          const [serversRes, skillsRes] = await Promise.all([fetch('/api/servers'), fetch('/api/skills')]);
          if (!serversRes.ok || !skillsRes.ok) throw new Error('Inventory request failed');
          cachedServers = (await serversRes.json()).servers || [];
          cachedSkills = (await skillsRes.json()).skills || [];

          // Update stats
          const serversCountEl = document.getElementById('stat-servers-count');
          if (serversCountEl) serversCountEl.textContent = String(cachedServers.length);
          const skillsCountEl = document.getElementById('stat-skills-count');
          if (skillsCountEl) skillsCountEl.textContent = String(cachedSkills.length);

          renderServerTables();
          renderSkillTables();
        } catch (err) {
          if (serverBody) serverBody.replaceChildren(emptyRow(5, 'Failed to load server inventory'));
          if (skillBody) skillBody.replaceChildren(emptyRow(4, 'Failed to load skill inventory'));
          logEvent('ERROR', 'Inventory refresh error: ' + err.message);
        }
      }

      function renderServerTables(filterQuery = '') {
        const serverBody = document.getElementById('server-table-body');
        const detailedServerBody = document.getElementById('server-table-detailed-body');

        const filtered = cachedServers.filter(s => {
          if (!filterQuery) return true;
          const q = filterQuery.toLowerCase();
          return (s.name && s.name.toLowerCase().includes(q)) ||
                 (s.command && s.command.toLowerCase().includes(q)) ||
                 (s.source && s.source.toLowerCase().includes(q));
        });

        if (serverBody) {
          serverBody.replaceChildren();
          if (cachedServers.length === 0) {
            serverBody.appendChild(emptyRow(5, 'No MCP servers discovered'));
          } else {
            for (const server of cachedServers) {
              const row = document.createElement('tr');
              addCell(row, server.name);
              addCell(row, server.source, 'mono');
              addCell(row, server.command, 'mono');
              addCell(row, server.excluded ? 'excluded' : server.enabled ? 'enabled' : 'disabled');
              const action = document.createElement('td');
              const button = document.createElement('button');
              button.className = 'btn btn-danger btn-sm prune-server-btn';
              button.type = 'button';
              button.textContent = 'Prune';
              button.dataset.serverId = server.serverId;
              button.addEventListener('click', () => pruneServer(server));
              action.appendChild(button);
              row.appendChild(action);
              serverBody.appendChild(row);
            }
          }
        }

        if (detailedServerBody) {
          detailedServerBody.replaceChildren();
          if (filtered.length === 0) {
            detailedServerBody.appendChild(emptyRow(5, 'No servers matching filter'));
          } else {
            for (const server of filtered) {
              const row = document.createElement('tr');
              const idCell = addCell(row, server.name);
              const subId = document.createElement('div');
              subId.className = 'mono';
              subId.style.fontSize = '11px';
              subId.style.color = 'var(--text-muted)';
              subId.textContent = server.serverId;
              idCell.appendChild(subId);

              addCell(row, server.source, 'mono');
              addCell(row, server.command, 'mono');
              const stateCell = document.createElement('td');
              const stateBadge = document.createElement('span');
              stateBadge.className = 'badge ' + (server.excluded ? 'badge-offline' : server.enabled ? 'badge-healthy' : 'badge-syncing');
              stateBadge.textContent = server.excluded ? 'excluded' : server.enabled ? 'active' : 'disabled';
              stateCell.appendChild(stateBadge);
              row.appendChild(stateCell);

              const action = document.createElement('td');
              const button = document.createElement('button');
              button.className = 'btn btn-danger btn-sm prune-server-btn';
              button.type = 'button';
              button.textContent = 'Prune Server';
              button.dataset.serverId = server.serverId;
              button.addEventListener('click', () => pruneServer(server));
              action.appendChild(button);
              row.appendChild(action);
              detailedServerBody.appendChild(row);
            }
          }
        }
      }

      function renderSkillTables(filterQuery = '') {
        const skillBody = document.getElementById('skill-table-body');
        const detailedSkillBody = document.getElementById('skill-table-detailed-body');

        const filtered = cachedSkills.filter(s => {
          if (!filterQuery) return true;
          const q = filterQuery.toLowerCase();
          return (s.name && s.name.toLowerCase().includes(q)) ||
                 (s.description && s.description.toLowerCase().includes(q)) ||
                 (s.source && s.source.toLowerCase().includes(q));
        });

        if (skillBody) {
          skillBody.replaceChildren();
          if (cachedSkills.length === 0) {
            skillBody.appendChild(emptyRow(4, 'No skills discovered'));
          } else {
            for (const skill of cachedSkills) {
              const row = document.createElement('tr');
              addCell(row, skill.name);
              addCell(row, skill.source, 'mono');
              addCell(row, skill.description);
              const action = document.createElement('td');
              const button = document.createElement('button');
              button.className = 'btn btn-danger btn-sm prune-skill-btn';
              button.type = 'button';
              button.textContent = 'Prune';
              button.dataset.serverId = skill.name;
              button.addEventListener('click', () => pruneSkill(skill));
              action.appendChild(button);
              row.appendChild(action);
              skillBody.appendChild(row);
            }
          }
        }

        if (detailedSkillBody) {
          detailedSkillBody.replaceChildren();
          if (filtered.length === 0) {
            detailedSkillBody.appendChild(emptyRow(5, 'No skills matching filter'));
          } else {
            for (const skill of filtered) {
              const row = document.createElement('tr');
              addCell(row, skill.name);
              addCell(row, skill.source, 'mono');
              addCell(row, skill.description || 'No description provided');
              const scopeCell = document.createElement('td');
              const scopeBadge = document.createElement('span');
              scopeBadge.className = 'badge badge-optional';
              scopeBadge.textContent = skill.scope || 'global';
              scopeCell.appendChild(scopeBadge);
              row.appendChild(scopeCell);

              const action = document.createElement('td');
              const button = document.createElement('button');
              button.className = 'btn btn-danger btn-sm prune-skill-btn';
              button.type = 'button';
              button.textContent = 'Prune Skill';
              button.dataset.serverId = skill.name;
              button.addEventListener('click', () => pruneSkill(skill));
              action.appendChild(button);
              row.appendChild(action);
              detailedSkillBody.appendChild(row);
            }
          }
        }
      }

      async function pruneServer(server) {
        if (!window.confirm('Prune server ' + server.name + '?')) return;
        try {
          logEvent('INFO', 'Initiating server prune for ' + server.name + ' (' + server.serverId + ')');
          const res = await mutationJson('/api/servers/prune', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ serverId: server.serverId, targets: ['all'] }),
          });
          const result = await res.json();
          if (!res.ok || !result.ok) throw new Error(errorMessage(result, 'Server prune failed'));
          showToast('Pruned server ' + server.name);
          logEvent('SUCCESS', 'Server ' + server.name + ' pruned successfully');
          loadInventory();
        } catch (err) {
          showToast(err.message, true);
          logEvent('ERROR', 'Failed to prune server ' + server.name + ': ' + err.message);
        }
      }

      async function pruneSkill(skill) {
        if (!window.confirm('Prune skill ' + skill.name + '?')) return;
        try {
          logEvent('INFO', 'Initiating skill prune for ' + skill.name);
          const res = await mutationJson('/api/skills/prune', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: skill.name, targets: ['all'] }),
          });
          const result = await res.json();
          if (!res.ok || !result.ok) throw new Error(errorMessage(result, 'Skill prune failed'));
          showToast('Pruned skill ' + skill.name);
          logEvent('SUCCESS', 'Skill ' + skill.name + ' pruned successfully');
          loadInventory();
        } catch (err) {
          showToast(err.message, true);
          logEvent('ERROR', 'Failed to prune skill ' + skill.name + ': ' + err.message);
        }
      }

      async function loadGatewayStatus() {
        try {
          const res = await fetch('/api/chatgpt-gateway/status');
          if (!res.ok) throw new Error('Gateway status failed');
          const data = await res.json();
          const state = data.state || 'STOPPED';
          const bridgeEl = document.getElementById('bridge-state');
          const connectBtn = document.getElementById('connect-btn');
          const tunnelEl = document.getElementById('tunnel-url');

          const statBridge = document.getElementById('stat-bridge-state');
          if (statBridge) {
            statBridge.textContent = state;
            statBridge.style.color = state === 'BRIDGE_HEALTHY' || state === 'SESSION_CONNECTED'
              ? 'var(--status-healthy)'
              : state === 'INITIALIZING' ? 'var(--status-syncing)' : 'var(--status-offline)';
          }

          if (bridgeEl) bridgeEl.textContent = state;
          if (tunnelEl) tunnelEl.textContent = data.tunnelUrl || 'None';

          // Visual Gateway view elements
          const viewTunnelUrl = document.getElementById('chatgpt-view-tunnel-url');
          if (viewTunnelUrl) viewTunnelUrl.textContent = data.mcpUrl || 'None';
          const viewTunnelBadge = document.getElementById('chatgpt-view-tunnel-badge');
          if (viewTunnelBadge) {
            viewTunnelBadge.textContent = data.tunnelUrl ? 'Active Tunnel' : 'No Tunnel';
            viewTunnelBadge.className = 'badge mono ' + (data.tunnelUrl ? 'badge-healthy' : 'badge-state');
          }

          // Stepper highlighting
          const steps = ['stopped', 'initializing', 'healthy', 'connected'];
          for (const s of steps) {
            const el = document.getElementById('step-' + s);
            if (el) {
              el.style.borderColor = 'var(--border-subtle)';
              el.style.background = 'var(--surface-2)';
            }
          }
          let activeStep = 'stopped';
          if (state === 'INITIALIZING') activeStep = 'initializing';
          else if (state === 'BRIDGE_HEALTHY') activeStep = 'healthy';
          else if (state === 'SESSION_CONNECTED') activeStep = 'connected';
          const activeStepEl = document.getElementById('step-' + activeStep);
          if (activeStepEl) {
            activeStepEl.style.borderColor = 'var(--status-healthy)';
            activeStepEl.style.background = 'rgba(16, 185, 129, 0.08)';
          }

          // Canvas node dot
          const canvasDot = document.getElementById('canvas-gateway-dot');
          if (canvasDot) {
            canvasDot.setAttribute('fill', state === 'BRIDGE_HEALTHY' || state === 'SESSION_CONNECTED' ? '#10B981' : state === 'INITIALIZING' ? '#F59E0B' : '#EF4444');
          }

          const viewConnectBtn = document.getElementById('chatgpt-view-connect-btn');
          const isHealthy = (state === 'BRIDGE_HEALTHY');

          if (connectBtn) {
            connectBtn.disabled = !isHealthy;
            connectBtn.title = isHealthy ? 'Ready to connect' : 'Bridge must be in BRIDGE_HEALTHY state before connecting';
          }
          if (viewConnectBtn) {
            viewConnectBtn.disabled = !isHealthy;
            viewConnectBtn.title = isHealthy ? 'Ready to connect' : 'Bridge must be in BRIDGE_HEALTHY state before connecting';
          }
          if (bridgeEl) {
            bridgeEl.style.color = isHealthy ? 'var(--status-healthy)' : state === 'INITIALIZING' ? 'var(--status-syncing)' : 'var(--text-secondary)';
          }
        } catch (err) {
          console.error(err);
        }
      }

      async function loadSettings() {
        try {
          const res = await fetch('/api/settings');
          if (!res.ok) throw new Error('Settings request failed');
          const data = await res.json();
          const settings = data.settings || {};
          for (const [id, value] of [
            ['settings-account-id', settings.accountId || ''],
            ['settings-zone-name', settings.zoneName || ''],
            ['settings-tunnel-name', settings.tunnelName || ''],
            ['settings-public-url', settings.publicUrl || ''],
            ['settings-origin-url', settings.originUrl || ''],
            ['settings-allowed-hostnames', (settings.allowedHostnames || []).join(', ')],
            ['settings-allowed-origins', (settings.allowedOrigins || []).join(', ')],
          ]) {
            const field = document.getElementById(id);
            if (field) field.value = value;
          }
          const tokenField = document.getElementById('settings-api-token');
          if (tokenField) {
            tokenField.placeholder = settings.cloudflareApiTokenConfigured ? 'Saved in Linux Secret Service — leave blank to reuse' : 'Paste Cloudflare API token (stored in Linux Secret Service)';
          }
          const tokenStatus = document.getElementById('settings-token-status');
          if (tokenStatus) tokenStatus.textContent = settings.cloudflareApiTokenConfigured && settings.tunnelTokenConfigured ? 'Credentials saved — leave token blank to reuse' : 'Credentials not configured';
        } catch (err) { logEvent('WARN', 'Settings unavailable: ' + err.message); }
      }

      async function saveSettings(event) {
        event.preventDefault();
        const csv = (id) => document.getElementById(id)?.value.split(',').map((value) => value.trim()).filter(Boolean) || [];
        const body = {
          accountId: document.getElementById('settings-account-id')?.value || '',
          zoneName: document.getElementById('settings-zone-name')?.value || '',
          tunnelName: document.getElementById('settings-tunnel-name')?.value || '',
          publicUrl: document.getElementById('settings-public-url')?.value || '',
          originUrl: document.getElementById('settings-origin-url')?.value || '',
          allowedHostnames: csv('settings-allowed-hostnames'),
          allowedOrigins: csv('settings-allowed-origins'),
        };
        const token = document.getElementById('settings-api-token')?.value || '';
        if (token) body.apiToken = token;
        try {
          const res = await mutationJson('/api/cloudflare/reconcile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
          const result = await res.json();
          if (!res.ok || !result.ok) throw new Error(errorMessage(result, 'Cloudflare setup failed'));
          document.getElementById('settings-api-token').value = '';
          showToast('Cloudflare tunnel configured and gateway healthy');
          loadSettings();
          loadGatewayStatus();
        } catch (err) { showToast('Settings failed: ' + err.message, true); logEvent('ERROR', 'Settings update failed: ' + err.message); }
      }

      async function syncPolicies() {
        try {
          if (!(await savePolicies(true))) return;
          showToast('Syncing policies across IDE targets...');
          logEvent('INFO', 'Synchronizing policies across IDE targets (all)');
          const res = await mutationJson('/api/policies/sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targets: ['all'] }),
          });
          const result = await res.json();
          if (result.ok) {
            const count = result.value?.updatedFiles?.length || 0;
            showToast('Synchronized ' + count + ' policy files!');
            logEvent('SUCCESS', 'Successfully synchronized ' + count + ' IDE policy files');
          } else {
            showToast('Sync failed: ' + errorMessage(result, 'Error'), true);
            logEvent('ERROR', 'Policy sync failed: ' + errorMessage(result, 'Unknown error'));
          }
        } catch (err) {
          showToast('Sync failed: ' + err.message, true);
          logEvent('ERROR', 'Policy sync error: ' + err.message);
        }
      }

      async function connectChatGPT() {
        try {
          logEvent('INFO', 'Initiating connection to ChatGPT Web...');
          const res = await mutationJson('/api/chatgpt-web/connect', { method: 'POST' });
          if (res.status === 401) {
            showToast('Dashboard session expired; reloading...', true);
            logEvent('WARN', 'Capability expired; reloading dashboard');
            window.location.reload();
            return;
          }
          if (res.status === 412) {
            const errData = await res.json();
            const message = errorMessage(errData, 'Bridge is not ready');
            showToast('Hard Gate Blocked (412): ' + message, true);
            logEvent('WARN', 'Hard Gate Blocked (412): ' + message);
            return;
          }
          const data = await res.json();
          if (res.ok) {
            showToast('Connected to ChatGPT Web successfully!');
            logEvent('SUCCESS', 'Connected to ChatGPT Web successfully');
          } else {
            showToast('Connection failed: ' + errorMessage(data, 'Error'), true);
            logEvent('ERROR', 'Connection failed: ' + errorMessage(data, 'Unknown error'));
          }
          loadGatewayStatus();
        } catch (err) {
          showToast('Connect error: ' + err.message, true);
          logEvent('ERROR', 'Connect exception: ' + err.message);
        }
      }

      async function startGateway() {
        try {
          showToast('Starting ChatGPT Gateway...');
          logEvent('INFO', 'Dispatching gateway start request');
          const res = await mutationJson('/api/chatgpt-gateway/start', { method: 'POST' });
          if (res.status === 401) {
            showToast('Dashboard session expired; reloading...', true);
            logEvent('WARN', 'Capability expired; reloading dashboard');
            window.location.reload();
            return;
          }
          const result = await res.json();
          const message = errorMessage(result, 'Gateway start failed');
          showToast(result.ok ? 'Gateway started!' : 'Failed: ' + message, !result.ok);
          logEvent(result.ok ? 'SUCCESS' : 'ERROR', result.ok ? 'Gateway started' : 'Gateway start failed: ' + message);
          loadGatewayStatus();
        } catch (err) {
          showToast('Start failed: ' + err.message, true);
          logEvent('ERROR', 'Start gateway exception: ' + err.message);
        }
      }

      async function stopGateway() {
        try {
          showToast('Stopping ChatGPT Gateway...');
          logEvent('INFO', 'Dispatching gateway stop request');
          const res = await mutationJson('/api/chatgpt-gateway/stop', { method: 'POST' });
          const result = await res.json();
          showToast('Gateway stopped');
          logEvent('INFO', 'Gateway stopped');
          loadGatewayStatus();
        } catch (err) {
          showToast('Stop failed: ' + err.message, true);
          logEvent('ERROR', 'Stop gateway exception: ' + err.message);
        }
      }

      async function disconnectChatGPT() {
        try {
          const res = await mutationJson('/api/chatgpt-web/disconnect', { method: 'POST' });
          const result = await res.json();
          if (!res.ok) throw new Error(errorMessage(result, 'Disconnect failed'));
          showToast('ChatGPT Web session disconnected');
          loadGatewayStatus();
        } catch (err) {
          showToast('Disconnect failed: ' + err.message, true);
          logEvent('ERROR', 'Disconnect exception: ' + err.message);
        }
      }

      async function submitSkillInstall(name, source, scope, modalToClose) {
        const payload = {
          name: name.trim(),
          source: source.trim(),
          scope: scope || 'global',
          targets: ['all'],
        };
        try {
          showToast('Installing skill ' + payload.name + '...');
          logEvent('INFO', 'Installing agent skill: ' + payload.name + ' from ' + payload.source);
          const res = await mutationJson('/api/skills/install', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          const result = await res.json();
          if (result.ok) {
            showToast('Installed skill ' + payload.name + ' successfully!');
            logEvent('SUCCESS', 'Installed skill ' + payload.name);
            if (modalToClose) modalToClose.style.display = 'none';
            loadInventory();
          } else {
            showToast('Install failed: ' + (result.error?.message || 'Error'), true);
            logEvent('ERROR', 'Install skill failed: ' + (result.error?.message || 'Error'));
          }
        } catch (err) {
          showToast('Error: ' + err.message, true);
          logEvent('ERROR', 'Skill install error: ' + err.message);
        }
      }

      async function submitServerInstall(name, transport, command, argsRaw, url, source, modalToClose) {
        const payload = {
          name: name.trim(),
          transport,
          command: command ? command.trim() : undefined,
          args: argsRaw ? argsRaw.split(',').map(a => a.trim()).filter(Boolean) : undefined,
          url: url ? url.trim() : undefined,
          source: source ? source.trim() : undefined,
          targets: ['all'],
          scope: 'global',
        };
        try {
          showToast('Installing server ' + payload.name + '...');
          logEvent('INFO', 'Registering MCP server: ' + payload.name + ' (' + transport + ')');
          const res = await mutationJson('/api/servers/install', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          const result = await res.json();
          if (result.ok) {
            showToast('Installed server ' + payload.name + ' successfully!');
            logEvent('SUCCESS', 'Registered server ' + payload.name);
            if (modalToClose) modalToClose.style.display = 'none';
            loadStatus();
            loadInventory();
          } else {
            showToast('Install failed: ' + (result.error?.message || 'Error'), true);
            logEvent('ERROR', 'Install server failed: ' + (result.error?.message || 'Error'));
          }
        } catch (err) {
          showToast('Error: ' + err.message, true);
          logEvent('ERROR', 'Server install error: ' + err.message);
        }
      }

      // Log Terminal Rendering
      function renderLogs() {
        const body = document.getElementById('terminal-log-body');
        const countBadge = document.getElementById('logs-count-badge');
        const levelFilter = document.getElementById('logs-level-select')?.value || 'ALL';
        const textFilter = (document.getElementById('logs-filter-text')?.value || '').toLowerCase();
        const autoscroll = document.getElementById('logs-autoscroll')?.checked ?? true;

        if (!body) return;

        const filtered = currentLogs.filter(item => {
          if (levelFilter !== 'ALL' && item.level !== levelFilter) return false;
          if (textFilter && !item.msg.toLowerCase().includes(textFilter)) return false;
          return true;
        });

        if (countBadge) countBadge.textContent = currentLogs.length + ' events';

        body.innerHTML = filtered.map(item =>
          '<div class="log-line">' +
          '<span class="log-time">' + item.time + '</span>' +
          '<span class="log-level ' + item.level + '">[' + item.level + ']</span>' +
          '<span class="log-msg">' + item.msg + '</span>' +
          '</div>'
        ).join('');

        if (autoscroll) {
          body.scrollTop = body.scrollHeight;
        }
      }

      async function fetchServerLogs() {
        try {
          const res = await fetch('/api/logs');
          if (res.ok) {
            const data = await res.json();
            if (Array.isArray(data.logs) && data.logs.length > 0) {
              currentLogs = data.logs;
              renderLogs();
            }
          }
        } catch {}
      }

      // Wire DOM events
      document.getElementById('sync-policies-btn')?.addEventListener('click', syncPolicies);
      document.getElementById('policies-view-sync-btn')?.addEventListener('click', syncPolicies);
      document.getElementById('policy-add-btn')?.addEventListener('click', addPolicy);
      document.getElementById('policy-save-btn')?.addEventListener('click', () => { void savePolicies(); });

      document.getElementById('connect-btn')?.addEventListener('click', connectChatGPT);
      document.getElementById('chatgpt-view-connect-btn')?.addEventListener('click', connectChatGPT);
      document.getElementById('chatgpt-view-disconnect-btn')?.addEventListener('click', disconnectChatGPT);
      document.getElementById('gateway-settings-form')?.addEventListener('submit', saveSettings);
      document.getElementById('settings-refresh-btn')?.addEventListener('click', loadSettings);

      document.getElementById('start-gateway-btn')?.addEventListener('click', startGateway);
      document.getElementById('chatgpt-view-start-btn')?.addEventListener('click', startGateway);

      document.getElementById('stop-gateway-btn')?.addEventListener('click', stopGateway);
      document.getElementById('chatgpt-view-stop-btn')?.addEventListener('click', stopGateway);

      document.getElementById('refresh-status-btn')?.addEventListener('click', () => {
        loadStatus();
        loadInventory();
        loadGatewayStatus();
        loadPolicies();
        fetchServerLogs();
      });
      document.getElementById('refresh-servers-btn')?.addEventListener('click', loadInventory);
      document.getElementById('servers-view-refresh-btn')?.addEventListener('click', loadInventory);
      document.getElementById('refresh-skills-btn')?.addEventListener('click', loadInventory);
      document.getElementById('skills-view-refresh-btn')?.addEventListener('click', loadInventory);
      document.getElementById('chatgpt-view-refresh-btn')?.addEventListener('click', loadGatewayStatus);
      document.getElementById('projects-refresh-btn')?.addEventListener('click', loadWorkspaces);

      // Search Inputs
      document.getElementById('server-search-input')?.addEventListener('input', (e) => {
        renderServerTables(e.target.value);
      });
      document.getElementById('skill-search-input')?.addEventListener('input', (e) => {
        renderSkillTables(e.target.value);
      });

      // Modals
      const skillModal = document.getElementById('install-skill-modal');
      const serverModal = document.getElementById('install-server-modal');

      document.getElementById('open-skill-modal-btn')?.addEventListener('click', () => { if (skillModal) skillModal.style.display = 'flex'; });
      document.getElementById('skills-view-install-btn')?.addEventListener('click', () => { if (skillModal) skillModal.style.display = 'flex'; });
      document.getElementById('close-skill-modal-btn')?.addEventListener('click', () => { if (skillModal) skillModal.style.display = 'none'; });

      document.getElementById('open-server-modal-btn')?.addEventListener('click', () => { if (serverModal) serverModal.style.display = 'flex'; });
      document.getElementById('servers-view-install-btn')?.addEventListener('click', () => { if (serverModal) serverModal.style.display = 'flex'; });
      document.getElementById('close-server-modal-btn')?.addEventListener('click', () => { if (serverModal) serverModal.style.display = 'none'; });

      // Transport selector toggle
      function wireTransportToggle(selectId, urlGroupId, cmdGroupId, argsGroupId, sourceGroupId) {
        document.getElementById(selectId)?.addEventListener('change', (e) => {
          const isUrl = e.target.value === 'sse' || e.target.value === 'http';
          const urlGroup = document.getElementById(urlGroupId);
          const cmdGroup = document.getElementById(cmdGroupId);
          const argsGroup = document.getElementById(argsGroupId);
          const sourceGroup = document.getElementById(sourceGroupId);
          if (urlGroup) urlGroup.style.display = isUrl ? 'block' : 'none';
          if (cmdGroup) cmdGroup.style.display = isUrl ? 'none' : 'block';
          if (argsGroup) argsGroup.style.display = isUrl ? 'none' : 'block';
          if (sourceGroup) sourceGroup.style.display = isUrl ? 'none' : 'block';
        });
      }
      wireTransportToggle('server-transport', 'url-group', 'command-group', 'args-group', 'source-group');
      wireTransportToggle('wb-server-transport', 'wb-url-group', 'wb-command-group', 'wb-args-group', 'wb-source-group');

      // Forms
      document.getElementById('skill-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = document.getElementById('skill-name')?.value || '';
        const source = document.getElementById('skill-source')?.value || '';
        const scope = document.getElementById('skill-scope')?.value || 'global';
        await submitSkillInstall(name, source, scope, skillModal);
        e.target.reset();
      });

      document.getElementById('workbench-skill-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = document.getElementById('wb-skill-name')?.value || '';
        const source = document.getElementById('wb-skill-source')?.value || '';
        const scope = document.getElementById('wb-skill-scope')?.value || 'global';
        await submitSkillInstall(name, source, scope, null);
        e.target.reset();
      });

      document.getElementById('server-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = document.getElementById('server-name')?.value || '';
        const transport = document.getElementById('server-transport')?.value || 'stdio';
        const command = document.getElementById('server-command')?.value || '';
        const argsRaw = document.getElementById('server-args')?.value || '';
        const url = document.getElementById('server-url')?.value || '';
        const source = document.getElementById('server-source')?.value || '';
        await submitServerInstall(name, transport, command, argsRaw, url, source, serverModal);
        e.target.reset();
      });

      document.getElementById('workbench-server-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = document.getElementById('wb-server-name')?.value || '';
        const transport = document.getElementById('wb-server-transport')?.value || 'stdio';
        const command = document.getElementById('wb-server-command')?.value || '';
        const argsRaw = document.getElementById('wb-server-args')?.value || '';
        const url = document.getElementById('wb-server-url')?.value || '';
        const source = document.getElementById('wb-server-source')?.value || '';
        await submitServerInstall(name, transport, command, argsRaw, url, source, null);
        e.target.reset();
      });

      // Log controls
      document.getElementById('logs-clear-btn')?.addEventListener('click', () => {
        currentLogs = [];
        renderLogs();
      });
      document.getElementById('logs-copy-btn')?.addEventListener('click', () => {
        const text = currentLogs.map(l => '[' + l.time + '] [' + l.level + '] ' + l.msg).join('\\n');
        navigator.clipboard.writeText(text).then(() => showToast('Logs copied to clipboard!'));
      });
      document.getElementById('logs-level-select')?.addEventListener('change', renderLogs);
      document.getElementById('logs-filter-text')?.addEventListener('input', renderLogs);

      // Initial boot
      logEvent('INFO', 'Bootstrapping Obsidian Telemetry SPA runtime');
      loadStatus();
      loadWorkspaces();
      loadInventory();
      loadPolicies();
      loadGatewayStatus();
      loadSettings();
      fetchServerLogs();

      setInterval(loadGatewayStatus, 5000);
      setInterval(fetchServerLogs, 6000);
    })();
  `;
}

