#!/usr/bin/env bash
# Runs as the entrypoint of the hub container (NETHUB_ROLE=hub). The container that
# wants network access joins THIS container's netns (`--network container:<hub>`),
# so everything set up here - routes to each tunnel, the resolver, tailscale - is
# what the joining container sees. Needs only NET_ADMIN (+ /dev/net/tun for tailscale).
#
# It routes each fake range to its tunnel CONTAINER (resolved by name on the shared
# docker bridge), runs dnsmasq (friendly names + tailnet MagicDNS), and brings up
# tailscale for any tailscale-type tunnel (their own tailnet; login URL in status).
set -uo pipefail
STATE=/etc/nethub/state.json
RUN=/run/nethub; mkdir -p "$RUN"
DNS_ADDR=10.90.0.1
log(){ echo "[hub] $*" >&2; }
[ -f "$STATE" ] || { echo '{"tunnels":[]}' > "$RUN/status.json"; exec sleep infinity; }

# --- resolver on a stable dummy IP the joining container points at -----------
ip link add nhdns type dummy 2>/dev/null || true
ip addr add "$DNS_ADDR/32" dev nhdns 2>/dev/null || true
ip link set nhdns up
CONF=$RUN/dnsmasq.conf
{ echo "listen-address=$DNS_ADDR"; echo "bind-interfaces"; echo "no-resolv"; echo "no-hosts"
  echo "server=1.1.1.1"; echo "server=1.0.0.1"; } > "$CONF"
if [ "$(jq -r '.dnsHosts // [] | length' "$STATE")" != "0" ]; then
  while IFS=$'\t' read -r hn hip; do [ -n "$hn" ] && echo "address=/$hn/$hip" >> "$CONF"; done \
    < <(jq -r '.dnsHosts[] | [.name,.ip] | @tsv' "$STATE")
fi

# --- route each fake range to its tunnel container ---------------------------
# net-apply injects hubRoutes:[{fake, via:"<tunnel container name>"}]. Names resolve
# on the user-defined bridge, so we look up the current IP (survives tunnel restart).
if [ "$(jq -r '.hubRoutes // [] | length' "$STATE")" != "0" ]; then
  while IFS=$'\t' read -r fake via; do
    [ -n "$fake" ] || continue
    ip=""; for _ in $(seq 1 20); do ip=$(getent hosts "$via" | awk '{print $1;exit}'); [ -n "$ip" ] && break; sleep 0.5; done
    if [ -n "$ip" ]; then ip route replace "$fake" via "$ip"; log "$fake via $via ($ip)"
    else log "could not resolve tunnel $via for $fake"; fi
  done < <(jq -r '.hubRoutes[] | [.fake,.via] | @tsv' "$STATE")
fi

# --- tailscale tunnels (their own tailnet, main netns, no remap) -------------
declare -a TS_IDS=()
while read -r id name; do
  [ -n "$id" ] || continue
  TS_IDS+=("$id")
  sd="/var/lib/nethub/tailscale/$id"; mkdir -p "$sd" /var/run/tailscale
  tailscaled --state="$sd/tailscaled.state" --socket="/var/run/tailscale/$id.sock" --tun="ts-$id" >/dev/null 2>&1 &
  sock="/var/run/tailscale/$id.sock"; for _ in $(seq 1 20); do [ -S "$sock" ] && break; sleep 0.3; done
  up=$(tailscale --socket="$sock" up --hostname="ct-$name" --accept-routes --timeout=3s 2>&1) || true
  magic=$(tailscale --socket="$sock" status --json 2>/dev/null | jq -r '.MagicDNSSuffix // empty')
  [ -n "$magic" ] && echo "server=/$magic/100.100.100.100" >> "$CONF"
done < <(jq -r '.tunnels[] | select(.type=="tailscale" and .enabled==true) | [.id,.name] | @tsv' "$STATE")

pkill dnsmasq 2>/dev/null || true
dnsmasq --conf-file="$CONF" --keep-in-foreground >/dev/null 2>&1 &

# hub status = just the tailscale tunnels (openvpn status comes from their own
# containers; net-apply merges). Refresh so a completed login flips up:true.
emit_status(){
  local arr='[]'
  for id in "${TS_IDS[@]:-}"; do
    [ -n "$id" ] || continue
    local sock="/var/run/tailscale/$id.sock"
    local st ip url
    st=$(tailscale --socket="$sock" status --json 2>/dev/null | jq -r '.BackendState // "Unknown"')
    ip=$(tailscale --socket="$sock" ip -4 2>/dev/null | head -1)
    url=$(tailscale --socket="$sock" status --json 2>/dev/null | jq -r '.AuthURL // empty')
    arr=$(echo "$arr" | jq -c --arg id "$id" --arg st "$st" --arg ip "$ip" --arg url "$url" \
      '. + [ {id:$id,type:"tailscale",state:$st,up:($st=="Running"),ip:$ip}
             + (if $url!="" and $st!="Running" then {needsLogin:true,loginUrl:$url} else {} end) ]')
  done
  jq -nc --argjson t "$arr" '{tunnels:$t}' > "$RUN/status.json"
}
emit_status
log "up"
while true; do sleep 15; emit_status; done
