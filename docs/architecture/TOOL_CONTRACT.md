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

This complete inventory is generated from `ToolRegistry.listAll()`: **264 total tool definitions**. The runtime advertises **257 tools by default** and **264 tools when Codex delegation plus Agent Swarm is enabled** through `tools/list`.
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
| 81 | `merge_verification_run` | EXECUTE | default | operational | service_dispatch | no | no |
| 82 | `merge_verification_status` | READ | default | operational | service_dispatch | yes | no |
| 83 | `guarded_pr_merge` | DANGEROUS | default | operational | service_dispatch | no | yes |
| 84 | `merge_reconcile` | WRITE | default | operational | service_dispatch | no | no |
| 85 | `rag_recall` | READ | default | operational | service_dispatch | yes | no |
| 86 | `rag_remember` | WRITE | default | operational | service_dispatch | no | no |
| 87 | `workspace_memory_record` | WRITE | default | operational | service_dispatch | no | no |
| 88 | `rag_forget` | DANGEROUS | default | operational | service_dispatch | no | yes |
| 89 | `rag_pre_edit_context` | READ | default | operational | service_dispatch | yes | no |
| 90 | `rag_code_search` | READ | default | operational | service_dispatch | yes | no |
| 91 | `rag_code_context` | READ | default | operational | service_dispatch | yes | no |
| 92 | `rag_code_blast_radius` | READ | default | operational | service_dispatch | yes | no |
| 93 | `rag_adopt_legacy_index` | WRITE | default | operational | service_dispatch | no | no |
| 94 | `rag_code_index` | WRITE | default | operational | service_dispatch | no | no |
| 95 | `rag_index_status` | READ | default | operational | service_dispatch | yes | no |
| 96 | `rag_cancel_index` | WRITE | default | operational | service_dispatch | no | no |
| 97 | `workspace_context` | READ | default | operational | service_dispatch | yes | no |
| 98 | `workspace_context_continue` | READ | default | operational | service_dispatch | yes | no |
| 99 | `workspace_full_scan` | READ | default | operational | service_dispatch | yes | no |
| 100 | `workspace_full_scan_continue` | READ | default | operational | deterministic_operation | yes | no |
| 101 | `workspace_snapshot` | READ | default | operational | service_dispatch | yes | no |
| 102 | `search_all` | READ | default | operational | service_dispatch | yes | no |
| 103 | `read_many_files` | READ | default | operational | service_dispatch | yes | no |
| 104 | `read_file_page` | READ | default | operational | service_dispatch | yes | no |
| 105 | `read_file_page_continue` | READ | default | operational | service_dispatch | yes | no |
| 106 | `workspace_index` | READ | default | operational | service_dispatch | yes | no |
| 107 | `workspace_index_status` | READ | default | operational | service_dispatch | yes | no |
| 108 | `workspace_index_watch` | READ | default | operational | service_dispatch | yes | no |
| 109 | `workspace_index_stop` | READ | default | operational | service_dispatch | yes | no |
| 110 | `session_handoff` | READ | default | operational | service_dispatch | yes | no |
| 111 | `verify_incremental` | EXECUTE | default | operational | service_dispatch | no | no |
| 112 | `run_goal` | WRITE | default | operational | service_dispatch | no | no |
| 113 | `retry_goal_workspace_admission` | WRITE | default | operational | service_dispatch | no | no |
| 114 | `get_goal` | READ | default | operational | service_dispatch | yes | no |
| 115 | `checkpoint_goal` | WRITE | default | operational | service_dispatch | no | no |
| 116 | `finish_goal` | WRITE | default | operational | service_dispatch | no | no |
| 117 | `cancel_goal` | WRITE | default | operational | service_dispatch | no | yes |
| 118 | `reconcile_goals` | WRITE | default | operational | service_dispatch | no | no |
| 119 | `reconcile_goal_worktrees` | READ | default | operational | service_dispatch | yes | no |
| 120 | `list_goals` | READ | default | operational | service_dispatch | yes | no |
| 121 | `prepare_scheduled_continuation` | WRITE | default | operational | service_dispatch | no | no |
| 122 | `record_scheduled_continuation_receipt` | WRITE | default | operational | service_dispatch | no | no |
| 123 | `claim_scheduled_continuation` | WRITE | default | operational | service_dispatch | no | no |
| 124 | `get_scheduled_continuation` | READ | default | operational | service_dispatch | yes | no |
| 125 | `expedite_scheduled_continuation` | WRITE | default | operational | service_dispatch | no | no |
| 126 | `cancel_scheduled_continuation` | WRITE | default | operational | service_dispatch | no | yes |
| 127 | `symbol_search` | READ | default | operational | service_dispatch | yes | no |
| 128 | `find_definition` | READ | default | operational | service_dispatch | yes | no |
| 129 | `find_references` | READ | default | operational | service_dispatch | yes | no |
| 130 | `find_implementations` | READ | default | operational | service_dispatch | yes | no |
| 131 | `call_hierarchy` | READ | default | operational | service_dispatch | yes | no |
| 132 | `import_graph` | READ | default | operational | service_dispatch | yes | no |
| 133 | `dependency_graph` | READ | default | operational | service_dispatch | yes | no |
| 134 | `module_graph` | READ | default | operational | service_dispatch | yes | no |
| 135 | `type_search` | READ | default | operational | service_dispatch | yes | no |
| 136 | `trace_symbol` | READ | default | operational | service_dispatch | yes | no |
| 137 | `context_ranking` | READ | default | operational | deterministic_operation | yes | no |
| 138 | `debug_context` | READ | default | operational | service_dispatch | yes | no |
| 139 | `review_context` | READ | default | operational | service_dispatch | yes | no |
| 140 | `change_context` | READ | default | operational | service_dispatch | yes | no |
| 141 | `symbol_context` | READ | default | operational | service_dispatch | yes | no |
| 142 | `test_context` | READ | default | operational | service_dispatch | yes | no |
| 143 | `dependency_context` | READ | default | operational | service_dispatch | yes | no |
| 144 | `git_context` | READ | default | operational | service_dispatch | yes | no |
| 145 | `frontend_context` | READ | default | operational | service_dispatch | yes | no |
| 146 | `backend_context` | READ | default | operational | service_dispatch | yes | no |
| 147 | `route_intent` | READ | default | operational | deterministic_operation | yes | no |
| 148 | `recipe_list` | READ | default | operational | deterministic_operation | yes | no |
| 149 | `recipe_describe` | READ | default | operational | deterministic_operation | yes | no |
| 150 | `recipe_run` | EXECUTE | default | operational | deterministic_operation | no | no |
| 151 | `dry_run` | READ | default | operational | deterministic_operation | yes | no |
| 152 | `review_changes` | READ | default | operational | service_dispatch | yes | no |
| 153 | `changed_symbols` | READ | default | operational | service_dispatch | yes | no |
| 154 | `affected_modules` | READ | default | operational | service_dispatch | yes | no |
| 155 | `git_history_context` | READ | default | operational | service_dispatch | yes | no |
| 156 | `git_blame_context` | READ | default | operational | service_dispatch | yes | no |
| 157 | `discover_tests` | READ | default | operational | service_dispatch | yes | no |
| 158 | `run_affected_tests` | EXECUTE | default | operational | service_dispatch | no | no |
| 159 | `test_failures` | READ | default | operational | service_dispatch | yes | no |
| 160 | `coverage_context` | READ | default | operational | service_dispatch | yes | no |
| 161 | `test_history` | READ | default | operational | service_dispatch | yes | no |
| 162 | `cache_stats` | READ | default | operational | deterministic_operation | yes | no |
| 163 | `cache_clear` | WRITE | default | operational | deterministic_operation | no | no |
| 164 | `cache_invalidate` | WRITE | default | operational | deterministic_operation | no | no |
| 165 | `hook_list` | READ | default | operational | deterministic_operation | yes | no |
| 166 | `hook_register` | WRITE | default | operational | deterministic_operation | no | no |
| 167 | `hook_remove` | WRITE | default | operational | deterministic_operation | no | no |
| 168 | `skill_match` | READ | default | operational | service_dispatch | yes | no |
| 169 | `skill_load` | READ | default | operational | service_dispatch | yes | no |
| 170 | `plugin_install` | WRITE | default | operational | truthful_unavailable | no | no |
| 171 | `plugin_list` | READ | default | operational | deterministic_operation | yes | no |
| 172 | `plugin_enable` | WRITE | default | operational | truthful_unavailable | no | no |
| 173 | `plugin_disable` | WRITE | default | operational | truthful_unavailable | no | no |
| 174 | `plugin_remove` | DANGEROUS | default | operational | truthful_unavailable | no | yes |
| 175 | `session_context` | READ | default | operational | deterministic_operation | yes | no |
| 176 | `session_checkpoint` | WRITE | default | operational | deterministic_operation | no | no |
| 177 | `session_resume` | READ | default | operational | deterministic_operation | yes | no |
| 178 | `session_history` | READ | default | operational | deterministic_operation | yes | no |
| 179 | `response_mode` | READ | default | operational | deterministic_operation | yes | no |
| 180 | `inspect_web_app` | READ | default | operational | service_dispatch | yes | no |
| 181 | `debug_ui` | READ | default | operational | service_dispatch | yes | no |
| 182 | `capture_ui_state` | READ | default | operational | service_dispatch | yes | no |
| 183 | `form_context` | READ | default | operational | service_dispatch | yes | no |
| 184 | `network_context` | READ | default | dependency_gated | truthful_unavailable | yes | no |
| 185 | `console_context` | READ | default | dependency_gated | truthful_unavailable | yes | no |
| 186 | `browser_debug_context` | READ | default | operational | service_dispatch | yes | no |
| 187 | `windows_environment` | READ | default | dependency_gated | truthful_unavailable | yes | no |
| 188 | `service_context` | READ | default | operational | deterministic_operation | yes | no |
| 189 | `process_context` | READ | default | operational | deterministic_operation | yes | no |
| 190 | `port_context` | READ | default | operational | deterministic_operation | yes | no |
| 191 | `registry_context` | READ | default | dependency_gated | truthful_unavailable | yes | no |
| 192 | `event_log_context` | READ | default | operational | deterministic_operation | yes | no |
| 193 | `installed_runtime_context` | READ | default | operational | deterministic_operation | yes | no |
| 194 | `path_context` | READ | default | operational | deterministic_operation | yes | no |
| 195 | `startup_context` | READ | default | operational | deterministic_operation | yes | no |
| 196 | `mcp_discover` | READ | default | operational | service_dispatch | yes | no |
| 197 | `mcp_health` | READ | default | operational | service_dispatch | yes | no |
| 198 | `mcp_resources` | READ | default | dependency_gated | service_dispatch | yes | no |
| 199 | `task_create` | EXECUTE | default | operational | service_dispatch | no | no |
| 200 | `task_status` | READ | default | operational | service_dispatch | yes | no |
| 201 | `task_cancel` | EXECUTE | default | operational | service_dispatch | no | no |
| 202 | `task_result` | READ | default | operational | service_dispatch | yes | no |
| 203 | `task_list` | READ | default | operational | service_dispatch | yes | no |
| 204 | `delegate` | EXECUTE | default | dependency_gated | service_dispatch | no | no |
| 205 | `delegate_status` | READ | default | dependency_gated | service_dispatch | yes | no |
| 206 | `delegate_cancel` | EXECUTE | default | dependency_gated | service_dispatch | no | no |
| 207 | `delegate_result` | READ | default | dependency_gated | service_dispatch | yes | no |
| 208 | `parallel_delegate` | EXECUTE | default | dependency_gated | service_dispatch | no | no |
| 209 | `permission_check` | READ | default | operational | deterministic_operation | yes | no |
| 210 | `permission_profile` | READ | default | operational | deterministic_operation | yes | no |
| 211 | `live_logs_query` | READ | default | operational | truthful_unavailable | yes | no |
| 212 | `live_logs_status` | READ | default | operational | truthful_unavailable | yes | no |
| 213 | `telemetry_dashboard` | READ | default | operational | deterministic_operation | yes | no |
| 214 | `context_economy_stats` | READ | default | operational | deterministic_operation | yes | no |
| 215 | `execution_plan` | READ | default | operational | deterministic_operation | yes | no |
| 216 | `repo_map` | READ | default | operational | service_dispatch | yes | no |
| 217 | `context_expand` | READ | default | operational | service_dispatch | yes | no |
| 218 | `recovery_status` | READ | default | operational | deterministic_operation | yes | no |
| 219 | `tool_schema_list` | READ | default | operational | deterministic_operation | yes | no |
| 220 | `tool_schema_register` | WRITE | default | operational | deterministic_operation | no | no |
| 221 | `capabilities` | READ | default | operational | deterministic_operation | yes | no |
| 222 | `tool_search` | READ | default | operational | deterministic_operation | yes | no |
| 223 | `tool_dynamic_filter` | READ | default | operational | deterministic_operation | yes | no |
| 224 | `tool_describe` | READ | default | operational | deterministic_operation | yes | no |
| 225 | `tool_categories` | READ | default | operational | deterministic_operation | yes | no |
| 226 | `tool_function_find` | READ | default | operational | deterministic_operation | yes | no |
| 227 | `tool_aliases` | READ | default | operational | deterministic_operation | yes | no |
| 228 | `mcp_hub` | READ | default | dependency_gated | service_dispatch | yes | no |
| 229 | `dev_context` | READ | default | operational | service_dispatch | yes | no |
| 230 | `recipe_catalog` | READ | default | operational | deterministic_operation | yes | no |
| 231 | `capture_screenshot` | READ | default | operational | service_dispatch | yes | no |
| 232 | `compare_screenshot` | READ | default | operational | deterministic_operation | yes | no |
| 233 | `dom_snapshot` | READ | default | operational | service_dispatch | yes | no |
| 234 | `layout_metadata` | READ | default | operational | service_dispatch | yes | no |
| 235 | `visual_context` | READ | default | operational | service_dispatch | yes | no |
| 236 | `inspect_workbook` | READ | default | operational | service_dispatch | yes | no |
| 237 | `compare_workbook_layout` | READ | default | dependency_gated | service_dispatch | yes | no |
| 238 | `render_excel_preview` | READ | default | dependency_gated | service_dispatch | yes | no |
| 239 | `inspect_pdf` | READ | default | dependency_gated | truthful_unavailable | yes | no |
| 240 | `compare_pdf_pages` | READ | default | dependency_gated | truthful_unavailable | yes | no |
| 241 | `project_profile_get` | READ | default | operational | service_dispatch | yes | no |
| 242 | `project_profile_set` | WRITE | default | operational | deterministic_operation | no | no |
| 243 | `handoff_context` | READ | default | operational | service_dispatch | yes | no |
| 244 | `benchmark_run` | EXECUTE | default | dependency_gated | service_dispatch | no | no |
| 245 | `regression_report` | READ | default | operational | deterministic_operation | yes | no |
| 246 | `sandbox_exec` | EXECUTE | default | dependency_gated | truthful_unavailable | no | no |
| 247 | `event_watch` | EXECUTE | default | dependency_gated | deterministic_operation | no | no |
| 248 | `crash_trace` | READ | default | dependency_gated | deterministic_operation | yes | no |
| 249 | `lsp_diagnostics` | READ | default | dependency_gated | truthful_unavailable | yes | no |
| 250 | `lsp_rename` | WRITE | default | dependency_gated | truthful_unavailable | no | no |
| 251 | `debug_attach` | EXECUTE | default | dependency_gated | truthful_unavailable | no | no |
| 252 | `debug_step` | EXECUTE | default | dependency_gated | truthful_unavailable | no | no |
| 253 | `git_worktree_spawn` | EXECUTE | default | dependency_gated | deterministic_operation | no | no |
| 254 | `git_worktree_remove` | DANGEROUS | default | dependency_gated | service_dispatch | no | yes |
| 255 | `db_inspect` | READ | default | dependency_gated | truthful_unavailable | yes | no |
| 256 | `db_query` | READ | default | dependency_gated | truthful_unavailable | yes | no |
| 257 | `office_ppt` | WRITE | default | dependency_gated | service_dispatch | no | no |
| 258 | `office_outlook` | READ | default | dependency_gated | truthful_unavailable | yes | no |
| 259 | `pdf_extract_tables` | READ | default | dependency_gated | truthful_unavailable | yes | no |
| 260 | `docx_merge` | WRITE | default | dependency_gated | service_dispatch | no | no |
| 261 | `self_heal_plan` | READ | default | operational | service_dispatch | yes | no |
| 262 | `self_heal_apply` | DANGEROUS | default | dependency_gated | service_dispatch | no | yes |
| 263 | `skills_import` | WRITE | default | operational | service_dispatch | no | no |
| 264 | `tool_batch` | EXECUTE | default | operational | service_dispatch | no | yes |
<!-- END GENERATED TOOL REGISTRY -->

## Protocol and result rules

- Tool names, permissions, annotations, and advertised state come from the live registry.
- Input validation is performed by the registered Zod schema before dispatch.
- Release verification fails when the generated inventory drifts from the runtime registry.
