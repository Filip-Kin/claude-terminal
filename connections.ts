// External network connections (OpenVPN + Tailscale) for the terminal.
//
// This module owns the USERSPACE half: it stores the connection list + secrets,
// allocates a unique "fake" /24 per remapped subnet (so overlapping tunnels never
// collide - see net-sidecar/test-overlap.sh), and shells out to a configured
// apply-helper that does the privileged, host-specific work (build/recreate the
// net-sidecar container, sanitise the .ovpn, recouple the joining container).
//
// The feature is INERT unless cfg.netApplyHelper is set: a vanilla single-user
// install simply never shows the Connections UI. Filip's box points it at the
// guest-claude net-apply helper; that stays private and out of this repo.
import { join } from "node:path";
import { existsSync } from "node:fs";
import { chmod, rename } from "node:fs/promises";

export type Remap = { real: string; fake: string };
export type DnsHost = { name: string; ip: string };
export type Tunnel = {
  id: string;
  type: "openvpn" | "tailscale";
  name: string;
  enabled: boolean;
  subnets?: string[];        // openvpn: real subnets the user wants to reach
  remaps?: Remap[];          // allocated real<->fake pairs
  ovpn?: string;             // openvpn: raw config text (secret)
  creds?: string;            // openvpn: "user\npass" (secret)
  hosts?: DnsHost[];         // friendly name -> fake IP (dnsmasq)
};
export type ConnConfig = { tunnels: Tunnel[] };

const FAKE_BASE = "10.90"; // fake pool 10.90.0.0/16; .0.x reserved for the resolver

export class Connections {
  private path: string;
  private helper: string | null;

  constructor(stateDir: string, helper: string | undefined | null) {
    this.path = join(stateDir, "claude-terminal-connections.json");
    this.helper = helper || null;
  }
  enabled(): boolean { return !!this.helper; }

  async load(): Promise<ConnConfig> {
    if (!existsSync(this.path)) return { tunnels: [] };
    try { return JSON.parse(await Bun.file(this.path).text()); }
    catch { return { tunnels: [] }; }
  }
  private async save(c: ConnConfig): Promise<void> {
    const tmp = this.path + ".tmp";
    await Bun.write(tmp, JSON.stringify(c, null, 2) + "\n");
    await rename(tmp, this.path);
    await chmod(this.path, 0o600); // holds ovpn creds -> owner-only, like the vapid file
  }

  // lowest free 10.90.k.0/24, skipping k=0 (resolver) and anything already used.
  private allocFake(used: Set<string>): string {
    for (let k = 1; k < 256; k++) {
      const cidr = `${FAKE_BASE}.${k}.0/24`;
      if (!used.has(cidr)) { used.add(cidr); return cidr; }
    }
    throw new Error("fake-range pool exhausted (10.90.0.0/16)");
  }
  private usedFakes(c: ConnConfig): Set<string> {
    const s = new Set<string>();
    for (const t of c.tunnels) for (const r of t.remaps || []) s.add(r.fake);
    return s;
  }

  // Public-facing view: secrets stripped, remaps + status-relevant fields kept.
  redact(c: ConnConfig): any {
    return {
      tunnels: c.tunnels.map((t) => ({
        id: t.id, type: t.type, name: t.name, enabled: t.enabled,
        subnets: t.subnets || [], remaps: t.remaps || [], hosts: t.hosts || [],
        hasConfig: !!t.ovpn,
      })),
    };
  }

  async list(): Promise<any> {
    const c = await this.load();
    return { ...this.redact(c), status: await this.status() };
  }

  async addOpenvpn(input: { name: string; ovpn: string; creds?: string; subnets: string[]; hosts?: DnsHost[] }): Promise<any> {
    if (!input.ovpn?.trim()) throw new Error("missing .ovpn config");
    const subnets = input.subnets || [];
    for (const s of subnets) if (!isCidr(s)) throw new Error(`bad subnet: ${s}`);
    const c = await this.load();
    const used = this.usedFakes(c);
    // subnets given -> allocate a fake /24 each now; none given -> AUTO: the tunnel
    // container detects the server-pushed routes at connect time and maps them itself.
    const remaps: Remap[] = subnets.map((real) => ({ real, fake: this.allocFake(used) }));
    const t: Tunnel = {
      id: "t_" + rand(), type: "openvpn", name: input.name || "vpn", enabled: true,
      subnets, remaps, ovpn: input.ovpn, creds: input.creds || "",
      hosts: (input.hosts || []).filter((h) => h.name && h.ip),
    };
    c.tunnels.push(t);
    await this.save(c);
    return this.apply(c);
  }

  async addTailscale(input: { name: string }): Promise<any> {
    const c = await this.load();
    c.tunnels.push({ id: "t_" + rand(), type: "tailscale", name: input.name || "tailscale", enabled: true });
    await this.save(c);
    return this.apply(c);
  }

  async setEnabled(id: string, on: boolean): Promise<any> {
    const c = await this.load();
    const t = c.tunnels.find((x) => x.id === id);
    if (!t) throw new Error("no such tunnel");
    t.enabled = on;
    await this.save(c);
    return this.apply(c);
  }

  async remove(id: string): Promise<any> {
    const c = await this.load();
    c.tunnels = c.tunnels.filter((x) => x.id !== id);
    await this.save(c);
    return this.apply(c);
  }

  // Build the desired-state the sidecar understands and hand it to the helper.
  private desiredState(c: ConnConfig): any {
    const dnsHosts: DnsHost[] = [];
    for (const t of c.tunnels) for (const h of t.hosts || []) dnsHosts.push(h);
    return {
      tunnels: c.tunnels.map((t) =>
        t.type === "openvpn"
          ? { id: t.id, type: "openvpn", name: t.name, enabled: t.enabled, remaps: t.remaps || [], ovpn: t.ovpn, creds: t.creds || "" }
          : { id: t.id, type: "tailscale", name: t.name, enabled: t.enabled }),
      dnsHosts,
    };
  }

  private async runHelper(cmd: string, stdin?: string): Promise<{ out: string; err: string; code: number }> {
    if (!this.helper) throw new Error("network connections are not enabled on this install");
    const proc = Bun.spawn([this.helper, cmd], { stdin: stdin != null ? "pipe" : "ignore", stdout: "pipe", stderr: "pipe" });
    if (stdin != null && proc.stdin) { proc.stdin.write(stdin); await proc.stdin.end(); }
    const out = (await new Response(proc.stdout).text()).trim();
    const err = (await new Response(proc.stderr).text()).trim();
    const code = await proc.exited;
    return { out, err, code };
  }

  async apply(c?: ConnConfig): Promise<any> {
    const cfg = c || (await this.load());
    const { out, err, code } = await this.runHelper("apply", JSON.stringify(this.desiredState(cfg)));
    if (code !== 0) throw new Error(err || `apply-helper exited ${code}`);
    let status: any = null;
    try { status = JSON.parse(out); } catch { /* helper may print status separately */ }
    return { ...this.redact(cfg), status: status || (await this.status()) };
  }

  async status(): Promise<any> {
    if (!this.helper) return { available: false };
    try {
      const { out, code } = await this.runHelper("status");
      if (code !== 0) return { available: true, tunnels: [] };
      return JSON.parse(out || '{"tunnels":[]}');
    } catch { return { available: true, tunnels: [] }; }
  }
}

function rand(): string { return Math.random().toString(36).slice(2, 10); }
function isCidr(s: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(s.trim());
  if (!m) return false;
  const oct = m.slice(1, 5).map(Number);
  return oct.every((o) => o >= 0 && o <= 255) && Number(m[5]) >= 0 && Number(m[5]) <= 32;
}
