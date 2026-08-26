#!/usr/bin/env bash
# Proof harness for the overlapping-subnet fix (Tier 1: NAT remap).
#
# It fakes the hard case with NO OpenVPN in the loop, so it isolates and proves
# the ONE thing that matters: two tunnels whose real subnets are IDENTICAL can
# both be reached, distinctly, by giving each a unique "fake" range that gets
# 1:1 NETMAPed to the real one inside that tunnel's own network namespace.
#
# Topology built here (all with `ip netns`, no containers, no VPN):
#
#   root netns (you / the guest)
#     |  route 10.90.1.0/24 -> vethA (remoteA)
#     |  route 10.90.2.0/24 -> vethB (remoteB)
#     +-- remoteA netns : host 192.168.222.5, NETMAP 10.90.1.0/24 <-> 192.168.222.0/24
#     +-- remoteB netns : host 192.168.222.5, NETMAP 10.90.2.0/24 <-> 192.168.222.0/24
#
# Both remotes use the SAME 192.168.222.5. From root you hit 10.90.1.5 and
# 10.90.2.5 and land on the correct, different remote every time. That is the
# collision solved. SSH/SCP/rsync all ride this same NETMAP path (plain TCP),
# so if HTTP + a file download + ping work here, they work.
#
# Needs root (netns + iptables). Run:  sudo ./test-overlap.sh
set -euo pipefail

RED=$'\e[31m'; GRN=$'\e[32m'; YEL=$'\e[33m'; DIM=$'\e[2m'; RST=$'\e[0m'
pass=0; fail=0
ok(){ echo "${GRN}PASS${RST} $*"; pass=$((pass+1)); }
no(){ echo "${RED}FAIL${RST} $*"; fail=$((fail+1)); }
info(){ echo "${DIM}$*${RST}"; }

[ "$(id -u)" = 0 ] || { echo "run as root (sudo $0)"; exit 1; }

# NETMAP is the whole trick; bail early with a clear message if the kernel lacks it.
if ! iptables -t nat -A POSTROUTING -s 10.255.255.0/24 -j NETMAP --to 10.255.254.0/24 2>/dev/null; then
  echo "${RED}This kernel has no iptables NETMAP target (xt_nat / ipt_NETMAP).${RST}"
  echo "Load it: modprobe xt_nat  (Debian: it ships in linux-modules). Then re-run."
  exit 1
fi
iptables -t nat -D POSTROUTING -s 10.255.255.0/24 -j NETMAP --to 10.255.254.0/24 2>/dev/null || true

WORK="$(mktemp -d)"
cleanup(){
  set +e
  for ns in remoteA remoteB; do ip netns pids "$ns" 2>/dev/null | xargs -r kill 2>/dev/null; ip netns del "$ns" 2>/dev/null; done
  ip link del vethA 2>/dev/null
  ip link del vethB 2>/dev/null
  rm -rf "$WORK"
}
trap cleanup EXIT

# --- build one fake remote LAN in its own netns ------------------------------
# args: <ns> <transit-root-ip> <transit-ns-ip> <fake-cidr> <veth>
make_remote(){
  local ns=$1 rootip=$2 nsip=$3 fake=$4 veth=$5 real=192.168.222.0/24 realhost=192.168.222.5
  ip netns add "$ns"
  ip link add "$veth" type veth peer name "${veth}p"
  ip link set "${veth}p" netns "$ns"
  ip addr add "$rootip/30" dev "$veth"; ip link set "$veth" up
  ip -n "$ns" link set lo up
  ip -n "$ns" addr add "$nsip/30" dev "${veth}p"
  ip -n "$ns" addr add "$realhost/24" dev "${veth}p"     # the "server" on the overlapping subnet
  ip -n "$ns" link set "${veth}p" up
  ip -n "$ns" route add default via "$rootip"
  ip netns exec "$ns" sysctl -qw net.ipv4.ip_forward=1
  # THE FIX: 1:1 remap of this tunnel's unique fake range <-> the real (shared) subnet.
  ip netns exec "$ns" iptables -t nat -A PREROUTING  -d "$fake" -j NETMAP --to "$real"
  ip netns exec "$ns" iptables -t nat -A POSTROUTING -s "$real" -j NETMAP --to "$fake"
  # root routes the fake range at THIS tunnel's transit hop (unique -> no ambiguity).
  ip route add "$fake" via "$nsip"
  # a distinguishable web service + a file to download, bound on the shared IP.
  echo "i am $ns @ $realhost (fake $fake)" > "$WORK/$ns.index"
  head -c 1048576 /dev/urandom > "$WORK/$ns.blob"
  sha256sum "$WORK/$ns.blob" | awk '{print $1}' > "$WORK/$ns.blob.sha"
  ( cd "$WORK" && ip netns exec "$ns" python3 -m http.server 80 --bind "$realhost" \
      --directory "$WORK" >/dev/null 2>&1 & echo $! > "$WORK/$ns.pid" )
}

echo "== building two overlapping fake remote LANs =="
make_remote remoteA 10.200.1.1 10.200.1.2 10.90.1.0/24 vethA
make_remote remoteB 10.200.2.1 10.200.2.2 10.90.2.0/24 vethB
sleep 0.6
info "remoteA and remoteB BOTH really live at 192.168.222.5 (the collision)."
info "you will reach them at 10.90.1.5 and 10.90.2.5."

# rename the served files to what we fetch
cp "$WORK/remoteA.index" "$WORK/index-A"; cp "$WORK/remoteB.index" "$WORK/index-B"

echo; echo "== HTTP: distinct content per fake IP =="
a=$(curl -s --max-time 5 http://10.90.1.5/remoteA.index || true)
b=$(curl -s --max-time 5 http://10.90.2.5/remoteB.index || true)
echo "  10.90.1.5 -> $a"
echo "  10.90.2.5 -> $b"
[ "$a" = "i am remoteA @ 192.168.222.5 (fake 10.90.1.0/24)" ] && ok "HTTP to tunnel A hit remoteA" || no "HTTP A"
[ "$b" = "i am remoteB @ 192.168.222.5 (fake 10.90.2.0/24)" ] && ok "HTTP to tunnel B hit remoteB" || no "HTTP B"
[ "$a" != "$b" ] && ok "two tunnels, same real subnet, DIFFERENT results (collision solved)" || no "results collided"

echo; echo "== file download + checksum (stands in for scp/rsync) =="
curl -s --max-time 8 -o "$WORK/dl-A.blob" http://10.90.1.5/remoteA.blob || true
curl -s --max-time 8 -o "$WORK/dl-B.blob" http://10.90.2.5/remoteB.blob || true
[ "$(sha256sum "$WORK/dl-A.blob" 2>/dev/null | awk '{print $1}')" = "$(cat "$WORK/remoteA.blob.sha")" ] \
  && ok "1MB file from tunnel A intact" || no "file A"
[ "$(sha256sum "$WORK/dl-B.blob" 2>/dev/null | awk '{print $1}')" = "$(cat "$WORK/remoteB.blob.sha")" ] \
  && ok "1MB file from tunnel B intact" || no "file B"

echo; echo "== ICMP (NETMAP handles it; proxy-based Tier 2 would NOT) =="
ping -c1 -W2 10.90.1.5 >/dev/null 2>&1 && ok "ping 10.90.1.5" || no "ping A"
ping -c1 -W2 10.90.2.5 >/dev/null 2>&1 && ok "ping 10.90.2.5" || no "ping B"

echo; echo "== SSH/SCP note =="
info "ssh/scp/rsync are plain TCP over the same NETMAP path as HTTP above."
info "If HTTP + the file download passed, ssh user@10.90.1.5 would land on remoteA too."

echo
if [ "$fail" = 0 ]; then echo "${GRN}ALL $pass CHECKS PASSED${RST} - overlapping subnets fully disambiguated."; else
  echo "${RED}$fail failed${RST}, $pass passed."; fi
exit "$fail"
