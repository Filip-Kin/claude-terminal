#!/usr/bin/env bash
# Full end-to-end test with a REAL OpenVPN tunnel (self-contained static-key, no
# external creds). Exercises net-apply.sh (the orchestrator) + the hub + a tunnel
# container, then joins a client to the hub and reaches the remote LAN via the fake
# range. Every container uses only NET_ADMIN (no SYS_ADMIN / privileged).
#
# Needs root + docker + xt_NETMAP on the host.  Run:  sudo ./test-integration.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
IMG=net-sidecar:latest
export NETHUB_NAME=nhtest NETHUB_NET=nhtest-net NETHUB_IMAGE=$IMG
SRV=nhtest-server CLI=nhtest-client
WORK="$(mktemp -d)"
export NETHUB_CONFDIR="$WORK/conf" NETHUB_TSDIR="$WORK/ts"
RED=$'\e[31m'; GRN=$'\e[32m'; RST=$'\e[0m'; FAILED=0
ok(){ echo "${GRN}PASS${RST} $*"; }; no(){ echo "${RED}FAIL${RST} $*"; FAILED=1; }
cleanup(){ set +e
  docker rm -f "$CLI" nhtest $(docker ps -aq --filter "label=nethub=nhtest") "$SRV" >/dev/null 2>&1
  docker network rm "$NETHUB_NET" >/dev/null 2>&1; rm -rf "$WORK"; }
trap cleanup EXIT
[ "$(id -u)" = 0 ] || { echo "run as root"; exit 1; }
modprobe xt_nat xt_NETMAP 2>/dev/null || true

echo "== build =="; docker build -q -t "$IMG" "$HERE" >/dev/null && ok "image built" || { no build; exit 1; }
docker network create "$NETHUB_NET" >/dev/null 2>&1 || true

echo "== OpenVPN server + fake LAN (192.168.222.5) =="
docker run -d --name "$SRV" --network "$NETHUB_NET" --cap-add NET_ADMIN --device /dev/net/tun \
  --entrypoint sh "$IMG" -c '
    set -e; openvpn --genkey secret /static.key
    ip link add lan type dummy; ip addr add 192.168.222.5/24 dev lan; ip link set lan up
    mkdir -p /www; echo "hello from behind the VPN (192.168.222.5)" > /www/index.html
    (cd /www && python3 -m http.server 80 --bind 192.168.222.5 &)
    exec openvpn --dev tun --proto udp --port 1194 --ifconfig 10.8.0.1 10.8.0.2 \
      --secret /static.key --cipher AES-256-CBC --auth SHA256 --verb 3' >/dev/null
sleep 3
SRVIP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$SRV")
[ -n "$SRVIP" ] && ok "server at $SRVIP" || { no "server ip"; exit 1; }
docker exec "$SRV" cat /static.key > "$WORK/static.key"

# client .ovpn with inline static key
{ echo "dev tun"; echo "proto udp"; echo "remote $SRVIP 1194"; echo nobind
  echo "ifconfig 10.8.0.2 10.8.0.1"; echo "cipher AES-256-CBC"; echo "auth SHA256"; echo "verb 3"
  echo "<secret>"; cat "$WORK/static.key"; echo "</secret>"; } > "$WORK/client.ovpn"

echo "== net-apply apply (orchestrate hub + tunnel) =="
STATE=$(jq -nc --rawfile ovpn "$WORK/client.ovpn" '{
  tunnels:[{id:"t1",type:"openvpn",name:"testvpn",enabled:true,
            remaps:[{real:"192.168.222.0/24",fake:"10.90.1.0/24"}],ovpn:$ovpn,creds:""}],
  dnsHosts:[{name:"lan",ip:"10.90.1.5"}] }')
echo "$STATE" | "$HERE/net-apply.sh" apply >/dev/null || no "apply exited nonzero"
for _ in $(seq 1 40); do
  up=$("$HERE/net-apply.sh" status | jq -r '.tunnels[]|select(.id=="t1")|.up' 2>/dev/null)
  [ "$up" = true ] && break; sleep 0.5
done
"$HERE/net-apply.sh" status | jq . || true
[ "$up" = true ] && ok "openvpn tunnel up + remap applied" || no "tunnel did not come up"

echo "== client joins the hub, reaches the LAN via the fake range =="
out=$(docker run --rm --name "$CLI" --network "container:nhtest" --entrypoint sh "$IMG" \
        -c 'curl -s --max-time 6 http://10.90.1.5/; echo; ping -c1 -W2 10.90.1.5 >/dev/null 2>&1 && echo PINGOK' 2>&1)
echo "  client saw: $out"
echo "$out" | grep -q "hello from behind the VPN" && ok "HTTP to 10.90.1.5 reached the VPN LAN" || no "HTTP over the tunnel"
echo "$out" | grep -q PINGOK && ok "ping over the tunnel" || no ping
echo; [ "$FAILED" = 0 ] && echo "${GRN}INTEGRATION OK${RST}" || echo "${RED}integration FAILED${RST}"; exit "$FAILED"
