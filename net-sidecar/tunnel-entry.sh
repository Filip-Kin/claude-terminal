#!/usr/bin/env bash
# Runs as the entrypoint of a per-OpenVPN-tunnel container (NETHUB_ROLE=tunnel).
# One container per tunnel, so docker owns the netns and we need only NET_ADMIN +
# /dev/net/tun (no SYS_ADMIN). It brings up openvpn and NAT-remaps this tunnel's fake
# range(s) to the real subnet(s) it reaches.
#
# Two modes:
#   - MANUAL: state.json carries explicit remaps [{real,fake}] (user gave subnets).
#   - AUTO  : no remaps + AUTO_FAKE_BASE set -> we parse the routes the SERVER PUSHES
#             and map each (that is /24 or longer) into AUTO_FAKE_BASE.<i>.0/<len>.
#
# The hub routes each fake range here (by container name); we forward it out the tun:
#   PREROUTING NETMAP fake->real ; route real dev tun ; MASQUERADE out tun.
# ip_forward is set by docker (--sysctl) since /proc/sys is read-only in a container.
set -uo pipefail
ID="${TUN_ID:?TUN_ID required}"
STATE=/etc/nethub/state.json
D="/etc/nethub/tunnels/$ID"
RUN=/run/nethub; mkdir -p "$RUN"
AUTO_FAKE_BASE="${AUTO_FAKE_BASE:-}"
log(){ echo "[tunnel $ID] $*" >&2; }

ovpn="$D/client.ovpn"; creds="$D/creds.txt"
[ -f "$ovpn" ] || { log "no client.ovpn"; echo '{"tunnels":[]}' > "$RUN/status.json"; exec sleep infinity; }

# only pass creds if the file actually has a non-blank line (an empty jq "" write
# leaves a lone newline, which is NOT a real credential)
credargs=()
if [ -f "$creds" ] && grep -q '[^[:space:]]' "$creds" 2>/dev/null; then credargs=(--auth-user-pass "$creds"); fi
openvpn --config "$ovpn" --route-nopull --script-security 1 \
        "${credargs[@]}" --log "$RUN/$ID.log" --verb 3 --daemon "ovpn-$ID"

# wait for the tun device
tun=""
for _ in $(seq 1 40); do
  tun=$(ip -o link show type tun 2>/dev/null | awk -F': ' 'NR==1{print $2}')
  [ -n "$tun" ] && ip -o addr show dev "$tun" 2>/dev/null | grep -q inet && break
  sleep 0.5
done

# dotted-quad netmask -> prefix length
mask2len(){
  local m=$1 len=0 o; local IFS=.
  for o in $m; do case $o in 255)len=$((len+8));;254)len=$((len+7));;252)len=$((len+6));;248)len=$((len+5));;240)len=$((len+4));;224)len=$((len+3));;192)len=$((len+2));;128)len=$((len+1));;esac; done
  echo "$len"
}
# subnets the server PUSHED (parsed from the PUSH_REPLY line), as CIDRs
detect_subnets(){
  grep -h 'PUSH_REPLY' "$RUN/$ID.log" 2>/dev/null | tr ',' '\n' \
    | sed -n 's/^[[:space:]]*route[[:space:]]\+//p' \
    | while read -r a b _; do
        case "$a" in 0.0.0.0|"") continue;; esac
        if printf '%s' "$a" | grep -q '/'; then echo "$a"
        elif [ -n "$b" ]; then echo "$a/$(mask2len "$b")"; fi
      done | sort -u
}

write_status(){ # up remaps_json detected_json unmapped_json
  jq -nc --arg id "$ID" --argjson up "$1" --argjson rm "$2" --argjson det "$3" --argjson un "$4" \
    '{tunnels:[{id:$id,type:"openvpn",up:$up,remaps:$rm,detected:$det,unmapped:$un}]}' > "$RUN/status.json"
}

if [ -z "$tun" ]; then
  log "tunnel did not come up (see $RUN/$ID.log)"
  jq -nc --arg id "$ID" '{tunnels:[{id:$id,type:"openvpn",up:false,error:"tunnel did not come up"}]}' > "$RUN/status.json"
  exec sleep infinity
fi
log "tun=$tun up"
iptables -t nat -A POSTROUTING -o "$tun" -j MASQUERADE

apply_remap(){ # real fake
  iptables -t nat -A PREROUTING -d "$2" -j NETMAP --to "$1"
  ip route replace "$1" dev "$tun"
  log "$2 -> $1 via $tun"
}

remaps=$(jq -c --arg id "$ID" '.tunnels[] | select(.id==$id) | .remaps // []' "$STATE" 2>/dev/null || echo '[]')
rows='[]'; unmapped='[]'
det_list=$(detect_subnets)
detected=$(printf '%s\n' "$det_list" | sed '/^$/d' | jq -R . | jq -s .)

if [ "$(echo "$remaps" | jq 'length')" -gt 0 ]; then
  # MANUAL: apply the fakes connections.ts already allocated
  cnt=$(echo "$remaps" | jq 'length')
  for k in $(seq 0 $((cnt-1))); do
    real=$(echo "$remaps" | jq -r ".[$k].real"); fake=$(echo "$remaps" | jq -r ".[$k].fake")
    [ "$real" = null ] && continue
    apply_remap "$real" "$fake"
    rows=$(echo "$rows" | jq -c --arg r "$real" --arg f "$fake" '. + [{real:$r,fake:$f}]')
  done
elif [ -n "$AUTO_FAKE_BASE" ]; then
  # AUTO: map each pushed subnet /24-or-longer into our private base; bigger subnets
  # (shorter prefix) are reported as needing a manual entry.
  i=0
  for real in $det_list; do
    [ -n "$real" ] || continue
    L=${real#*/}
    if [ "${L:-0}" -ge 24 ] 2>/dev/null; then
      fake="${AUTO_FAKE_BASE}.${i}.0/${L}"
      apply_remap "$real" "$fake"
      rows=$(echo "$rows" | jq -c --arg r "$real" --arg f "$fake" '. + [{real:$r,fake:$f}]')
      i=$((i+1))
    else
      unmapped=$(echo "$unmapped" | jq -c --arg r "$real" '. + [$r]')
    fi
  done
  [ "$(echo "$rows" | jq 'length')" = 0 ] && log "auto: no /24+ routes detected yet (server may not push routes)"
fi
write_status true "$rows" "$detected" "$unmapped"

# keep alive; re-detect + reflect tun going down
while true; do
  sleep 15
  if ! ip -o addr show dev "$tun" 2>/dev/null | grep -q inet; then
    log "tun went down"
    jq -nc --arg id "$ID" --argjson rm "$rows" '{tunnels:[{id:$id,type:"openvpn",up:false,remaps:$rm,error:"tunnel dropped"}]}' > "$RUN/status.json"
  fi
done
