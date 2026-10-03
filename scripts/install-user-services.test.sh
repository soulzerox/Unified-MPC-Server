#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
subject="$repo_root/scripts/install-user-services.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fake_bin="$tmp/bin"
mkdir -p "$fake_bin"
log="$tmp/commands.log"
linger_state="$tmp/linger.state"
printf 'no\n' > "$linger_state"

cat > "$fake_bin/loginctl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'loginctl %s\n' "$*" >> "$FAKE_COMMAND_LOG"
case "${1:-}" in
  show-user)
    if [[ "${*: -1}" == "--value" || "$*" == *" --value"* ]]; then
      cat "$FAKE_LINGER_STATE"
    else
      printf 'Linger=%s\n' "$(cat "$FAKE_LINGER_STATE")"
    fi
    ;;
  enable-linger)
    if [[ "${FAKE_LINGER_CAN_ENABLE:-1}" == "1" ]]; then
      printf 'yes\n' > "$FAKE_LINGER_STATE"
      exit 0
    fi
    exit 1
    ;;
  *)
    exit 2
    ;;
esac
EOF
chmod +x "$fake_bin/loginctl"

cat > "$fake_bin/systemctl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'systemctl %s\n' "$*" >> "$FAKE_COMMAND_LOG"
case "$*" in
  *"is-enabled unified-mpc.service"*) printf 'enabled\n';;
  *"is-active "*) printf 'active\n';;
esac
exit 0
EOF
chmod +x "$fake_bin/systemctl"

run_subject() {
  HOME="$tmp/home" \
  XDG_CONFIG_HOME="$tmp/home/.config" \
  USER="testuser" \
  UNIFIED_MPC_SYSTEMCTL_BIN="$fake_bin/systemctl" \
  UNIFIED_MPC_LOGINCTL_BIN="$fake_bin/loginctl" \
  FAKE_COMMAND_LOG="$log" \
  FAKE_LINGER_STATE="$linger_state" \
  FAKE_LINGER_CAN_ENABLE="${FAKE_LINGER_CAN_ENABLE:-1}" \
  bash "$subject"
}

mkdir -p "$tmp/home/.config/unified-mpc"
cat > "$tmp/home/.config/unified-mpc/service.env" <<'EOF'
UNIFIED_MPC_ROOT=/tmp/runtime/current
UNIFIED_MPC_WORKSPACE=/tmp/workspace
PATH=/usr/local/bin:/usr/bin:/bin
EOF

out="$(run_subject)"
grep -Fq 'BOOT_PERSISTENCE_READY' <<<"$out"
grep -Fq 'loginctl enable-linger testuser' "$log"
grep -Fq 'systemctl --user daemon-reload' "$log"
grep -Fq 'systemctl --user enable --now unified-mpc.service' "$log"
grep -Fq 'systemctl --user is-enabled unified-mpc.service' "$log"
grep -Fq 'systemctl --user is-active unified-mpc-mcp-http.service' "$log"
grep -Fq 'systemctl --user is-active unified-mpc-web.service' "$log"
test -f "$tmp/home/.config/systemd/user/unified-mpc.service"
test -f "$tmp/home/.config/systemd/user/unified-mpc-mcp-http.service"
test -f "$tmp/home/.config/systemd/user/unified-mpc-web.service"
test -x "$tmp/home/.config/unified-mpc/launch-runtime.sh"

rm -rf "$tmp/home/.config/unified-mpc" "$tmp/home/.config/systemd"
: > "$log"
printf 'no\n' > "$linger_state"
set +e
missing_out="$(run_subject 2>&1)"
missing_rc=$?
set -e
[[ "$missing_rc" -eq 2 ]]
grep -Fq 'CONFIG_REQUIRED' <<<"$missing_out"
test -f "$tmp/home/.config/unified-mpc/service.env"
! grep -Fq 'systemctl --user enable --now unified-mpc.service' "$log"

cat > "$tmp/home/.config/unified-mpc/service.env" <<'EOF'
UNIFIED_MPC_ROOT=/tmp/runtime/current
UNIFIED_MPC_WORKSPACE=/tmp/workspace
PATH=/usr/local/bin:/usr/bin:/bin
EOF
: > "$log"
printf 'no\n' > "$linger_state"
set +e
blocked_out="$(FAKE_LINGER_CAN_ENABLE=0 run_subject 2>&1)"
blocked_rc=$?
set -e
[[ "$blocked_rc" -eq 3 ]]
grep -Fq 'BOOT_PERSISTENCE_UNAVAILABLE' <<<"$blocked_out"
! grep -Fq 'systemctl --user enable --now unified-mpc.service' "$log"

echo "install-user-services regression: PASS"
