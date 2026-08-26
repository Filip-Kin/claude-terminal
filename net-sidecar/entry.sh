#!/usr/bin/env bash
# Image entrypoint. One image, two roles, chosen by NETHUB_ROLE:
#   hub    -> hub-entry.sh    (routes to tunnels, resolver, tailscale; the netns joined)
#   tunnel -> tunnel-entry.sh (one OpenVPN tunnel + its NAT-remap)
set -u
case "${NETHUB_ROLE:-hub}" in
  hub)    exec /usr/local/bin/hub-entry.sh ;;
  tunnel) exec /usr/local/bin/tunnel-entry.sh ;;
  *)      echo "unknown NETHUB_ROLE=$NETHUB_ROLE" >&2; exit 2 ;;
esac
