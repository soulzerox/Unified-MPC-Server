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

This complete inventory is generated from `ToolRegistry.listAll()`: **277 total tool definitions**. The runtime advertises **270 tools by default** and **277 tools when Codex delegation plus Agent Swarm is enabled** through `tools/list`.
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
| 23 | `publish_approve` | EXECUTE | default | operational | service_dispatch | no | no |
| 24 | `git_publish` | EXECUTE | default | operational | service_dispatch | no | yes |
| 25 | `write_file` | WRITE | default | operational | service_dispatch | no | no |
| 26 | `apply_patch` | WRITE | default | operational | service_dispatch | no | no |
| 27 | `edit_file` | WRITE | default | operational | service_dispatch | no | no |
| 28 | `move_file` | WRITE | default | operational | service_dispatch | no | no |
| 29 | `copy_file` | WRITE | default | operational | service_dispatch | no | no |
| 30 | `delete_file` | DANGEROUS | default | operational | service_dispatch | no | yes |
| 31 | `list_recovery_items` | READ | default | operational | service_dispatch | yes | no |
| 32 | `restore_deleted_file` | WRITE | default | operational | service_dispatch | no | no |
| 33 | `list_checkpoints` | READ | default | operational | service_dispatch | yes | no |
| 34 | `restore_checkpoint` | WRITE | default | operational | service_dispatch | no | yes |
| 35 | `process_start` | EXECUTE | default | operational | service_dispatch | no | no |
| 36 | `process_list` | READ | default | operational | service_dispatch | yes | no |
| 37 | `process_status` | READ | default | operational | service_dispatch | yes | no |
| 38 | `process_logs` | READ | default | operational | service_dispatch | yes | no |
| 39 | `process_stop` | EXECUTE | default | operational | service_dispatch | no | no |
| 40 | `project_dev` | EXECUTE | default | operational | service_dispatch | no | no |
| 41 | `project_test` | EXECUTE | default | operational | service_dispatch | no | no |
| 42 | `project_lint` | EXECUTE | default | operational | service_dispatch | no | no |
| 43 | `project_typecheck` | EXECUTE | default | operational | service_dispatch | no | no |
| 44 | `project_build` | EXECUTE | default | operational | service_dispatch | no | no |
| 45 | `codex_status` | READ | Codex opt-in | operational | service_dispatch | yes | no |
| 46 | `codex_run` | EXECUTE | Codex opt-in | operational | service_dispatch | no | no |
| 47 | `codex_task_list` | READ | Codex opt-in | operational | service_dispatch | yes | no |
| 48 | `codex_task_status` | READ | Codex opt-in | operational | service_dispatch | yes | no |
| 49 | `codex_task_logs` | READ | Codex opt-in | operational | service_dispatch | yes | no |
| 50 | `codex_stop` | EXECUTE | Codex opt-in | operational | service_dispatch | no | no |
| 51 | `agent_swarm_run` | EXECUTE | Codex opt-in | dependency_gated | service_dispatch | no | no |
| 52 | `shell` | EXECUTE | default | operational | service_dispatch | no | yes |
| 53 | `dom_cdp` | READ | default | operational | service_dispatch | no | yes |
| 54 | `computer_use` | EXECUTE | default | operational | service_dispatch | no | yes |
| 55 | `accessibility` | READ | default | operational | service_dispatch | no | yes |
| 56 | `input_event` | EXECUTE | default | operational | service_dispatch | no | yes |
| 57 | `vision` | READ | default | operational | service_dispatch | yes | no |
| 58 | `vision_annotated_capture` | READ | default | operational | service_dispatch | yes | no |
| 59 | `ui_target_action` | EXECUTE | default | operational | service_dispatch | no | yes |
| 60 | `window` | EXECUTE | default | operational | service_dispatch | no | yes |
| 61 | `health` | READ | default | operational | service_dispatch | yes | no |
| 62 | `system_info` | READ | default | operational | service_dispatch | yes | no |
| 63 | `notification` | EXECUTE | default | operational | service_dispatch | no | no |
| 64 | `file_dialog` | EXECUTE | default | operational | service_dispatch | yes | no |
| 65 | `clipboard` | EXECUTE | default | operational | service_dispatch | no | no |
| 66 | `web_fetch` | READ | default | operational | service_dispatch | no | yes |
| 67 | `audio` | EXECUTE | default | operational | service_dispatch | no | yes |
| 68 | `screen_record` | EXECUTE | default | operational | service_dispatch | no | yes |
| 69 | `office` | WRITE | default | operational | service_dispatch | no | no |
| 70 | `scheduler` | EXECUTE | default | operational | service_dispatch | no | yes |
| 71 | `wsl_exec` | EXECUTE | default | operational | service_dispatch | no | yes |
| 72 | `wsl_fs` | READ | default | operational | service_dispatch | yes | no |
| 73 | `skills_list` | READ | default | operational | service_dispatch | yes | no |
| 74 | `skills_read` | READ | default | operational | service_dispatch | yes | no |
| 75 | `skills_install` | WRITE | default | operational | service_dispatch | no | no |
| 76 | `ponytail_session` | WRITE | default | operational | service_dispatch | no | no |
| 77 | `task_bootstrap` | READ | default | operational | service_dispatch | yes | no |
| 78 | `policy_snapshot` | READ | default | operational | service_dispatch | yes | no |
| 79 | `mcp_list` | READ | default | operational | service_dispatch | yes | no |
| 80 | `mcp_describe` | READ | default | operational | service_dispatch | yes | no |
| 81 | `mcp_install` | WRITE | default | operational | service_dispatch | no | no |
| 82 | `mcp_call` | DANGEROUS | default | operational | service_dispatch | no | yes |
| 83 | `merge_policy_get` | READ | default | operational | service_dispatch | yes | no |
| 84 | `merge_verification_run` | EXECUTE | default | operational | service_dispatch | no | no |
| 85 | `merge_verification_status` | READ | default | operational | service_dispatch | yes | no |
| 86 | `guarded_pr_merge` | DANGEROUS | default | operational | service_dispatch | no | yes |
| 87 | `merge_reconcile` | WRITE | default | operational | service_dispatch | no | no |
| 88 | `heavy_job_queue_status` | READ | default | operational | service_dispatch | yes | no |
| 89 | `canonical_index_status` | READ | default | operational | service_dispatch | yes | no |
| 90 | `canonical_gc_status` | READ | default | operational | service_dispatch | yes | no |
| 91 | `canonical_revision_list` | READ | default | operational | service_dispatch | yes | no |
| 92 | `rag_recall` | READ | default | operational | service_dispatch | yes | no |
| 93 | `rag_remember` | WRITE | default | operational | service_dispatch | no | no |
| 94 | `workspace_memory_record` | WRITE | default | operational | service_dispatch | no | no |
| 95 | `rag_forget` | DANGEROUS | default | operational | service_dispatch | no | yes |
| 96 | `rag_pre_edit_context` | READ | default | operational | service_dispatch | yes | no |
| 97 | `rag_code_search` | READ | default | operational | service_dispatch | yes | no |
| 98 | `rag_code_context` | READ | default | operational | service_dispatch | yes | no |
| 99 | `rag_code_blast_radius` | READ | default | operational | service_dispatch | yes | no |
| 100 | `rag_adopt_legacy_index` | WRITE | default | operational | service_dispatch | no | no |
| 101 | `rag_code_index` | WRITE | default | operational | service_dispatch | no | no |
| 102 | `rag_index_status` | READ | default | operational | service_dispatch | yes | no |
| 103 | `rag_index_job_list` | READ | default | operational | service_dispatch | yes | no |
| 104 | `rag_cancel_index` | WRITE | default | operational | service_dispatch | no | no |
| 105 | `rag_resolve_constraint` | WRITE | default | operational | service_dispatch | no | no |
| 106 | `rag_get_event` | READ | default | operational | service_dispatch | yes | no |
| 107 | `rag_memory_reconcile` | WRITE | default | operational | service_dispatch | no | no |
| 108 | `rag_code_reconcile` | WRITE | default | operational | service_dispatch | no | no |
| 109 | `workspace_context` | READ | default | operational | service_dispatch | yes | no |
| 110 | `workspace_context_continue` | READ | default | operational | service_dispatch | yes | no |
| 111 | `workspace_full_scan` | READ | default | operational | service_dispatch | yes | no |
| 112 | `workspace_full_scan_continue` | READ | default | operational | deterministic_operation | yes | no |
| 113 | `workspace_snapshot` | READ | default | operational | service_dispatch | yes | no |
| 114 | `search_all` | READ | default | operational | service_dispatch | yes | no |
| 115 | `read_many_files` | READ | default | operational | service_dispatch | yes | no |
| 116 | `read_file_page` | READ | default | operational | service_dispatch | yes | no |
| 117 | `read_file_page_continue` | READ | default | operational | service_dispatch | yes | no |
| 118 | `workspace_index` | READ | default | operational | service_dispatch | no | no |
| 119 | `workspace_index_status` | READ | default | operational | service_dispatch | yes | no |
| 120 | `workspace_index_watch` | READ | default | operational | service_dispatch | no | no |
| 121 | `workspace_index_stop` | READ | default | operational | service_dispatch | no | no |
| 122 | `session_handoff` | READ | default | operational | service_dispatch | yes | no |
| 123 | `verify_incremental` | EXECUTE | default | operational | service_dispatch | no | no |
| 124 | `run_goal` | WRITE | default | operational | service_dispatch | no | no |
| 125 | `retry_goal_workspace_admission` | WRITE | default | operational | service_dispatch | no | no |
| 126 | `rebase_goal_workspace` | WRITE | default | operational | service_dispatch | no | yes |
| 127 | `get_goal` | READ | default | operational | service_dispatch | yes | no |
| 128 | `checkpoint_goal` | WRITE | default | operational | service_dispatch | no | no |
| 129 | `finish_goal` | WRITE | default | operational | service_dispatch | no | no |
| 130 | `cancel_goal` | WRITE | default | operational | service_dispatch | no | yes |
| 131 | `reconcile_goals` | WRITE | default | operational | service_dispatch | no | no |
| 132 | `reconcile_goal_worktrees` | READ | default | operational | service_dispatch | yes | no |
| 133 | `list_goals` | READ | default | operational | service_dispatch | yes | no |
| 134 | `prepare_scheduled_continuation` | WRITE | default | operational | service_dispatch | no | no |
| 135 | `record_scheduled_continuation_receipt` | WRITE | default | operational | service_dispatch | no | no |
| 136 | `claim_scheduled_continuation` | WRITE | default | operational | service_dispatch | no | no |
| 137 | `get_scheduled_continuation` | READ | default | operational | service_dispatch | yes | no |
| 138 | `expedite_scheduled_continuation` | WRITE | default | operational | service_dispatch | no | no |
| 139 | `cancel_scheduled_continuation` | WRITE | default | operational | service_dispatch | no | yes |
| 140 | `symbol_search` | READ | default | operational | service_dispatch | yes | no |
| 141 | `find_definition` | READ | default | operational | service_dispatch | yes | no |
| 142 | `find_references` | READ | default | operational | service_dispatch | yes | no |
| 143 | `find_implementations` | READ | default | operational | service_dispatch | yes | no |
| 144 | `call_hierarchy` | READ | default | operational | service_dispatch | yes | no |
| 145 | `import_graph` | READ | default | operational | service_dispatch | yes | no |
| 146 | `dependency_graph` | READ | default | operational | service_dispatch | yes | no |
| 147 | `module_graph` | READ | default | operational | service_dispatch | yes | no |
| 148 | `type_search` | READ | default | operational | service_dispatch | yes | no |
| 149 | `trace_symbol` | READ | default | operational | service_dispatch | yes | no |
| 150 | `context_ranking` | READ | default | operational | deterministic_operation | yes | no |
| 151 | `debug_context` | READ | default | operational | service_dispatch | yes | no |
| 152 | `review_context` | READ | default | operational | service_dispatch | yes | no |
| 153 | `change_context` | READ | default | operational | service_dispatch | yes | no |
| 154 | `symbol_context` | READ | default | operational | service_dispatch | yes | no |
| 155 | `test_context` | READ | default | operational | service_dispatch | yes | no |
| 156 | `dependency_context` | READ | default | operational | service_dispatch | yes | no |
| 157 | `git_context` | READ | default | operational | service_dispatch | yes | no |
| 158 | `frontend_context` | READ | default | operational | service_dispatch | yes | no |
| 159 | `backend_context` | READ | default | operational | service_dispatch | yes | no |
| 160 | `route_intent` | READ | default | operational | deterministic_operation | yes | no |
| 161 | `recipe_list` | READ | default | operational | deterministic_operation | yes | no |
| 162 | `recipe_describe` | READ | default | operational | deterministic_operation | yes | no |
| 163 | `recipe_run` | EXECUTE | default | operational | deterministic_operation | no | no |
| 164 | `dry_run` | READ | default | operational | deterministic_operation | yes | no |
| 165 | `review_changes` | READ | default | operational | service_dispatch | yes | no |
| 166 | `changed_symbols` | READ | default | operational | service_dispatch | yes | no |
| 167 | `affected_modules` | READ | default | operational | service_dispatch | yes | no |
| 168 | `git_history_context` | READ | default | operational | service_dispatch | yes | no |
| 169 | `git_blame_context` | READ | default | operational | service_dispatch | yes | no |
| 170 | `discover_tests` | READ | default | operational | service_dispatch | yes | no |
| 171 | `run_affected_tests` | EXECUTE | default | operational | service_dispatch | no | no |
| 172 | `test_failures` | READ | default | operational | service_dispatch | yes | no |
| 173 | `coverage_context` | READ | default | operational | service_dispatch | yes | no |
| 174 | `test_history` | READ | default | operational | service_dispatch | yes | no |
| 175 | `cache_stats` | READ | default | operational | deterministic_operation | yes | no |
| 176 | `cache_clear` | WRITE | default | operational | deterministic_operation | no | no |
| 177 | `cache_invalidate` | WRITE | default | operational | deterministic_operation | no | no |
| 178 | `hook_list` | READ | default | operational | deterministic_operation | yes | no |
| 179 | `hook_register` | WRITE | default | operational | deterministic_operation | no | no |
| 180 | `hook_remove` | WRITE | default | operational | deterministic_operation | no | no |
| 181 | `skill_match` | READ | default | operational | service_dispatch | yes | no |
| 182 | `skill_load` | READ | default | operational | service_dispatch | yes | no |
| 183 | `plugin_install` | WRITE | default | operational | truthful_unavailable | no | no |
| 184 | `plugin_list` | READ | default | operational | deterministic_operation | yes | no |
| 185 | `plugin_enable` | WRITE | default | operational | truthful_unavailable | no | no |
| 186 | `plugin_disable` | WRITE | default | operational | truthful_unavailable | no | no |
| 187 | `plugin_remove` | DANGEROUS | default | operational | truthful_unavailable | no | yes |
| 188 | `session_context` | READ | default | operational | deterministic_operation | yes | no |
| 189 | `session_checkpoint` | WRITE | default | operational | deterministic_operation | no | no |
| 190 | `session_resume` | READ | default | operational | deterministic_operation | yes | no |
| 191 | `session_history` | READ | default | operational | deterministic_operation | yes | no |
| 192 | `response_mode` | READ | default | operational | deterministic_operation | yes | no |
| 193 | `inspect_web_app` | READ | default | operational | service_dispatch | yes | no |
| 194 | `debug_ui` | READ | default | operational | service_dispatch | yes | no |
| 195 | `capture_ui_state` | READ | default | operational | service_dispatch | yes | no |
| 196 | `form_context` | READ | default | operational | service_dispatch | yes | no |
| 197 | `network_context` | READ | default | dependency_gated | truthful_unavailable | yes | no |
| 198 | `console_context` | READ | default | dependency_gated | truthful_unavailable | yes | no |
| 199 | `browser_debug_context` | READ | default | operational | service_dispatch | yes | no |
| 200 | `windows_environment` | READ | default | dependency_gated | truthful_unavailable | yes | no |
| 201 | `service_context` | READ | default | operational | deterministic_operation | yes | no |
| 202 | `process_context` | READ | default | operational | deterministic_operation | yes | no |
| 203 | `port_context` | READ | default | operational | deterministic_operation | yes | no |
| 204 | `registry_context` | READ | default | dependency_gated | truthful_unavailable | yes | no |
| 205 | `event_log_context` | READ | default | operational | deterministic_operation | yes | no |
| 206 | `installed_runtime_context` | READ | default | operational | deterministic_operation | yes | no |
| 207 | `path_context` | READ | default | operational | deterministic_operation | yes | no |
| 208 | `startup_context` | READ | default | operational | deterministic_operation | yes | no |
| 209 | `mcp_discover` | READ | default | operational | service_dispatch | yes | no |
| 210 | `mcp_health` | READ | default | operational | service_dispatch | yes | no |
| 211 | `mcp_resources` | READ | default | dependency_gated | service_dispatch | yes | no |
| 212 | `task_create` | EXECUTE | default | operational | service_dispatch | no | no |
| 213 | `task_status` | READ | default | operational | service_dispatch | yes | no |
| 214 | `task_cancel` | EXECUTE | default | operational | service_dispatch | no | no |
| 215 | `task_result` | READ | default | operational | service_dispatch | yes | no |
| 216 | `task_list` | READ | default | operational | service_dispatch | yes | no |
| 217 | `delegate` | EXECUTE | default | dependency_gated | service_dispatch | no | no |
| 218 | `delegate_status` | READ | default | dependency_gated | service_dispatch | yes | no |
| 219 | `delegate_cancel` | EXECUTE | default | dependency_gated | service_dispatch | no | no |
| 220 | `delegate_result` | READ | default | dependency_gated | service_dispatch | yes | no |
| 221 | `parallel_delegate` | EXECUTE | default | dependency_gated | service_dispatch | no | no |
| 222 | `permission_check` | READ | default | operational | deterministic_operation | yes | no |
| 223 | `permission_profile` | READ | default | operational | deterministic_operation | yes | no |
| 224 | `live_logs_query` | READ | default | operational | truthful_unavailable | yes | no |
| 225 | `live_logs_status` | READ | default | operational | truthful_unavailable | yes | no |
| 226 | `telemetry_dashboard` | READ | default | operational | deterministic_operation | yes | no |
| 227 | `context_economy_stats` | READ | default | operational | deterministic_operation | yes | no |
| 228 | `execution_plan` | READ | default | operational | deterministic_operation | yes | no |
| 229 | `repo_map` | READ | default | operational | service_dispatch | yes | no |
| 230 | `context_expand` | READ | default | operational | service_dispatch | yes | no |
| 231 | `recovery_status` | READ | default | operational | deterministic_operation | yes | no |
| 232 | `tool_schema_list` | READ | default | operational | deterministic_operation | yes | no |
| 233 | `tool_schema_register` | WRITE | default | operational | deterministic_operation | no | no |
| 234 | `capabilities` | READ | default | operational | deterministic_operation | yes | no |
| 235 | `tool_search` | READ | default | operational | deterministic_operation | yes | no |
| 236 | `tool_dynamic_filter` | READ | default | operational | deterministic_operation | yes | no |
| 237 | `tool_describe` | READ | default | operational | deterministic_operation | yes | no |
| 238 | `tool_categories` | READ | default | operational | deterministic_operation | yes | no |
| 239 | `tool_function_find` | READ | default | operational | deterministic_operation | yes | no |
| 240 | `tool_aliases` | READ | default | operational | deterministic_operation | yes | no |
| 241 | `mcp_hub` | READ | default | dependency_gated | service_dispatch | yes | no |
| 242 | `dev_context` | READ | default | operational | service_dispatch | yes | no |
| 243 | `recipe_catalog` | READ | default | operational | deterministic_operation | yes | no |
| 244 | `capture_screenshot` | READ | default | operational | service_dispatch | yes | no |
| 245 | `compare_screenshot` | READ | default | operational | deterministic_operation | yes | no |
| 246 | `dom_snapshot` | READ | default | operational | service_dispatch | yes | no |
| 247 | `layout_metadata` | READ | default | operational | service_dispatch | yes | no |
| 248 | `visual_context` | READ | default | operational | service_dispatch | yes | no |
| 249 | `inspect_workbook` | READ | default | operational | service_dispatch | yes | no |
| 250 | `compare_workbook_layout` | READ | default | dependency_gated | service_dispatch | yes | no |
| 251 | `render_excel_preview` | READ | default | dependency_gated | service_dispatch | yes | no |
| 252 | `inspect_pdf` | READ | default | dependency_gated | truthful_unavailable | yes | no |
| 253 | `compare_pdf_pages` | READ | default | dependency_gated | truthful_unavailable | yes | no |
| 254 | `project_profile_get` | READ | default | operational | service_dispatch | yes | no |
| 255 | `project_profile_set` | WRITE | default | operational | deterministic_operation | no | no |
| 256 | `handoff_context` | READ | default | operational | service_dispatch | yes | no |
| 257 | `benchmark_run` | EXECUTE | default | dependency_gated | service_dispatch | no | no |
| 258 | `regression_report` | READ | default | operational | deterministic_operation | yes | no |
| 259 | `sandbox_exec` | EXECUTE | default | dependency_gated | truthful_unavailable | no | no |
| 260 | `event_watch` | EXECUTE | default | dependency_gated | deterministic_operation | no | no |
| 261 | `crash_trace` | READ | default | dependency_gated | deterministic_operation | yes | no |
| 262 | `lsp_diagnostics` | READ | default | dependency_gated | truthful_unavailable | yes | no |
| 263 | `lsp_rename` | WRITE | default | dependency_gated | truthful_unavailable | no | no |
| 264 | `debug_attach` | EXECUTE | default | dependency_gated | truthful_unavailable | no | no |
| 265 | `debug_step` | EXECUTE | default | dependency_gated | truthful_unavailable | no | no |
| 266 | `git_worktree_spawn` | EXECUTE | default | dependency_gated | deterministic_operation | no | no |
| 267 | `git_worktree_remove` | DANGEROUS | default | dependency_gated | service_dispatch | no | yes |
| 268 | `db_inspect` | READ | default | dependency_gated | truthful_unavailable | yes | no |
| 269 | `db_query` | READ | default | dependency_gated | truthful_unavailable | yes | no |
| 270 | `office_ppt` | WRITE | default | dependency_gated | service_dispatch | no | no |
| 271 | `office_outlook` | READ | default | dependency_gated | truthful_unavailable | yes | no |
| 272 | `pdf_extract_tables` | READ | default | dependency_gated | truthful_unavailable | yes | no |
| 273 | `docx_merge` | WRITE | default | dependency_gated | service_dispatch | no | no |
| 274 | `self_heal_plan` | READ | default | operational | service_dispatch | yes | no |
| 275 | `self_heal_apply` | DANGEROUS | default | dependency_gated | service_dispatch | no | yes |
| 276 | `skills_import` | WRITE | default | operational | service_dispatch | no | no |
| 277 | `tool_batch` | EXECUTE | default | operational | service_dispatch | no | yes |
<!-- END GENERATED TOOL REGISTRY -->

## Protocol and result rules

- Tool names, permissions, annotations, and advertised state come from the live registry.
- Input validation is performed by the registered Zod schema before dispatch.
- Release verification fails when the generated inventory drifts from the runtime registry.
