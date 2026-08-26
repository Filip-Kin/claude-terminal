#!/usr/bin/env bash
# Reference apply-helper for claude-terminal's Connections feature.
#
# claude-terminal (userspace) calls this with desired-state JSON on stdin; this does
# the PRIVILEGED, host-specific work: sanitise each .ovpn and (re)create the docker
# containers - one per OpenVPN tunnel plus one hub the target joins. Each container
# needs only NET_ADMIN + /dev/net/tun (the tunnels also --sysctl ip_forward=1).
#
# Point config.json at it:  "netApplyHelper": "/path/to/net-apply.sh"
# Protocol:  net-apply.sh apply  < desired-state.json  -> prints merged status.json
#            net-apply.sh status                        -> prints merged status.json
#
# Env knobs:
#   NETHUB_NAME     hub container name / prefix   (default: nethub)
#   NETHUB_IMAGE    image                          (default: net-sidecar:latest)
#   NETHUB_NET      docker bridge network          (default: <name>-net)
#   NETHUB_CONFDIR  state.json + tunnels/          (default: /var/lib/<name>-conf)
#   NETHUB_TSDIR    tailscale state (persistent)   (default: /var/lib/<name>-ts)
#   NETHUB_ONRECREATE  command run after the hub (re)starts, to recouple the
#                      joining container (e.g. add-guest.sh <user>)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
NAME="${NETHUB_NAME:-nethub}"
IMG="${NETHUB_IMAGE:-net-sidecar:latest}"
NET="${NETHUB_NET:-${NAME}-net}"
CONFDIR="${NETHUB_CONFDIR:-/var/lib/${NAME}-conf}"
TSDIR="${NETHUB_TSDIR:-/var/lib/${NAME}-ts}"

tun_cname(){ echo "${NAME}-t-$1"; }   # per-tunnel container name (also its DNS name on $NET)

merge_status(){
  # merge every container's /run/nethub/status.json into one {tunnels:[...]}
  local acc='{"tunnels":[]}'
  for c in $(docker ps --filter "label=nethub=$NAME" --format '{{.Names}}' 2>/dev/null); do
    local s; s=$(docker exec "$c" cat /run/nethub/status.json 2>/dev/null || echo '{"tunnels":[]}')
    acc=$(jq -c --argjson s "$s" '.tunnels += ($s.tunnels // [])' <<<"$acc")
  done
  echo "$acc"
}

cmd="${1:-status}"
if [ "$cmd" = status ]; then merge_status; exit 0; fi
[ "$cmd" = apply ] || { echo "usage: $0 apply|status" >&2; exit 2; }

STATE="$(cat)"
mkdir -p "$CONFDIR/tunnels" "$TSDIR"
docker network inspect "$NET" >/dev/null 2>&1 || docker network create "$NET" >/dev/null

# ids of enabled openvpn tunnels
mapfile -t OVPN < <(jq -r '.tunnels[] | select(.type=="openvpn" and .enabled==true) | .id' <<<"$STATE")

# --- (re)create one container per enabled OpenVPN tunnel ---------------------
declare -a HUBROUTES=()
declare -a AUTO_TUNNELS=()   # container names of auto (no-remap) tunnels to resolve later
auto_idx=0
for id in "${OVPN[@]:-}"; do
  [ -n "$id" ] || continue
  d="$CONFDIR/tunnels/$id"; rm -rf "$d"; mkdir -p "$d"
  jq -r --arg id "$id" '.tunnels[] | select(.id==$id) | .ovpn // ""' <<<"$STATE" | "$HERE/ovpn-sanitize.sh" > "$d/client.ovpn"
  jq -r --arg id "$id" '.tunnels[] | select(.id==$id) | .creds // ""' <<<"$STATE" > "$d/creds.txt"; chmod 600 "$d/creds.txt"
  # per-container state (just this tunnel's remaps) mounted at /etc/nethub
  jq -c --arg id "$id" '{tunnels:[.tunnels[]|select(.id==$id)|{id,type,name,enabled,remaps}]}' <<<"$STATE" > "$d/state.json"
  cname="$(tun_cname "$id")"
  nremaps=$(jq --arg id "$id" '[.tunnels[]|select(.id==$id)|.remaps[]?]|length' <<<"$STATE")
  # AUTO mode (no user subnets): give this tunnel its own /16 fake base so the container
  # can map the routes the server pushes without colliding with other tunnels.
  autoenv=()
  if [ "${nremaps:-0}" = 0 ]; then
    # per-tunnel /16 fake base 10.<oct>.0.0. Start at 91 (90 is the manual pool) and skip
    # reserved 10.x second-octets: 200 (docker default-address-pool). 100 is fine (fake FMS
    # is 10.0.100.x, second octet 0). Fail loudly rather than emit an invalid octet.
    oct=$((91 + auto_idx))
    while [ "$oct" = 200 ]; do oct=$((oct+1)); done
    if [ "$oct" -gt 255 ]; then echo "too many auto tunnels for one guest (fake bases exhausted)" >&2; oct=255; fi
    autoenv=(-e "AUTO_FAKE_BASE=10.$oct"); auto_idx=$((auto_idx+1)); AUTO_TUNNELS+=("$cname")
  fi
  docker rm -f "$cname" >/dev/null 2>&1 || true
  docker run -d --name "$cname" --label "nethub=$NAME" --network "$NET" \
    --cap-add NET_ADMIN --device /dev/net/tun --sysctl net.ipv4.ip_forward=1 \
    --restart unless-stopped \
    -e NETHUB_ROLE=tunnel -e TUN_ID="$id" "${autoenv[@]}" \
    -v "$d/state.json:/etc/nethub/state.json:ro" -v "$d:/etc/nethub/tunnels/$id:ro" \
    "$IMG" >/dev/null
  # MANUAL: fakes are known now -> hub routes immediately.
  while read -r fake; do [ -n "$fake" ] && HUBROUTES+=("{\"fake\":\"$fake\",\"via\":\"$cname\"}"); done \
    < <(jq -r --arg id "$id" '.tunnels[]|select(.id==$id)|.remaps[]?|.fake' <<<"$STATE")
done

# AUTO tunnels: wait for each to report the fakes it allocated for the pushed routes,
# then add hub routes for them (so the hub can reach them).
for cname in "${AUTO_TUNNELS[@]:-}"; do
  [ -n "$cname" ] || continue
  for _ in $(seq 1 50); do
    fakes=$(docker exec "$cname" cat /run/nethub/status.json 2>/dev/null | jq -r '.tunnels[0].remaps[]?.fake' 2>/dev/null)
    [ -n "$fakes" ] && break; sleep 0.5
  done
  while read -r fake; do [ -n "$fake" ] && HUBROUTES+=("{\"fake\":\"$fake\",\"via\":\"$cname\"}"); done <<<"$fakes"
done

# tear down tunnel containers whose tunnel is gone/disabled
keep=" $(printf '%s ' "${OVPN[@]:-}")"
for c in $(docker ps -a --filter "label=nethub=$NAME" --format '{{.Names}}' | grep -F "${NAME}-t-" || true); do
  tid="${c#${NAME}-t-}"; case "$keep" in *" $tid "*) : ;; *) docker rm -f "$c" >/dev/null 2>&1 || true ;; esac
done

# --- hub state (routes to tunnels + dnsHosts + tailscale tunnels) -------------
hubroutes_json="[ $(IFS=,; echo "${HUBROUTES[*]:-}") ]"
jq -c --argjson hr "$hubroutes_json" '{
  tunnels: [ .tunnels[] | select(.type=="tailscale") | {id,type,name,enabled} ],
  dnsHosts: (.dnsHosts // []),
  hubRoutes: $hr
}' <<<"$STATE" > "$CONFDIR/hub-state.json"

# --- (re)create the hub (the netns the target joins) -------------------------
# NETHUB_PUBLISH (space-separated docker -p specs) publishes the joining container's
# ports ON the hub, since a container in --network container: mode can't publish its own.
PUB=(); for p in ${NETHUB_PUBLISH:-}; do PUB+=(-p "$p"); done
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" --label "nethub=$NAME" --network "$NET" \
  --cap-add NET_ADMIN --device /dev/net/tun \
  --restart unless-stopped \
  "${PUB[@]}" \
  -e NETHUB_ROLE=hub \
  -v "$CONFDIR/hub-state.json:/etc/nethub/state.json:ro" \
  -v "$TSDIR:/var/lib/nethub" \
  "$IMG" >/dev/null

for _ in $(seq 1 30); do docker exec "$NAME" test -f /run/nethub/status.json 2>/dev/null && break; sleep 0.5; done

# recouple whatever joins the hub's netns (caller-specific). Send its output to
# stderr so ONLY the status JSON below reaches stdout (the caller parses stdout).
[ -n "${NETHUB_ONRECREATE:-}" ] && bash -c "$NETHUB_ONRECREATE" >&2 2>&1 || true

merge_status
