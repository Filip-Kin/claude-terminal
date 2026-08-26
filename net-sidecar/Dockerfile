# net-sidecar: one image, two roles (NETHUB_ROLE=hub|tunnel). Each container needs
# only --cap-add NET_ADMIN + --device /dev/net/tun (NO SYS_ADMIN, NO privileged):
# docker owns each netns, so we never create one in-container. This is the same
# capability michel's existing per-guest VPN sidecar already runs with.
#
# HOST REQUIREMENT: the docker host kernel must have xt_nat + xt_NETMAP loaded
# (see modules-load.d-net-sidecar.conf). NETMAP is the overlap fix.
#
# Tunnel containers also need --sysctl net.ipv4.ip_forward=1 (docker sets it; the
# in-container /proc/sys is read-only otherwise). The apply-helper passes it.
FROM alpine:3.20

RUN apk add --no-cache \
      bash jq iproute2 iptables ip6tables \
      openvpn dnsmasq \
      curl ca-certificates bind-tools python3 \
    && rm -rf /var/cache/apk/*

# Tailscale from the official static binary (Alpine's package lags badly and trips the
# in-app "known security vulnerability, update to X" warning). Pinned + easy to bump.
ARG TAILSCALE_VERSION=1.102.2
ARG TARGETARCH=amd64
RUN curl -fsSL "https://pkgs.tailscale.com/stable/tailscale_${TAILSCALE_VERSION}_${TARGETARCH}.tgz" -o /tmp/ts.tgz \
    && tar -xzf /tmp/ts.tgz -C /tmp \
    && mv "/tmp/tailscale_${TAILSCALE_VERSION}_${TARGETARCH}/tailscale" \
          "/tmp/tailscale_${TAILSCALE_VERSION}_${TARGETARCH}/tailscaled" /usr/local/bin/ \
    && rm -rf /tmp/ts.tgz "/tmp/tailscale_${TAILSCALE_VERSION}_${TARGETARCH}" \
    && tailscaled --version

COPY entry.sh hub-entry.sh tunnel-entry.sh ovpn-sanitize.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/entry.sh /usr/local/bin/hub-entry.sh \
             /usr/local/bin/tunnel-entry.sh /usr/local/bin/ovpn-sanitize.sh

VOLUME ["/var/lib/nethub"]
ENTRYPOINT ["/usr/local/bin/entry.sh"]
