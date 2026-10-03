#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
config_home="${XDG_CONFIG_HOME:-$HOME/.config}"
unit_dir="${UNIFIED_MPC_USER_UNIT_DIR:-$config_home/systemd/user}"
config_dir="${UNIFIED_MPC_CONFIG_DIR:-$config_home/unified-mpc}"
systemctl_bin="${UNIFIED_MPC_SYSTEMCTL_BIN:-systemctl}"
loginctl_bin="${UNIFIED_MPC_LOGINCTL_BIN:-loginctl}"
user_name="${UNIFIED_MPC_USER_NAME:-${USER:-$(id -un)}}"

mkdir -p "$unit_dir" "$config_dir"

install -m 0644 "$repo_root/scripts/unified-mpc.service" "$unit_dir/unified-mpc.service"
install -m 0644 "$repo_root/scripts/unified-mpc-mcp-http.service" "$unit_dir/unified-mpc-mcp-http.service"
install -m 0644 "$repo_root/scripts/unified-mpc-web.service" "$unit_dir/unified-mpc-web.service"
install -m 0755 "$repo_root/scripts/validate-runtime-root.sh" "$config_dir/validate-runtime-root.sh"
install -m 0755 "$repo_root/scripts/launch-runtime.sh" "$config_dir/launch-runtime.sh"
install -m 0755 "$repo_root/scripts/promote-runtime.sh" "$config_dir/promote-runtime.sh"

if [[ ! -f "$config_dir/service.env" ]]; then
  install -m 0600 "$repo_root/scripts/unified-mpc.service.env.example" "$config_dir/service.env"
  printf '%s\n' "CONFIG_REQUIRED: created $config_dir/service.env; replace example paths, then rerun scripts/install-user-services.sh" >&2
  exit 2
fi

read_linger() {
  "$loginctl_bin" show-user "$user_name" -p Linger --value 2>/dev/null || true
}

linger="$(read_linger)"
if [[ "${linger,,}" != "yes" ]]; then
  printf '%s\n' "BOOT_PERSISTENCE_SETUP: enabling systemd user linger for $user_name"
  if ! "$loginctl_bin" enable-linger "$user_name"; then
    printf '%s\n' "BOOT_PERSISTENCE_UNAVAILABLE: loginctl could not enable linger for $user_name" >&2
    exit 3
  fi
  linger="$(read_linger)"
fi

if [[ "${linger,,}" != "yes" ]]; then
  printf '%s\n' "BOOT_PERSISTENCE_UNAVAILABLE: Linger is not enabled for $user_name" >&2
  exit 3
fi

"$systemctl_bin" --user daemon-reload

if ! "$systemctl_bin" --user enable --now unified-mpc.service; then
  printf '%s\n' "SERVICE_START_FAILED: could not enable/start unified-mpc.service; inspect service.env and journalctl --user -u unified-mpc.service" >&2
  exit 4
fi

if ! "$systemctl_bin" --user is-enabled unified-mpc.service >/dev/null; then
  printf '%s\n' "BOOT_PERSISTENCE_UNAVAILABLE: unified-mpc.service is not enabled" >&2
  exit 4
fi

for unit in unified-mpc.service unified-mpc-mcp-http.service unified-mpc-web.service; do
  if ! "$systemctl_bin" --user is-active "$unit" >/dev/null; then
    printf '%s\n' "SERVICE_START_FAILED: $unit is not active after aggregate startup" >&2
    exit 4
  fi
done

printf '%s\n' "BOOT_PERSISTENCE_READY: Linger=yes; unified-mpc.service enabled; MCP HTTP and Web child services active"
