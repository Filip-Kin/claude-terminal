#!/usr/bin/env bash
# Hands-on test with YOUR OWN OpenVPN config. Brings the tunnel up via the real
# orchestrator, then drops you into a shell that is joined to the hub's netns - so
# you can curl / ssh / ping your remote LAN through the fake range, exactly as a
# terminal container would. Nothing here touches the live guests.
#
#   sudo ./test-realvpn.sh <name> <path/to/client.ovpn> <subnet> [user] [pass]
#   e.g. sudo ./test-realvpn.sh work ~/vpn.d/michel/client.ovpn 192.168.2.0/24
#
# The subnet is remapped to 10.90.1.0/24, so a host at 192.168.2.5 is reachable in
# the shell at 10.90.1.5 (same host offset). DNS name "lan" -> 10.90.1.5.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
[ "$(id -u)" = 0 ] || { echo "run as root"; exit 1; }
NAME="${1:?name}"; OVPN="${2:?client.ovpn path}"; SUBNET="${3:?target subnet e.g. 192.168.2.0/24}"
USER_="${4:-}"; PASS_="${5:-}"
[ -f "$OVPN" ] || { echo "no such file: $OVPN"; exit 1; }
export NETHUB_NAME="rt-$NAME" NETHUB_NET="rt-$NAME-net" NETHUB_IMAGE=net-sidecar:latest
export NETHUB_CONFDIR="/var/lib/rt-$NAME-conf" NETHUB_TSDIR="/var/lib/rt-$NAME-ts"
modprobe xt_nat xt_NETMAP 2>/dev/null || true

cleanup(){ set +e
  docker rm -f "$NETHUB_NAME" $(docker ps -aq --filter "label=nethub=$NETHUB_NAME") >/dev/null 2>&1
  docker network rm "$NETHUB_NET" >/dev/null 2>&1
  rm -rf "$NETHUB_CONFDIR" "$NETHUB_TSDIR"
}
trap cleanup EXIT

echo "building image…"; docker build -q -t net-sidecar:latest "$HERE" >/dev/null
creds=""; [ -n "$USER_" ] && creds="$USER_
$PASS_"
STATE=$(jq -nc --rawfile ovpn "$OVPN" --arg sub "$SUBNET" --arg creds "$creds" '{
  tunnels:[{id:"t1",type:"openvpn",name:"'"$NAME"'",enabled:true,
            remaps:[{real:$sub,fake:"10.90.1.0/24"}],ovpn:$ovpn,creds:$creds}],
  dnsHosts:[] }')
echo "bringing up the tunnel…"
echo "$STATE" | "$HERE/net-apply.sh" apply | jq .
for _ in $(seq 1 40); do
  up=$("$HERE/net-apply.sh" status | jq -r '.tunnels[]|select(.id=="t1")|.up' 2>/dev/null)
  [ "$up" = true ] && break; sleep 0.5
done
[ "$up" = true ] || { echo "tunnel did not come up; log:"; docker exec "$NETHUB_NAME-t-t1" tail -25 /run/nethub/t1.log 2>/dev/null || docker logs "$NETHUB_NAME-t-t1" 2>&1 | tail; exit 1; }

echo
echo "TUNNEL UP. $SUBNET is reachable at 10.90.1.0/24 (host X.Y -> 10.90.1.Y)."
echo "You are now in a shell joined to the tunnel. Try:  curl 10.90.1.<host>   ssh user@10.90.1.<host>   ping 10.90.1.<host>"
echo "Exit the shell to tear everything down."
docker run -it --rm --network "container:$NETHUB_NAME" --entrypoint sh net-sidecar:latest || true
