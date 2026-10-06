# Unified MCP Tool Contract

Status: generated from the live `ToolRegistry` and checked during release verification.

This document is the canonical generated inventory of the MCP tool surface. The
runtime Zod schemas under `packages/mcp-server/src/tools/` remain the source of
truth; this file records the generated registry view used by documentation and
release checks.

Run `corepack pnpm@10.15.0 docs:tools` after an intentional registry change.
Use `corepack pnpm@10.15.0 docs:tools:check` to verify that the generated block
matches the current registry without modifying this file.

<!-- BEGIN GENERATED TOOL REGISTRY -->
## Generated live ToolRegistry index

This complete inventory is generated from `ToolRegistry.listAll()`: **260 total tool definitions**. The runtime advertises **253 tools by default** and **260 tools when Codex delegation plus Agent Swarm is enabled** through `tools/list`.
Run `pnpm docs:tools` after intentionally changing the registry; CI runs `pnpm docs:tools:check` and fails on drift.

| # | Tool | Permission | Advertised | Delivery | Runtime evidence | Read-only | Destructive |
| ---: | --- | --- | --- | --- | --- | :---: | :---: |
| 1 | `workspace_list` | READ | default | operational | service_dispatch | yes | no |
| 2 | `workspace_active_list` | READ | default | operational | service_dispatch | yes | no |
| 3 | `workspace_activate` | WRITE | default | operational | service_dispatch | no | no |
| 4 | `workspace_deactivate` | WRITE | default | operational | service_dispatch | no | no |
| 5 | `workspace_set_primary` | WRITE | default | operational | service_dispatch | no | no |
| 6 | `workspace_register` | WRITE | default | operational | service_dispatch | no | no |
| 7 | `workspace_info` | READ | default | operational | service_dispatch | yes | no |
| 8 | `workspace_bootstrap` | READ | default | operational | service_dispatch | yes | no |
| 9 | `prepare_code_change` | READ | default | operational | service_dispatch | yes | no |
| 10 | `workspace_tree` | READ | default | operational | service_dispatch | yes | no |
| 11 | `project_snapshot` | READ | default | operational | service_dispatch | yes | no |
| 12 | `working_memory_search` | READ | default | operational | service_dispatch | yes | no |
| 13 | `working_memory_record` | WRITE | default | operational | service_dispatch | no | no |
| 14 | `read_file` | READ | default | operational | service_dispatch | yes | no |
| 15 | `read_files` | READ | default | operational | service_dispatch | yes | no |
| 16 | `search_files` | READ | default | operational | service_dispatch | yes | no |
| 17 | `search_text` | READ | default | operational | service_dispatch | yes | no |
| 18 | `git_status` | READ | default | operational | service_dispatch | yes | no |
| 19 | `git_diff` | READ | default | operational | service_dispatch | yes | no |
| 20 | `git_log` | READ | default | operational | service_dispatch | yes | no |
| 21 | `git` | EXECUTE | default | operational | service_dispatch | no | yes |
| 22 | `write_file` | WRITE | default | operational | service_dispatch | no | no |
| 23 | `apply_patch` | WRITE | default | operational | service_dispatch | no | no |
| 24 | `edit_file` | WRITE | default | operational | service_dispatch | no | no |
| 25 | `move_file` | WRITE | default | operational | service_dispatch | no | no |
| 26 | `copy_file` | WRITE | default | operational | service_dispatch | no | no |
| 27 | `delete_file` | DANGEROUS | default | operational | service_dispatch | no | yes |
| 28 | `list_recovery_items` | READ | default | operational | service_dispatch | yes | no |
| 29 | `restore_deleted_file` | WRITE | default | operational | service_dispatch | no | no |
| 30 | `list_checkpoints` | READ | default | operational | service_dispatch | yes | no |
| 31 | `restore_checkpoint` | WRITE | default | operational | service_dispatch | no | yes |
| 32 | `process_start` | EXECUTE | default | operational | service_dispatch | no | no |
| 33 | `process_list` | READ | default | operational | service_dispatch | yes | no |
| 34 | `process_status` | READ | default | operational | service_dispatch | yes | no |
| 35 | `process_logs` | READ | default | operational | service_dispatch | yes | no |
| 36 | `process_stop` | EXECUTE | default | operational | service_dispatch | no | no |
| 37 | `project_dev` | EXECUTE | default | operational | service_dispatch | no | no |
| 38 | `project_test` | EXECUTE | default | operational | service_dispatch | no | no |
| 39 | `project_lint` | EXECUTE | default | operational | service_dispatch | no | no |
| 40 | `project_typecheck` | EXECUTE | default | operational | service_dispatch | no | no |
| 41 | `project_build` | EXECUTE | default | operational | service_dispatch | no | no |
| 42 | `codex_status` | READ | Codex opt-in | operational | service_dispatch | yes | no |
| 43 | `codex_run` | EXECUTE | Codex opt-in | operational | service_dispatch | no | no |
| 44 | `codex_task_list` | READ | Codex opt-in | operational | service_dispatch | yes | no |
| 45 | `codex_task_status` | READ | Codex opt-in | operational | service_dispatch | yes | no |
| 46 | `codex_task_logs` | READ | Codex opt-in | operational | service_dispatch | yes | no |
| 47 | `codex_stop` | EXECUTE | Codex opt-in | operational | service_dispatch | no | no |
| 48 | `agent_swarm_run` | EXECUTE | Codex opt-in | dependency_gated | service_dispatch | no | no |
| 49 | `shell` | EXECUTE | default | operational | service_dispatch | no | yes |
| 50 | `dom_cdp` | READ | default | operational | service_dispatch | no | yes |
| 51 | `computer_use` | EXECUTE | default | operational | service_dispatch | no | yes |
| 52 | `accessibility` | READ | default | operational | service_dispatch | no | yes |
| 53 | `input_event` | EXECUTE | default | operational | service_dispatch | no | yes |
| 54 | `vision` | READ | default | operational | service_dispatch | yes | no |
| 55 | `vision_annotated_capture` | READ | default | operational | service_dispatch | yes | no |
| 56 | `ui_target_action` | EXECUTE | default | operational | service_dispatch | no | yes |
| 57 | `window` | EXECUTE | default | operational | service_dispatch | no | yes |
| 58 | `health` | READ | default | operational | service_dispatch | yes | no |
| 59 | `system_info` | READ | default | operational | service_dispatch | yes | no |
| 60 | `notification` | EXECUTE | default | operational | service_dispatch | no | no |
| 61 | `file_dialog` | EXECUTE | default | operational | service_dispatch | yes | no |
| 62 | `clipboard` | EXECUTE | default | operational | service_dispatch | no | no |
| 63 | `web_fetch` | READ | default | operational | service_dispatch | no | yes |
| 64 | `audio` | EXECUTE | default | operational | service_dispatch | no | yes |
| 65 | `screen_record` | EXECUTE | default | operational | service_dispatch | no | yes |
| 66 | `office` | WRITE | default | operational | service_dispatch | no | no |
| 67 | `scheduler` | EXECUTE | default | operational | service_dispatch | no | yes |
| 68 | `wsl_exec` | EXECUTE | default | operational | service_dispatch | no | yes |
| 69 | `wsl_fs` | READ | default | operational | service_dispatch | yes | no |
| 70 | `skills_list` | READ | default | operational | service_dispatch | yes | no |
| 71 | `skills_read` | READ | default | operational | service_dispatch | yes | no |
| 72 | `skills_install` | WRITE | default | operational | service_dispatch | no | no |
| 73 | `ponytail_session` | WRITE | default | operational | service_dispatch | no | no |
| 74 | `task_bootstrap` | READ | default | operational | service_dispatch | yes | no |
| 75 | `policy_snapshot` | READ | default | operational | service_dispatch | yes | no |
| 76 | `mcp_list` | READ | default | operational | service_dispatch | yes | no |
| 77 | `mcp_describe` | READ | default | operational | service_dispatch | yes | no |
| 78 | `mcp_install` | WRITE | default | operational | service_dispatch | no | no |
| 79 | `mcp_call` | DANGEROUS | default | operational | service_dispatch | no | yes |
| 80 | `merge_policy_get` | READ | default | operational | service_dispatch | yes | no |
| 81 | `guarded_pr_merge` | DANGEROUS | default | operational | service_dispatch | no | yes |
| 82 | `rag_recall` | READ | default | operational | service_dispatch | yes | no |
| 83 | `rag_remember` | WRITE | default | operational | service_dispatch | no | no |
| 84 | `workspace_memory_record` | WRITE | default | operational | service_dispatch | no | no |
| 85 | `rag_forget` | DANGEROUS | default | operational | service_dispatch | no | yes |
| 86 | `rag_pre_edit_context` | READ | default | operational | service_dispatch | yes | no |
| 87 | `rag_code_search` | READ | default | operational | service_dispatch | yes | no |
| 88 | `rag_code_context` | READ | default | operational | service_dispatch | yes | no |
| 89 | `rag_code_blast_radius` | READ | default | operational | service_dispatch | yes | no |
| 90 | `rag_adopt_legacy_index` | WRITE | default | operational | service_dispatch | no | no |
| 91 | `rag_code_index` | WRITE | default | operational | service_dispatch | no | no |
| 92 | `rag_index_status` | READ | default | operational | service_dispatch | yes | no |
| 93 | `rag_cancel_index` | WRITE | default | operational | service_dispatch | no | no |
| 94 | `workspace_context` | READ | default | operational | service_dispatch | yes | no |
| 95 | `workspace_context_continue` | READ | default | operational | service_dispatch | yes | no |
| 96 | `workspace_full_scan` | READ | default | operational | service_dispatch | yes | no |
| 97 | `workspace_full_scan_continue` | READ | default | operational | deterministic_operation | yes | no |
| 98 | `workspace_snapshot` | READ | default | operational | service_dispatch | yes | no |
| 99 | `search_all` | READ | default | operational | service_dispatch | yes | no |
| 100 | `read_many_files` | READ | default | operational | service_dispatch | yes | no |
| 101 | `read_file_page` | READ | default | operational | service_dispatch | yes | no |
| 102 | `read_file_page_continue` | READ | default | operational | service_dispatch | yes | no |
| 103 | `workspace_index` | READ | default | operational | service_dispatch | yes | no |
| 104 | `workspace_index_status` | READ | default | operational | service_dispatch | yes | no |
| 105 | `workspace_index_watch` | READ | default | operational | service_dispatch | yes | no |
| 106 | `workspace_index_stop` | READ | default | operational | service_dispatch | yes | no |
| 107 | `session_handoff` | READ | default | operational | service_dispatch | yes | no |
| 108 | `verify_incremental` | EXECUTE | default | operational | service_dispatch | no | no |
| 109 | `run_goal` | WRITE | default | operational | service_dispatch | no | no |
| 110 | `retry_goal_workspace_admission` | WRITE | default | operational | service_dispatch | no | no |
| 111 | `get_goal` | READ | default | operational | service_dispatch | yes | no |
| 112 | `checkpoint_goal` | WRITE | default | operational | service_dispatch | no | no |
| 113 | `finish_goal` | WRITE | default | operational | service_dispatch | no | no |
| 114 | `cancel_goal` | WRITE | default | operational | service_dispatch | no | yes |
| 115 | `reconcile_goals` | WRITE | default | operational | service_dispatch | no | no |
| 116 | `list_goals` | READ | default | operational | service_dispatch | yes | no |
| 117 | `prepare_scheduled_continuation` | WRITE | default | operational | service_dispatch | no | no |
| 118 | `record_scheduled_continuation_receipt` | WRITE | default | operational | service_dispatch | no | no |
| 119 | `claim_scheduled_continuation` | WRITE | default | operational | service_dispatch | no | no |
| 120 | `get_scheduled_continuation` | READ | default | operational | service_dispatch | yes | no |
| 121 | `expedite_scheduled_continuation` | WRITE | default | operational | service_dispatch | no | no |
| 122 | `cancel_scheduled_continuation` | WRITE | default | operational | service_dispatch | no | yes |
| 123 | `symbol_search` | READ | default | operational | service_dispatch | yes | no |
| 124 | `find_definition` | READ | default | operational | service_dispatch | yes | no |
| 125 | `find_references` | READ | default | operational | service_dispatch | yes | no |
| 126 | `find_implementations` | READ | default | operational | service_dispatch | yes | no |
| 127 | `call_hierarchy` | READ | default | operational | service_dispatch | yes | no |
| 128 | `import_graph` | READ | default | operational | service_dispatch | yes | no |
| 129 | `dependency_graph` | READ | default | operational | service_dispatch | yes | no |
| 130 | `module_graph` | READ | default | operational | service_dispatch | yes | no |
| 131 | `type_search` | READ | default | operational | service_dispatch | yes | no |
| 132 | `trace_symbol` | READ | default | operational | service_dispatch | yes | no |
| 133 | `context_ranking` | READ | default | operational | deterministic_operation | yes | no |
| 134 | `debug_context` | READ | default | operational | service_dispatch | yes | no |
| 135 | `review_context` | READ | default | operational | service_dispatch | yes | no |
| 136 | `change_context` | READ | default | operational | service_dispatch | yes | no |
| 137 | `symbol_context` | READ | default | operational | service_dispatch | yes | no |
| 138 | `test_context` | READ | default | operational | service_dispatch | yes | no |
| 139 | `dependency_context` | READ | default | operational | service_dispatch | yes | no |
| 140 | `git_context` | READ | default | operational | service_dispatch | yes | no |
| 141 | `frontend_context` | READ | default | operational | service_dispatch | yes | no |
| 142 | `backend_context` | READ | default | operational | service_dispatch | yes | no |
| 143 | `route_intent` | READ | default | operational | deterministic_operation | yes | no |
| 144 | `recipe_list` | READ | default | operational | deterministic_operation | yes | no |
| 145 | `recipe_describe` | READ | default | operational | deterministic_operation | yes | no |
| 146 | `recipe_run` | EXECUTE | default | operational | deterministic_operation | no | no |
| 147 | `dry_run` | READ | default | operational | deterministic_operation | yes | no |
| 148 | `review_changes` | READ | default | operational | service_dispatch | yes | no |
| 149 | `changed_symbols` | READ | default | operational | service_dispatch | yes | no |
| 150 | `affected_modules` | READ | default | operational | service_dispatch | yes | no |
| 151 | `git_history_context` | READ | default | operational | service_dispatch | yes | no |
| 152 | `git_blame_context` | READ | default | operational | service_dispatch | yes | no |
| 153 | `discover_tests` | READ | default | operational | service_dispatch | yes | no |
| 154 | `run_affected_tests` | EXECUTE | default | operational | service_dispatch | no | no |
| 155 | `test_failures` | READ | default | operational | service_dispatch | yes | no |
| 156 | `coverage_context` | READ | default | operational | service_dispatch | yes | no |
| 157 | `test_history` | READ | default | operational | service_dispatch | yes | no |
| 158 | `cache_stats` | READ | default | operational | deterministic_operation | yes | no |
| 159 | `cache_clear` | WRITE | default | operational | deterministic_operation | no | no |
| 160 | `cache_invalidate` | WRITE | default | operational | deterministic_operation | no | no |
| 161 | `hook_list` | READ | default | operational | deterministic_operation | yes | no |
| 162 | `hook_register` | WRITE | default | operational | deterministic_operation | no | no |
| 163 | `hook_remove` | WRITE | default | operational | deterministic_operation | no | no |
| 164 | `skill_match` | READ | default | operational | service_dispatch | yes | no |
| 165 | `skill_load` | READ | default | operational | service_dispatch | yes | no |
| 166 | `plugin_install` | WRITE | default | operational | truthful_unavailable | no | no |
| 167 | `plugin_list` | READ | default | operational | deterministic_operation | yes | no |
| 168 | `plugin_enable` | WRITE | default | operational | truthful_unavailable | no | no |
| 169 | `plugin_disable` | WRITE | default | operational | truthful_unavailable | no | no |
| 170 | `plugin_remove` | DANGEROUS | default | operational | truthful_unavailable | no | yes |
| 171 | `session_context` | READ | default | operational | deterministic_operation | yes | no |
| 172 | `session_checkpoint` | WRITE | default | operational | deterministic_operation | no | no |
| 173 | `session_resume` | READ | default | operational | deterministic_operation | yes | no |
| 174 | `session_history` | READ | default | operational | deterministic_operation | yes | no |
| 175 | `response_mode` | READ | default | operational | deterministic_operation | yes | no |
| 176 | `inspect_web_app` | READ | default | operational | service_dispatch | yes | no |
| 177 | `debug_ui` | READ | default | operational | service_dispatch | yes | no |
| 178 | `capture_ui_state` | READ | default | operational | service_dispatch | yes | no |
| 179 | `form_context` | READ | default | operational | service_dispatch | yes | no |
| 180 | `network_context` | READ | default | dependency_gated | truthful_unavailable | yes | no |
| 181 | `console_context` | READ | default | dependency_gated | truthful_unavailable | yes | no |
| 182 | `browser_debug_context` | READ | default | operational | service_dispatch | yes | no |
| 183 | `windows_environment` | READ | default | dependency_gated | truthful_unavailable | yes | no |
| 184 | `service_context` | READ | default | operational | deterministic_operation | yes | no |
| 185 | `process_context` | READ | default | operational | deterministic_operation | yes | no |
| 186 | `port_context` | READ | default | operational | deterministic_operation | yes | no |
| 187 | `registry_context` | READ | default | dependency_gated | truthful_unavailable | yes | no |
| 188 | `event_log_context` | READ | default | operational | deterministic_operation | yes | no |
| 189 | `installed_runtime_context` | READ | default | operational | deterministic_operation | yes | no |
| 190 | `path_context` | READ | default | operational | deterministic_operation | yes | no |
| 191 | `startup_context` | READ | default | operational | deterministic_operation | yes | no |
| 192 | `mcp_discover` | READ | default | operational | service_dispatch | yes | no |
| 193 | `mcp_health` | READ | default | operational | service_dispatch | yes | no |
| 194 | `mcp_resources` | READ | default | dependency_gated | service_dispatch | yes | no |
| 195 | `task_create` | EXECUTE | default | operational | service_dispatch | no | no |
| 196 | `task_status` | READ | default | operational | service_dispatch | yes | no |
| 197 | `task_cancel` | EXECUTE | default | operational | service_dispatch | no | no |
| 198 | `task_result` | READ | default | operational | service_dispatch | yes | no |
| 199 | `task_list` | READ | default | operational | service_dispatch | yes | no |
| 200 | `delegate` | EXECUTE | default | dependency_gated | service_dispatch | no | no |
| 201 | `delegate_status` | READ | default | dependency_gated | service_dispatch | yes | no |
| 202 | `delegate_cancel` | EXECUTE | default | dependency_gated | service_dispatch | no | no |
| 203 | `delegate_result` | READ | default | dependency_gated | service_dispatch | yes | no |
| 204 | `parallel_delegate` | EXECUTE | default | dependency_gated | service_dispatch | no | no |
| 205 | `permission_check` | READ | default | operational | deterministic_operation | yes | no |
| 206 | `permission_profile` | READ | default | operational | deterministic_operation | yes | no |
| 207 | `live_logs_query` | READ | default | operational | truthful_unavailable | yes | no |
| 208 | `live_logs_status` | READ | default | operational | truthful_unavailable | yes | no |
| 209 | `telemetry_dashboard` | READ | default | operational | deterministic_operation | yes | no |
| 210 | `context_economy_stats` | READ | default | operational | deterministic_operation | yes | no |
| 211 | `execution_plan` | READ | default | operational | deterministic_operation | yes | no |
| 212 | `repo_map` | READ | default | operational | service_dispatch | yes | no |
| 213 | `context_expand` | READ | default | operational | service_dispatch | yes | no |
| 214 | `recovery_status` | READ | default | operational | deterministic_operation | yes | no |
| 215 | `tool_schema_list` | READ | default | operational | deterministic_operation | yes | no |
| 216 | `tool_schema_register` | WRITE | default | operational | deterministic_operation | no | no |
| 217 | `capabilities` | READ | default | operational | deterministic_operation | yes | no |
| 218 | `tool_search` | READ | default | operational | deterministic_operation | yes | no |
| 219 | `tool_dynamic_filter` | READ | default | operational | deterministic_operation | yes | no |
| 220 | `tool_describe` | READ | default | operational | deterministic_operation | yes | no |
| 221 | `tool_categories` | READ | default | operational | deterministic_operation | yes | no |
| 222 | `tool_function_find` | READ | default | operational | deterministic_operation | yes | no |
| 223 | `tool_aliases` | READ | default | operational | deterministic_operation | yes | no |
| 224 | `mcp_hub` | READ | default | dependency_gated | service_dispatch | yes | no |
| 225 | `dev_context` | READ | default | operational | service_dispatch | yes | no |
| 226 | `recipe_catalog` | READ | default | operational | deterministic_operation | yes | no |
| 227 | `capture_screenshot` | READ | default | operational | service_dispatch | yes | no |
| 228 | `compare_screenshot` | READ | default | operational | deterministic_operation | yes | no |
| 229 | `dom_snapshot` | READ | default | operational | service_dispatch | yes | no |
| 230 | `layout_metadata` | READ | default | operational | service_dispatch | yes | no |
| 231 | `visual_context` | READ | default | operational | service_dispatch | yes | no |
| 232 | `inspect_workbook` | READ | default | operational | service_dispatch | yes | no |
| 233 | `compare_workbook_layout` | READ | default | dependency_gated | service_dispatch | yes | no |
| 234 | `render_excel_preview` | READ | default | dependency_gated | service_dispatch | yes | no |
| 235 | `inspect_pdf` | READ | default | dependency_gated | truthful_unavailable | yes | no |
| 236 | `compare_pdf_pages` | READ | default | dependency_gated | truthful_unavailable | yes | no |
| 237 | `project_profile_get` | READ | default | operational | service_dispatch | yes | no |
| 238 | `project_profile_set` | WRITE | default | operational | deterministic_operation | no | no |
| 239 | `handoff_context` | READ | default | operational | service_dispatch | yes | no |
| 240 | `benchmark_run` | EXECUTE | default | dependency_gated | service_dispatch | no | no |
| 241 | `regression_report` | READ | default | operational | deterministic_operation | yes | no |
| 242 | `sandbox_exec` | EXECUTE | default | dependency_gated | truthful_unavailable | no | no |
| 243 | `event_watch` | EXECUTE | default | dependency_gated | deterministic_operation | no | no |
| 244 | `crash_trace` | READ | default | dependency_gated | deterministic_operation | yes | no |
| 245 | `lsp_diagnostics` | READ | default | dependency_gated | truthful_unavailable | yes | no |
| 246 | `lsp_rename` | WRITE | default | dependency_gated | truthful_unavailable | no | no |
| 247 | `debug_attach` | EXECUTE | default | dependency_gated | truthful_unavailable | no | no |
| 248 | `debug_step` | EXECUTE | default | dependency_gated | truthful_unavailable | no | no |
| 249 | `git_worktree_spawn` | EXECUTE | default | dependency_gated | deterministic_operation | no | no |
| 250 | `git_worktree_remove` | DANGEROUS | default | dependency_gated | service_dispatch | no | yes |
| 251 | `db_inspect` | READ | default | dependency_gated | truthful_unavailable | yes | no |
| 252 | `db_query` | READ | default | dependency_gated | truthful_unavailable | yes | no |
| 253 | `office_ppt` | WRITE | default | dependency_gated | service_dispatch | no | no |
| 254 | `office_outlook` | READ | default | dependency_gated | truthful_unavailable | yes | no |
| 255 | `pdf_extract_tables` | READ | default | dependency_gated | truthful_unavailable | yes | no |
| 256 | `docx_merge` | WRITE | default | dependency_gated | service_dispatch | no | no |
| 257 | `self_heal_plan` | READ | default | operational | service_dispatch | yes | no |
| 258 | `self_heal_apply` | DANGEROUS | default | dependency_gated | service_dispatch | no | yes |
| 259 | `skills_import` | WRITE | default | operational | service_dispatch | no | no |
| 260 | `tool_batch` | EXECUTE | default | operational | service_dispatch | no | yes |
<!-- END GENERATED TOOL REGISTRY -->

## Protocol and result rules

- Tool names, permissions, annotations, and advertised state come from the live registry.
- Input validation is performed by the registered Zod schema before dispatch.
- Release verification fails when the generated inventory drifts from the runtime registry.
