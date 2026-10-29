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

This complete inventory is generated from `ToolRegistry.listAll()`: **270 total tool definitions**. The runtime advertises **263 tools by default** and **270 tools when Codex delegation plus Agent Swarm is enabled** through `tools/list`.
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
| 22 | `git_publish_preflight` | READ | default | operational | service_dispatch | yes | no |
| 23 | `write_file` | WRITE | default | operational | service_dispatch | no | no |
| 24 | `apply_patch` | WRITE | default | operational | service_dispatch | no | no |
| 25 | `edit_file` | WRITE | default | operational | service_dispatch | no | no |
| 26 | `move_file` | WRITE | default | operational | service_dispatch | no | no |
| 27 | `copy_file` | WRITE | default | operational | service_dispatch | no | no |
| 28 | `delete_file` | DANGEROUS | default | operational | service_dispatch | no | yes |
| 29 | `list_recovery_items` | READ | default | operational | service_dispatch | yes | no |
| 30 | `restore_deleted_file` | WRITE | default | operational | service_dispatch | no | no |
| 31 | `list_checkpoints` | READ | default | operational | service_dispatch | yes | no |
| 32 | `restore_checkpoint` | WRITE | default | operational | service_dispatch | no | yes |
| 33 | `process_start` | EXECUTE | default | operational | service_dispatch | no | no |
| 34 | `process_list` | READ | default | operational | service_dispatch | yes | no |
| 35 | `process_status` | READ | default | operational | service_dispatch | yes | no |
| 36 | `process_logs` | READ | default | operational | service_dispatch | yes | no |
| 37 | `process_stop` | EXECUTE | default | operational | service_dispatch | no | no |
| 38 | `project_dev` | EXECUTE | default | operational | service_dispatch | no | no |
| 39 | `project_test` | EXECUTE | default | operational | service_dispatch | no | no |
| 40 | `project_lint` | EXECUTE | default | operational | service_dispatch | no | no |
| 41 | `project_typecheck` | EXECUTE | default | operational | service_dispatch | no | no |
| 42 | `project_build` | EXECUTE | default | operational | service_dispatch | no | no |
| 43 | `codex_status` | READ | Codex opt-in | operational | service_dispatch | yes | no |
| 44 | `codex_run` | EXECUTE | Codex opt-in | operational | service_dispatch | no | no |
| 45 | `codex_task_list` | READ | Codex opt-in | operational | service_dispatch | yes | no |
| 46 | `codex_task_status` | READ | Codex opt-in | operational | service_dispatch | yes | no |
| 47 | `codex_task_logs` | READ | Codex opt-in | operational | service_dispatch | yes | no |
| 48 | `codex_stop` | EXECUTE | Codex opt-in | operational | service_dispatch | no | no |
| 49 | `agent_swarm_run` | EXECUTE | Codex opt-in | dependency_gated | service_dispatch | no | no |
| 50 | `shell` | EXECUTE | default | operational | service_dispatch | no | yes |
| 51 | `dom_cdp` | READ | default | operational | service_dispatch | no | yes |
| 52 | `computer_use` | EXECUTE | default | operational | service_dispatch | no | yes |
| 53 | `accessibility` | READ | default | operational | service_dispatch | no | yes |
| 54 | `input_event` | EXECUTE | default | operational | service_dispatch | no | yes |
| 55 | `vision` | READ | default | operational | service_dispatch | yes | no |
| 56 | `vision_annotated_capture` | READ | default | operational | service_dispatch | yes | no |
| 57 | `ui_target_action` | EXECUTE | default | operational | service_dispatch | no | yes |
| 58 | `window` | EXECUTE | default | operational | service_dispatch | no | yes |
| 59 | `health` | READ | default | operational | service_dispatch | yes | no |
| 60 | `system_info` | READ | default | operational | service_dispatch | yes | no |
| 61 | `notification` | EXECUTE | default | operational | service_dispatch | no | no |
| 62 | `file_dialog` | EXECUTE | default | operational | service_dispatch | yes | no |
| 63 | `clipboard` | EXECUTE | default | operational | service_dispatch | no | no |
| 64 | `web_fetch` | READ | default | operational | service_dispatch | no | yes |
| 65 | `audio` | EXECUTE | default | operational | service_dispatch | no | yes |
| 66 | `screen_record` | EXECUTE | default | operational | service_dispatch | no | yes |
| 67 | `office` | WRITE | default | operational | service_dispatch | no | no |
| 68 | `scheduler` | EXECUTE | default | operational | service_dispatch | no | yes |
| 69 | `wsl_exec` | EXECUTE | default | operational | service_dispatch | no | yes |
| 70 | `wsl_fs` | READ | default | operational | service_dispatch | yes | no |
| 71 | `skills_list` | READ | default | operational | service_dispatch | yes | no |
| 72 | `skills_read` | READ | default | operational | service_dispatch | yes | no |
| 73 | `skills_install` | WRITE | default | operational | service_dispatch | no | no |
| 74 | `ponytail_session` | WRITE | default | operational | service_dispatch | no | no |
| 75 | `task_bootstrap` | READ | default | operational | service_dispatch | yes | no |
| 76 | `policy_snapshot` | READ | default | operational | service_dispatch | yes | no |
| 77 | `mcp_list` | READ | default | operational | service_dispatch | yes | no |
| 78 | `mcp_describe` | READ | default | operational | service_dispatch | yes | no |
| 79 | `mcp_install` | WRITE | default | operational | service_dispatch | no | no |
| 80 | `mcp_call` | DANGEROUS | default | operational | service_dispatch | no | yes |
| 81 | `merge_policy_get` | READ | default | operational | service_dispatch | yes | no |
| 82 | `merge_verification_run` | EXECUTE | default | operational | service_dispatch | no | no |
| 83 | `merge_verification_status` | READ | default | operational | service_dispatch | yes | no |
| 84 | `guarded_pr_merge` | DANGEROUS | default | operational | service_dispatch | no | yes |
| 85 | `merge_reconcile` | WRITE | default | operational | service_dispatch | no | no |
| 86 | `heavy_job_queue_status` | READ | default | operational | service_dispatch | yes | no |
| 87 | `rag_recall` | READ | default | operational | service_dispatch | yes | no |
| 88 | `rag_remember` | WRITE | default | operational | service_dispatch | no | no |
| 89 | `workspace_memory_record` | WRITE | default | operational | service_dispatch | no | no |
| 90 | `rag_forget` | DANGEROUS | default | operational | service_dispatch | no | yes |
| 91 | `rag_pre_edit_context` | READ | default | operational | service_dispatch | yes | no |
| 92 | `rag_code_search` | READ | default | operational | service_dispatch | yes | no |
| 93 | `rag_code_context` | READ | default | operational | service_dispatch | yes | no |
| 94 | `rag_code_blast_radius` | READ | default | operational | service_dispatch | yes | no |
| 95 | `rag_adopt_legacy_index` | WRITE | default | operational | service_dispatch | no | no |
| 96 | `rag_code_index` | WRITE | default | operational | service_dispatch | no | no |
| 97 | `rag_index_status` | READ | default | operational | service_dispatch | yes | no |
| 98 | `rag_cancel_index` | WRITE | default | operational | service_dispatch | no | no |
| 99 | `rag_resolve_constraint` | WRITE | default | operational | service_dispatch | no | no |
| 100 | `rag_get_event` | READ | default | operational | service_dispatch | yes | no |
| 101 | `rag_memory_reconcile` | WRITE | default | operational | service_dispatch | no | no |
| 102 | `rag_code_reconcile` | WRITE | default | operational | service_dispatch | no | no |
| 103 | `workspace_context` | READ | default | operational | service_dispatch | yes | no |
| 104 | `workspace_context_continue` | READ | default | operational | service_dispatch | yes | no |
| 105 | `workspace_full_scan` | READ | default | operational | service_dispatch | yes | no |
| 106 | `workspace_full_scan_continue` | READ | default | operational | deterministic_operation | yes | no |
| 107 | `workspace_snapshot` | READ | default | operational | service_dispatch | yes | no |
| 108 | `search_all` | READ | default | operational | service_dispatch | yes | no |
| 109 | `read_many_files` | READ | default | operational | service_dispatch | yes | no |
| 110 | `read_file_page` | READ | default | operational | service_dispatch | yes | no |
| 111 | `read_file_page_continue` | READ | default | operational | service_dispatch | yes | no |
| 112 | `workspace_index` | READ | default | operational | service_dispatch | no | no |
| 113 | `workspace_index_status` | READ | default | operational | service_dispatch | yes | no |
| 114 | `workspace_index_watch` | READ | default | operational | service_dispatch | no | no |
| 115 | `workspace_index_stop` | READ | default | operational | service_dispatch | no | no |
| 116 | `session_handoff` | READ | default | operational | service_dispatch | yes | no |
| 117 | `verify_incremental` | EXECUTE | default | operational | service_dispatch | no | no |
| 118 | `run_goal` | WRITE | default | operational | service_dispatch | no | no |
| 119 | `retry_goal_workspace_admission` | WRITE | default | operational | service_dispatch | no | no |
| 120 | `get_goal` | READ | default | operational | service_dispatch | yes | no |
| 121 | `checkpoint_goal` | WRITE | default | operational | service_dispatch | no | no |
| 122 | `finish_goal` | WRITE | default | operational | service_dispatch | no | no |
| 123 | `cancel_goal` | WRITE | default | operational | service_dispatch | no | yes |
| 124 | `reconcile_goals` | WRITE | default | operational | service_dispatch | no | no |
| 125 | `reconcile_goal_worktrees` | READ | default | operational | service_dispatch | yes | no |
| 126 | `list_goals` | READ | default | operational | service_dispatch | yes | no |
| 127 | `prepare_scheduled_continuation` | WRITE | default | operational | service_dispatch | no | no |
| 128 | `record_scheduled_continuation_receipt` | WRITE | default | operational | service_dispatch | no | no |
| 129 | `claim_scheduled_continuation` | WRITE | default | operational | service_dispatch | no | no |
| 130 | `get_scheduled_continuation` | READ | default | operational | service_dispatch | yes | no |
| 131 | `expedite_scheduled_continuation` | WRITE | default | operational | service_dispatch | no | no |
| 132 | `cancel_scheduled_continuation` | WRITE | default | operational | service_dispatch | no | yes |
| 133 | `symbol_search` | READ | default | operational | service_dispatch | yes | no |
| 134 | `find_definition` | READ | default | operational | service_dispatch | yes | no |
| 135 | `find_references` | READ | default | operational | service_dispatch | yes | no |
| 136 | `find_implementations` | READ | default | operational | service_dispatch | yes | no |
| 137 | `call_hierarchy` | READ | default | operational | service_dispatch | yes | no |
| 138 | `import_graph` | READ | default | operational | service_dispatch | yes | no |
| 139 | `dependency_graph` | READ | default | operational | service_dispatch | yes | no |
| 140 | `module_graph` | READ | default | operational | service_dispatch | yes | no |
| 141 | `type_search` | READ | default | operational | service_dispatch | yes | no |
| 142 | `trace_symbol` | READ | default | operational | service_dispatch | yes | no |
| 143 | `context_ranking` | READ | default | operational | deterministic_operation | yes | no |
| 144 | `debug_context` | READ | default | operational | service_dispatch | yes | no |
| 145 | `review_context` | READ | default | operational | service_dispatch | yes | no |
| 146 | `change_context` | READ | default | operational | service_dispatch | yes | no |
| 147 | `symbol_context` | READ | default | operational | service_dispatch | yes | no |
| 148 | `test_context` | READ | default | operational | service_dispatch | yes | no |
| 149 | `dependency_context` | READ | default | operational | service_dispatch | yes | no |
| 150 | `git_context` | READ | default | operational | service_dispatch | yes | no |
| 151 | `frontend_context` | READ | default | operational | service_dispatch | yes | no |
| 152 | `backend_context` | READ | default | operational | service_dispatch | yes | no |
| 153 | `route_intent` | READ | default | operational | deterministic_operation | yes | no |
| 154 | `recipe_list` | READ | default | operational | deterministic_operation | yes | no |
| 155 | `recipe_describe` | READ | default | operational | deterministic_operation | yes | no |
| 156 | `recipe_run` | EXECUTE | default | operational | deterministic_operation | no | no |
| 157 | `dry_run` | READ | default | operational | deterministic_operation | yes | no |
| 158 | `review_changes` | READ | default | operational | service_dispatch | yes | no |
| 159 | `changed_symbols` | READ | default | operational | service_dispatch | yes | no |
| 160 | `affected_modules` | READ | default | operational | service_dispatch | yes | no |
| 161 | `git_history_context` | READ | default | operational | service_dispatch | yes | no |
| 162 | `git_blame_context` | READ | default | operational | service_dispatch | yes | no |
| 163 | `discover_tests` | READ | default | operational | service_dispatch | yes | no |
| 164 | `run_affected_tests` | EXECUTE | default | operational | service_dispatch | no | no |
| 165 | `test_failures` | READ | default | operational | service_dispatch | yes | no |
| 166 | `coverage_context` | READ | default | operational | service_dispatch | yes | no |
| 167 | `test_history` | READ | default | operational | service_dispatch | yes | no |
| 168 | `cache_stats` | READ | default | operational | deterministic_operation | yes | no |
| 169 | `cache_clear` | WRITE | default | operational | deterministic_operation | no | no |
| 170 | `cache_invalidate` | WRITE | default | operational | deterministic_operation | no | no |
| 171 | `hook_list` | READ | default | operational | deterministic_operation | yes | no |
| 172 | `hook_register` | WRITE | default | operational | deterministic_operation | no | no |
| 173 | `hook_remove` | WRITE | default | operational | deterministic_operation | no | no |
| 174 | `skill_match` | READ | default | operational | service_dispatch | yes | no |
| 175 | `skill_load` | READ | default | operational | service_dispatch | yes | no |
| 176 | `plugin_install` | WRITE | default | operational | truthful_unavailable | no | no |
| 177 | `plugin_list` | READ | default | operational | deterministic_operation | yes | no |
| 178 | `plugin_enable` | WRITE | default | operational | truthful_unavailable | no | no |
| 179 | `plugin_disable` | WRITE | default | operational | truthful_unavailable | no | no |
| 180 | `plugin_remove` | DANGEROUS | default | operational | truthful_unavailable | no | yes |
| 181 | `session_context` | READ | default | operational | deterministic_operation | yes | no |
| 182 | `session_checkpoint` | WRITE | default | operational | deterministic_operation | no | no |
| 183 | `session_resume` | READ | default | operational | deterministic_operation | yes | no |
| 184 | `session_history` | READ | default | operational | deterministic_operation | yes | no |
| 185 | `response_mode` | READ | default | operational | deterministic_operation | yes | no |
| 186 | `inspect_web_app` | READ | default | operational | service_dispatch | yes | no |
| 187 | `debug_ui` | READ | default | operational | service_dispatch | yes | no |
| 188 | `capture_ui_state` | READ | default | operational | service_dispatch | yes | no |
| 189 | `form_context` | READ | default | operational | service_dispatch | yes | no |
| 190 | `network_context` | READ | default | dependency_gated | truthful_unavailable | yes | no |
| 191 | `console_context` | READ | default | dependency_gated | truthful_unavailable | yes | no |
| 192 | `browser_debug_context` | READ | default | operational | service_dispatch | yes | no |
| 193 | `windows_environment` | READ | default | dependency_gated | truthful_unavailable | yes | no |
| 194 | `service_context` | READ | default | operational | deterministic_operation | yes | no |
| 195 | `process_context` | READ | default | operational | deterministic_operation | yes | no |
| 196 | `port_context` | READ | default | operational | deterministic_operation | yes | no |
| 197 | `registry_context` | READ | default | dependency_gated | truthful_unavailable | yes | no |
| 198 | `event_log_context` | READ | default | operational | deterministic_operation | yes | no |
| 199 | `installed_runtime_context` | READ | default | operational | deterministic_operation | yes | no |
| 200 | `path_context` | READ | default | operational | deterministic_operation | yes | no |
| 201 | `startup_context` | READ | default | operational | deterministic_operation | yes | no |
| 202 | `mcp_discover` | READ | default | operational | service_dispatch | yes | no |
| 203 | `mcp_health` | READ | default | operational | service_dispatch | yes | no |
| 204 | `mcp_resources` | READ | default | dependency_gated | service_dispatch | yes | no |
| 205 | `task_create` | EXECUTE | default | operational | service_dispatch | no | no |
| 206 | `task_status` | READ | default | operational | service_dispatch | yes | no |
| 207 | `task_cancel` | EXECUTE | default | operational | service_dispatch | no | no |
| 208 | `task_result` | READ | default | operational | service_dispatch | yes | no |
| 209 | `task_list` | READ | default | operational | service_dispatch | yes | no |
| 210 | `delegate` | EXECUTE | default | dependency_gated | service_dispatch | no | no |
| 211 | `delegate_status` | READ | default | dependency_gated | service_dispatch | yes | no |
| 212 | `delegate_cancel` | EXECUTE | default | dependency_gated | service_dispatch | no | no |
| 213 | `delegate_result` | READ | default | dependency_gated | service_dispatch | yes | no |
| 214 | `parallel_delegate` | EXECUTE | default | dependency_gated | service_dispatch | no | no |
| 215 | `permission_check` | READ | default | operational | deterministic_operation | yes | no |
| 216 | `permission_profile` | READ | default | operational | deterministic_operation | yes | no |
| 217 | `live_logs_query` | READ | default | operational | truthful_unavailable | yes | no |
| 218 | `live_logs_status` | READ | default | operational | truthful_unavailable | yes | no |
| 219 | `telemetry_dashboard` | READ | default | operational | deterministic_operation | yes | no |
| 220 | `context_economy_stats` | READ | default | operational | deterministic_operation | yes | no |
| 221 | `execution_plan` | READ | default | operational | deterministic_operation | yes | no |
| 222 | `repo_map` | READ | default | operational | service_dispatch | yes | no |
| 223 | `context_expand` | READ | default | operational | service_dispatch | yes | no |
| 224 | `recovery_status` | READ | default | operational | deterministic_operation | yes | no |
| 225 | `tool_schema_list` | READ | default | operational | deterministic_operation | yes | no |
| 226 | `tool_schema_register` | WRITE | default | operational | deterministic_operation | no | no |
| 227 | `capabilities` | READ | default | operational | deterministic_operation | yes | no |
| 228 | `tool_search` | READ | default | operational | deterministic_operation | yes | no |
| 229 | `tool_dynamic_filter` | READ | default | operational | deterministic_operation | yes | no |
| 230 | `tool_describe` | READ | default | operational | deterministic_operation | yes | no |
| 231 | `tool_categories` | READ | default | operational | deterministic_operation | yes | no |
| 232 | `tool_function_find` | READ | default | operational | deterministic_operation | yes | no |
| 233 | `tool_aliases` | READ | default | operational | deterministic_operation | yes | no |
| 234 | `mcp_hub` | READ | default | dependency_gated | service_dispatch | yes | no |
| 235 | `dev_context` | READ | default | operational | service_dispatch | yes | no |
| 236 | `recipe_catalog` | READ | default | operational | deterministic_operation | yes | no |
| 237 | `capture_screenshot` | READ | default | operational | service_dispatch | yes | no |
| 238 | `compare_screenshot` | READ | default | operational | deterministic_operation | yes | no |
| 239 | `dom_snapshot` | READ | default | operational | service_dispatch | yes | no |
| 240 | `layout_metadata` | READ | default | operational | service_dispatch | yes | no |
| 241 | `visual_context` | READ | default | operational | service_dispatch | yes | no |
| 242 | `inspect_workbook` | READ | default | operational | service_dispatch | yes | no |
| 243 | `compare_workbook_layout` | READ | default | dependency_gated | service_dispatch | yes | no |
| 244 | `render_excel_preview` | READ | default | dependency_gated | service_dispatch | yes | no |
| 245 | `inspect_pdf` | READ | default | dependency_gated | truthful_unavailable | yes | no |
| 246 | `compare_pdf_pages` | READ | default | dependency_gated | truthful_unavailable | yes | no |
| 247 | `project_profile_get` | READ | default | operational | service_dispatch | yes | no |
| 248 | `project_profile_set` | WRITE | default | operational | deterministic_operation | no | no |
| 249 | `handoff_context` | READ | default | operational | service_dispatch | yes | no |
| 250 | `benchmark_run` | EXECUTE | default | dependency_gated | service_dispatch | no | no |
| 251 | `regression_report` | READ | default | operational | deterministic_operation | yes | no |
| 252 | `sandbox_exec` | EXECUTE | default | dependency_gated | truthful_unavailable | no | no |
| 253 | `event_watch` | EXECUTE | default | dependency_gated | deterministic_operation | no | no |
| 254 | `crash_trace` | READ | default | dependency_gated | deterministic_operation | yes | no |
| 255 | `lsp_diagnostics` | READ | default | dependency_gated | truthful_unavailable | yes | no |
| 256 | `lsp_rename` | WRITE | default | dependency_gated | truthful_unavailable | no | no |
| 257 | `debug_attach` | EXECUTE | default | dependency_gated | truthful_unavailable | no | no |
| 258 | `debug_step` | EXECUTE | default | dependency_gated | truthful_unavailable | no | no |
| 259 | `git_worktree_spawn` | EXECUTE | default | dependency_gated | deterministic_operation | no | no |
| 260 | `git_worktree_remove` | DANGEROUS | default | dependency_gated | service_dispatch | no | yes |
| 261 | `db_inspect` | READ | default | dependency_gated | truthful_unavailable | yes | no |
| 262 | `db_query` | READ | default | dependency_gated | truthful_unavailable | yes | no |
| 263 | `office_ppt` | WRITE | default | dependency_gated | service_dispatch | no | no |
| 264 | `office_outlook` | READ | default | dependency_gated | truthful_unavailable | yes | no |
| 265 | `pdf_extract_tables` | READ | default | dependency_gated | truthful_unavailable | yes | no |
| 266 | `docx_merge` | WRITE | default | dependency_gated | service_dispatch | no | no |
| 267 | `self_heal_plan` | READ | default | operational | service_dispatch | yes | no |
| 268 | `self_heal_apply` | DANGEROUS | default | dependency_gated | service_dispatch | no | yes |
| 269 | `skills_import` | WRITE | default | operational | service_dispatch | no | no |
| 270 | `tool_batch` | EXECUTE | default | operational | service_dispatch | no | yes |
<!-- END GENERATED TOOL REGISTRY -->

## Protocol and result rules

- Tool names, permissions, annotations, and advertised state come from the live registry.
- Input validation is performed by the registered Zod schema before dispatch.
- Release verification fails when the generated inventory drifts from the runtime registry.
