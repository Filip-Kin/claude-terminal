# net-sidecar — external networks for claude-terminal

Reach a remote LAN from a terminal container over your own OpenVPN or Tailscale,
with **multiple tunnels at once** and **overlapping subnets handled automatically**.

The container that wants network access joins a hub container's netns
(`--network container:<hub>`) and stays capless. All privilege lives in the
sidecar containers, each of which needs only `--cap-add NET_ADMIN --device
/dev/net/tun` — the same capability a normal OpenVPN client container uses. No
`SYS_ADMIN`, no `--privileged`.

## How overlapping subnets are solved

Two VPNs can both hand out `192.168.2.0/24`. Plain routing cannot reach both — a
routing table can't hold two answers for one destination. So each tunnel gets a
unique **fake** `/24` (allocated from `10.90.0.0/16`) that is 1:1 `NETMAP`ped to
the real subnet inside that tunnel's own container:

```
guest → hub → tunnel-container   dst 10.90.1.5
                 NETMAP 10.90.1.0/24 → 192.168.2.0/24
                 route 192.168.2.0/24 dev tun ; MASQUERADE out tun
```

So `10.90.1.5` reaches tunnel A's `192.168.2.5` and `10.90.2.5` reaches tunnel B's
`192.168.2.5`, at the same time. SSH, HTTP, SCP/rsync and ping all work — it's a
header-level remap, transparent to the app (only payload-embedded-IP protocols like
FTP active mode don't survive, same as any NAT). A small dnsmasq gives friendly
names (`ssh nas` → the fake IP) so nobody memorises `10.90.x.y`.

Tailscale runs in the hub's own netns on real `100.64/10` (tailnet IPs are globally
unique, no remap). You log into **your own** tailnet; the login URL surfaces in the
UI.

## Pieces

| file | role |
|------|------|
| `Dockerfile` | one image, two roles via `NETHUB_ROLE=hub\|tunnel` |
| `entry.sh` | dispatches to hub/tunnel entry |
| `hub-entry.sh` | routes each fake range to its tunnel container, dnsmasq, tailscale |
| `tunnel-entry.sh` | one OpenVPN tunnel + its NAT-remap |
| `ovpn-sanitize.sh` | strips code-exec directives from a user `.ovpn`, forces split-tunnel |
| `net-apply.sh` | **reference apply-helper**: orchestrates the containers from desired-state |
| `test-overlap.sh` | proves the NETMAP remap on the host (no VPN, no docker) |
| `test-integration.sh` | full end-to-end with a real static-key OpenVPN tunnel |
| `modules-load.d-net-sidecar.conf` | host must load `xt_nat` + `xt_NETMAP` |

## Wiring into claude-terminal

Set `"netApplyHelper": "/path/to/net-sidecar/net-apply.sh"` in `config.json`. The
server then exposes owner-gated `/connections*` endpoints and the overlay shows a
Connections button. With the key unset the whole feature is hidden.

The helper manages only the hub + tunnel containers. Recoupling the container that
*joins* the hub (it has to be recreated onto `--network container:<hub>`) is the
caller's job via `NETHUB_ONRECREATE`, because only the caller knows that
container's full run spec.

## Testing

```sh
sudo modprobe xt_nat xt_NETMAP
sudo ./test-overlap.sh        # mechanism only, ~2s
sudo ./test-integration.sh    # real OpenVPN tunnel end-to-end, ~30s
```

## Security notes

- Each sidecar is `NET_ADMIN` only, no host mounts beyond its config, no docker
  socket. A guest driving it can open network connections from an isolated netns —
  roughly what anyone with a laptop can do, and far below a docker-build's blast
  radius.
- User `.ovpn` files are sanitised (`up`/`down`/`route-up`/`script-security`/
  `plugin`/… stripped) before openvpn ever sees them.
- Connection secrets (`.ovpn`, creds) are stored `0600` in the terminal's state dir.
