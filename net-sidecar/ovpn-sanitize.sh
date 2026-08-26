#!/usr/bin/env bash
# Harden a user-supplied .ovpn before it is ever handed to openvpn.
#
# A guest-supplied config can carry directives that run arbitrary commands as
# root inside the sidecar (up/down/route-up/script-security/plugin/...). The
# sidecar is capless-except-NET_ADMIN with no sensitive mounts, so the blast
# radius is small - but we strip these anyway, defence in depth. We also force
# split-tunnel (route-nopull) so a server can never move our default route.
#
# Usage: ovpn-sanitize.sh < input.ovpn > safe.ovpn
set -euo pipefail

# directives that can execute code or repoint the whole box - dropped outright.
DROP='^[[:space:]]*(up|down|route-up|route-pre-down|ipchange|tls-verify|tls-export-cert|auth-user-pass-verify|client-connect|client-disconnect|learn-address|plugin|script-security|setenv-safe|management-external-cmd)([[:space:]]|$)'
# pull directives we override ourselves - dropped so ours win, re-added at the end.
STRIP='^[[:space:]]*(route-nopull|redirect-gateway|redirect-private|auth-user-pass|dev-node)([[:space:]]|$)'

grep -viE "$DROP" \
  | grep -viE "$STRIP" \
  | sed -E 's/^[[:space:]]*//'

# our overrides. auth-user-pass is NOT set here - apply.sh passes it on the
# command line pointing at the per-tunnel creds file, so it works whether or
# not the original config used a password.
cat <<'EOF'

# --- injected by ovpn-sanitize.sh ---
route-nopull
script-security 1
allow-compression yes
data-ciphers-fallback AES-256-CBC
EOF
