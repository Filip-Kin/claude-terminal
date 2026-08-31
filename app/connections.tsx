// connections.tsx — the "Connections" panel: everything this chat app connects to or draws on.
//
// Four sections behind one button: MCP servers (the tools the model can call), Skills, Memory,
// and Network tunnels (OpenVPN / Tailscale). The first three live in ./manage; this file owns
// the panel shell and the network section, which is a React port of the vanilla overlay dialog
// (#ct-connmodal in overlay.js).
//
// Self-contained on purpose: it talks to the server directly and injects its own CSS, so wiring
// it up stays one import plus one element in main.tsx. Same tactic as voice.tsx / agents.tsx.
//
// Network endpoints (sidecar, same origin as /app — the router sends BOTH /app* and /_ct/* to
// the same port, /_ct/ stripped; see claude-router targetForPath):
//   GET    /_ct/connections            -> { enabled:false } | { enabled:true, tunnels:[…], status:{…} }
//   POST   /_ct/connections/openvpn    { name, subnets:string[], ovpn, creds }
//   POST   /_ct/connections/tailscale  { name }
//   POST   /_ct/connections/<id>/enable { on:boolean }
//   DELETE /_ct/connections/<id>
//
// Three things in the network section are load-bearing and were learned the hard way:
//
//  1. Mutations are FIRE-AND-FORGET. Applying a change recouples the container onto the
//     network hub, which restarts the terminal AND this sidecar, so the POST's response
//     usually never arrives. Never await one for correctness.
//  2. The 2s poll of GET /connections (list + embedded status) is the source of truth and
//     is what confirms a change actually landed.
//  3. An "Applying…" cover with a blurred backdrop hides the panel from submit until the
//     polled state reflects the change, with a 60s safety timeout — otherwise the list
//     visibly empties out mid-recouple and looks broken.
//
// The PANEL is always available; only the NETWORK SECTION reflects availability. Tunnels need
// the session to be a container that joins the network hub, which is true for sandboxed guest
// sessions and not for a claude-terminal running as a service on the host — in that case the
// section says so plainly instead of rendering an empty or fake-enabled UI.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { McpSection, SkillsSection, MemorySection, injectManageCss } from "./manage";

// #region types (mirrors connections.ts redact() + the apply-helper's status blob)
export type Remap = { real: string; fake: string };

export type ConnTunnel = {
  id: string;
  type: "openvpn" | "tailscale";
  name: string;
  enabled: boolean;
  subnets?: string[];
  remaps?: Remap[];
  hosts?: { name: string; ip: string }[];
  hasConfig?: boolean;
};

// Status comes from the private apply-helper, so treat every field as best-effort.
type StatusTunnel = {
  id: string;
  up?: boolean;
  state?: string;
  ip?: string;
  needsLogin?: boolean;
  loginUrl?: string;
  error?: string;
  remaps?: Remap[];
  detected?: string[];
};

export type ConnState = {
  enabled?: boolean;
  tunnels?: ConnTunnel[];
  status?: { available?: boolean; tunnels?: StatusTunnel[] };
};
// #endregion

// #region sidecar calls
const api = (path: string, opts?: RequestInit) =>
  fetch("/_ct/" + path, { credentials: "same-origin", ...opts });

async function fetchConnections(): Promise<ConnState | null> {
  try {
    const r = await api("connections", { cache: "no-store" });
    if (!r.ok) return null; // 403 for a guest, 404 on an older sidecar
    return (await r.json()) as ConnState;
  } catch {
    return null; // mid-recouple: hold the last good state rather than flashing empty
  }
}

// Fire a mutating request and tolerate a dropped response — the recouple kills us in flight.
// The poll is what tells us whether it worked, so there is nothing useful to await here.
function fireMutation(method: string, path: string, body?: unknown): void {
  void api(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }).catch(() => { /* expected: the sidecar restarts under us */ });
}
// #endregion

// #region availability probe
// "on"      — the server manages tunnels for this session; render the full UI.
// "off"     — reachable, but tunnels are not configured here (the common case on the host).
// "denied"  — this session may not manage tunnels.
// "missing" — no such endpoint, or the sidecar is unreachable.
export type NetAvail = "loading" | "on" | "off" | "denied" | "missing";

// Cached module-wide: several mount points must not each hit the sidecar, and the answer only
// changes on a server restart. Cleared by a manual retry.
let availCache: NetAvail | null = null;
let availInFlight: Promise<NetAvail> | null = null;

async function probeNet(): Promise<NetAvail> {
  let r: Response;
  try { r = await api("connections", { cache: "no-store" }); }
  catch { return "missing"; }
  if (r.status === 401 || r.status === 403) return "denied";
  if (!r.ok) return "missing";
  try {
    const d = (await r.json()) as ConnState;
    return d && d.enabled ? "on" : "off";
  } catch { return "missing"; }
}

function netAvail(force = false): Promise<NetAvail> {
  if (force) { availCache = null; availInFlight = null; }
  if (availCache !== null) return Promise.resolve(availCache);
  if (!availInFlight) {
    availInFlight = probeNet()
      .catch(() => "missing" as NetAvail)
      .then((v) => { availCache = v; return v; })
      .finally(() => { availInFlight = null; });
  }
  return availInFlight;
}

function useNetAvail(active: boolean): [NetAvail, () => void] {
  const [v, setV] = useState<NetAvail>(availCache ?? "loading");
  const load = useCallback((force: boolean) => {
    if (!force && availCache !== null) { setV(availCache); return; }
    if (force) setV("loading");
    void netAvail(force).then(setV);
  }, []);
  useEffect(() => { if (active) load(false); }, [active, load]);
  return [v, () => load(true)];
}

/**
 * True only when the server reports the network feature is enabled. Kept for callers that want
 * to know; the Connections button itself no longer depends on it.
 */
export function useConnectionsEnabled(): boolean {
  const [avail] = useNetAvail(true);
  return avail === "on";
}
// #endregion

// #region status presentation
type Dot = "up" | "down" | "wait" | "unk";

function dotFor(t: ConnTunnel, s: StatusTunnel | undefined): [Dot, string] {
  if (t.type === "tailscale") {
    if (!s) return ["unk", "unknown"];
    if (s.needsLogin) return ["wait", "needs login"];
    if (s.up) return ["up", "connected" + (s.ip ? " · " + s.ip : "")];
    return ["down", s.state || "off"];
  }
  if (t.enabled === false) return ["down", "disabled"];
  if (!s) return ["unk", "unknown"]; // no status row yet (just added, or the helper is mid-apply)
  if (s.up) return ["up", "up"];
  return ["down", s.error || "down"];
}
// #endregion

// #region network section
function NetworkSection({ onApplying }: { onApplying: (msg: string | null) => void }) {
  const [avail, retryAvail] = useNetAvail(true);
  const [data, setData] = useState<ConnState>({ tunnels: [] });
  const [applying, setApplying] = useState<string | null>(null); // cover message, null = idle
  const [form, setForm] = useState<null | "vpn" | "ts">(null);
  const [confirmId, setConfirmId] = useState<string | null>(null); // inline "remove?" confirmation
  const [err, setErr] = useState("");

  // OpenVPN form
  const [vName, setVName] = useState("");
  const [vSubnets, setVSubnets] = useState("");
  const [vOvpn, setVOvpn] = useState("");
  const [vUser, setVUser] = useState("");
  const [vPass, setVPass] = useState("");
  // Tailscale form
  const [tName, setTName] = useState("");

  // The pending change: a predicate over freshly polled state that says "it landed".
  const pending = useRef<{ check: (d: ConnState) => boolean; started: number } | null>(null);

  const clearApply = useCallback(() => { pending.current = null; setApplying(null); }, []);

  // The panel shell owns the cover (it must sit over the tabs and the close button too), so
  // mirror the message up. Also release it if this section ever unmounts mid-apply.
  useEffect(() => { onApplying(applying); }, [applying, onApplying]);
  useEffect(() => () => onApplying(null), [onApplying]);

  // A change (add / toggle / remove) recouples the guest onto the network hub, restarting the
  // terminal and this sidecar. Cover the panel and hold it until the POLLED state reflects the
  // change, or until the safety timeout.
  const beginApply = useCallback((m: string, check: (d: ConnState) => boolean) => {
    pending.current = { check, started: Date.now() };
    setApplying(m);
    setErr("");
  }, []);

  // Safety timeout: independent of the poll, so a sidecar that never comes back still
  // releases the panel instead of spinning forever.
  useEffect(() => {
    if (!applying) return;
    const t = setTimeout(clearApply, 60000);
    return () => clearTimeout(t);
  }, [applying, clearApply]);

  // Live refresh. Failures (mid-reconnect) are ignored so the cover holds instead of
  // flashing an empty list.
  useEffect(() => {
    if (avail !== "on") return;
    let live = true;
    const tick = async () => {
      const d = await fetchConnections();
      if (!live || !d || !d.enabled) return;
      setData(d);
      const p = pending.current;
      if (p && (p.check(d) || Date.now() - p.started > 60000)) { pending.current = null; setApplying(null); }
    };
    void tick();
    const id = setInterval(() => { void tick(); }, 2000);
    return () => { live = false; clearInterval(id); };
  }, [avail]);

  if (avail === "loading") return <p className="cx-note">Checking…</p>;

  if (avail !== "on") {
    return (
      <>
        <p className="cx-note">
          A network tunnel lets a Claude session reach a remote LAN over your own OpenVPN config or
          your Tailscale account, with overlapping subnets remapped to a free local range.
        </p>
        {avail === "off" ? (
          <p className="cx-note">
            Not configured on this server. Tunnels attach a session's container to a network hub, so
            they are available to sandboxed guest sessions. This Claude runs as a service directly on
            the host, so there is no container to attach.
          </p>
        ) : avail === "denied" ? (
          <p className="cx-note">This session is not allowed to manage network tunnels.</p>
        ) : (
          <p className="cx-note">The tunnel service is not reachable from here.</p>
        )}
        <div className="cx-add-row">
          <button className="cx-btn" onClick={retryAvail}>Check again</button>
        </div>
      </>
    );
  }

  const tunnels = data.tunnels || [];
  const statusById: Record<string, StatusTunnel> = {};
  for (const s of data.status?.tunnels || []) statusById[s.id] = s;

  const resetVpnForm = () => { setVName(""); setVSubnets(""); setVOvpn(""); setVUser(""); setVPass(""); };

  const addVpn = () => {
    if (!vOvpn.trim()) { setErr("Paste or load a .ovpn config first."); return; }
    const name = vName.trim();
    const subnets = vSubnets.split(",").map((s) => s.trim()).filter(Boolean);
    const user = vUser.trim();
    const creds = user ? user + "\n" + vPass : "";
    const ovpn = vOvpn;
    const pre = tunnels.length;
    setForm(null); resetVpnForm();
    beginApply("Connecting " + (name || "VPN") + "… the terminal will reconnect.", (d) => (d.tunnels || []).length > pre);
    fireMutation("POST", "connections/openvpn", { name, subnets, ovpn, creds });
  };

  const addTs = () => {
    const name = tName.trim();
    const pre = tunnels.length;
    setForm(null); setTName("");
    beginApply("Starting Tailscale… a login link will appear once it's up.", (d) => (d.tunnels || []).length > pre);
    fireMutation("POST", "connections/tailscale", { name });
  };

  const toggle = (t: ConnTunnel) => {
    beginApply("Updating " + t.name + "…", (d) => {
      const x = (d.tunnels || []).find((y) => y.id === t.id);
      return !!x && x.enabled === !t.enabled;
    });
    fireMutation("POST", "connections/" + t.id + "/enable", { on: !t.enabled });
  };

  const remove = (t: ConnTunnel) => {
    setConfirmId(null);
    beginApply("Removing " + t.name + "…", (d) => !(d.tunnels || []).some((y) => y.id === t.id));
    fireMutation("DELETE", "connections/" + t.id);
  };

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => setVOvpn(String(rd.result || ""));
    rd.readAsText(f);
    e.target.value = ""; // let the same file be picked twice
  };

  return (
    <>
      <p className="cx-note">
        Reach a remote LAN over your own VPN or Tailscale. Overlapping subnets get a unique local range automatically.
      </p>

      {tunnels.length === 0 ? (
        <p className="cx-note">No connections yet. Add an OpenVPN config or connect Tailscale below.</p>
      ) : (
        tunnels.map((t) => {
          const s = statusById[t.id];
          const [dot, label] = dotFor(t, s);
          const remaps = (s?.remaps?.length ? s.remaps : t.remaps) || [];
          return (
            <div className="cx-tun" key={t.id}>
              <div className="cx-tun-top">
                <span className={"cx-dot cx-" + dot} title={label} />
                <span className="cx-tun-name">{t.name}</span>
                <span className="cx-badge">{t.type}</span>
                <span className="cx-tun-state">{label}</span>
                <span className="cx-tun-acts">
                  {t.type === "openvpn" && (
                    <button className="cx-ic" onClick={() => toggle(t)}>{t.enabled ? "disable" : "enable"}</button>
                  )}
                  {confirmId === t.id ? (
                    <>
                      <button className="cx-ic cx-danger" onClick={() => remove(t)}>remove</button>
                      <button className="cx-ic" onClick={() => setConfirmId(null)}>cancel</button>
                    </>
                  ) : (
                    <button className="cx-ic cx-ic-x" title="Remove" aria-label={"Remove " + t.name} onClick={() => setConfirmId(t.id)}>×</button>
                  )}
                </span>
              </div>

              {s?.needsLogin && s.loginUrl ? (
                <a className="cx-login" href={s.loginUrl} target="_blank" rel="noopener noreferrer">Log in to Tailscale ↗</a>
              ) : t.type === "openvpn" ? (
                remaps.length ? (
                  <div className="cx-tun-sub">
                    reach via {remaps.map((r, i) => (
                      <React.Fragment key={r.fake + i}>{i > 0 && ", "}<code>{r.fake}</code> → {r.real}</React.Fragment>
                    ))}
                  </div>
                ) : s?.detected?.length ? (
                  <div className="cx-tun-sub">detected {s.detected.join(", ")} — mapping…</div>
                ) : s?.up ? (
                  <div className="cx-tun-sub">up — detecting reachable subnets…</div>
                ) : null
              ) : null}
            </div>
          );
        })
      )}

      {err && <div className="cx-err">{err}</div>}

      <div className="cx-add-row">
        <button className={"cx-btn" + (form === "vpn" ? " cx-on" : "")} onClick={() => setForm(form === "vpn" ? null : "vpn")}>+ OpenVPN</button>
        <button className={"cx-btn" + (form === "ts" ? " cx-on" : "")} onClick={() => setForm(form === "ts" ? null : "ts")}>+ Tailscale</button>
      </div>

      {form === "vpn" && (
        <div className="cx-form">
          <label className="cx-label" htmlFor="cx-vname">Name</label>
          <input id="cx-vname" className="cx-in" value={vName} onChange={(e) => setVName(e.target.value)} placeholder="work vpn" />

          <label className="cx-label" htmlFor="cx-vsub">Target subnet(s) to reach — comma separated, or leave blank to auto-detect</label>
          <input id="cx-vsub" className="cx-in" value={vSubnets} onChange={(e) => setVSubnets(e.target.value)}
            placeholder="auto-detect (or e.g. 192.168.2.0/24, 10.10.0.0/24)" />

          <label className="cx-label" htmlFor="cx-vovpn">.ovpn config (paste, or load a file)</label>
          <input className="cx-in cx-file" type="file" accept=".ovpn,.conf,text/plain" onChange={onFile} />
          <textarea id="cx-vovpn" className="cx-in cx-ta" value={vOvpn} onChange={(e) => setVOvpn(e.target.value)}
            placeholder={"dev tun\nremote vpn.example.com 1194\n…"} />

          <label className="cx-label" htmlFor="cx-vuser">Username (if the VPN needs one)</label>
          <input id="cx-vuser" className="cx-in" value={vUser} onChange={(e) => setVUser(e.target.value)} placeholder="optional" autoComplete="off" />

          <label className="cx-label" htmlFor="cx-vpass">Password</label>
          <input id="cx-vpass" className="cx-in" type="password" value={vPass} onChange={(e) => setVPass(e.target.value)} placeholder="optional" autoComplete="new-password" />

          <button className="cx-btn cx-primary" onClick={addVpn}>Add &amp; connect</button>
        </div>
      )}

      {form === "ts" && (
        <div className="cx-form">
          <label className="cx-label" htmlFor="cx-tsname">Name for this Claude sandbox on YOUR Tailscale</label>
          <input id="cx-tsname" className="cx-in" value={tName} onChange={(e) => setTName(e.target.value)} placeholder="claude-sandbox" />
          <div className="cx-tun-sub">
            This names the Claude server as a device in your own Tailscale account (it appears as <code>ct-&lt;name&gt;</code>).
            It is not one of your existing devices — you are adding this sandbox to your tailnet.
          </div>
          <button className="cx-btn cx-primary" onClick={addTs}>Connect Tailscale</button>
        </div>
      )}
    </>
  );
}
// #endregion

// #region the panel
type Tab = "mcp" | "skills" | "memory" | "network";

const TABS: { id: Tab; label: string }[] = [
  { id: "mcp", label: "MCP" },
  { id: "skills", label: "Skills" },
  { id: "memory", label: "Memory" },
  { id: "network", label: "Network" },
];

// Remembered across opens so reopening lands where you left off.
let lastTab: Tab = "mcp";

export function ConnectionsModal({ open, onClose, activeId = null }: { open: boolean; onClose: () => void; activeId?: string | null }) {
  injectConnCss();
  injectManageCss();

  const [tab, setTab] = useState<Tab>(lastTab);
  const [applying, setApplying] = useState<string | null>(null); // network cover, null = idle
  const applyingRef = useRef(false);
  applyingRef.current = !!applying;

  useEffect(() => { lastTab = tab; }, [tab]);

  // Reset the transient cover each time the panel opens.
  useEffect(() => { if (open) setApplying(null); }, [open]);

  // Escape closes, unless a network change is applying (closing would kill the poll that
  // resolves it).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !applyingRef.current) { e.stopPropagation(); onClose(); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  const onApplying = useCallback((m: string | null) => setApplying(m), []);

  if (!open) return null;

  return (
    <div className="cx-scrim" onClick={() => { if (!applyingRef.current) onClose(); }}>
      <div className="cx-panel" role="dialog" aria-modal="true" aria-label="Connections" onClick={(e) => e.stopPropagation()}>
        <div className="cx-head">
          <span>Connections</span>
          <button className="cx-x" onClick={onClose} disabled={!!applying} aria-label="Close">×</button>
        </div>

        <div className="cx-tabs" role="tablist" aria-label="Connections sections">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              className={"cx-tab" + (tab === t.id ? " cx-on" : "")}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="cx-body" role="tabpanel">
          {tab === "mcp" && <McpSection activeId={activeId} />}
          {tab === "skills" && <SkillsSection activeId={activeId} />}
          {tab === "memory" && <MemorySection />}
          {tab === "network" && <NetworkSection onApplying={onApplying} />}
        </div>

        {applying && (
          <div className="cx-applying">
            <div className="cx-sp" />
            <div className="cx-applying-msg">{applying}</div>
          </div>
        )}
      </div>
    </div>
  );
}
// #endregion

// #region drop-in entry point
/**
 * The whole feature in one element: a button plus the panel it opens. Always rendered — the
 * MCP / Skills / Memory sections are useful everywhere, and only the Network section reflects
 * whether tunnels are configured for this session.
 *
 * `activeId` is the live conversation id, used to show live MCP status and to apply MCP or
 * skill changes to the open chat. Pass null and those actions simply apply to the next chat.
 * `className` borrows an existing button style (e.g. "sb-gear" for the sidebar header).
 */
export function ConnectionsButton({ className = "sb-gear", activeId = null }: { className?: string; activeId?: string | null }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className={className} onClick={() => setOpen(true)} aria-label="Connections" title="Connections (MCP, skills, memory, network)">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="2.6" />
          <circle cx="5" cy="5" r="2" />
          <circle cx="19" cy="5" r="2" />
          <circle cx="12" cy="20" r="2" />
          <path d="M10.2 10.2 6.4 6.4M13.8 10.2l3.8-3.8M12 14.6V18" />
        </svg>
      </button>
      <ConnectionsModal open={open} onClose={() => setOpen(false)} activeId={activeId} />
    </>
  );
}
// #endregion

// #region injected styles (kept out of styles.css so this stays a drop-in module; reuses the app vars)
let cssDone = false;
function injectConnCss() {
  if (cssDone || typeof document === "undefined") return;
  cssDone = true;
  const css = `
  .cx-scrim{position:fixed;inset:0;z-index:80;display:flex;align-items:center;justify-content:center;padding:20px;background:rgba(0,0,0,.55);backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px)}
  .cx-panel{position:relative;width:100%;max-width:620px;max-height:86vh;display:flex;flex-direction:column;background:var(--bg-2,#211c18);color:var(--text,#ece7e1);border:1px solid var(--line,#3a322c);border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.55);overflow:hidden}
  .cx-head{flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 18px;font-size:15px;font-weight:600;border-bottom:1px solid var(--line-2,#2c2621)}
  .cx-x{background:transparent;border:none;color:var(--text-3,#8a8078);font-size:22px;line-height:1;padding:0 4px}
  .cx-x:hover{color:var(--text,#ece7e1)}
  .cx-x:disabled{opacity:.35;cursor:default}

  .cx-tabs{flex:0 0 auto;display:flex;gap:2px;padding:8px 10px;border-bottom:1px solid var(--line-2,#2c2621);overflow-x:auto;scrollbar-width:none}
  .cx-tabs::-webkit-scrollbar{display:none}
  .cx-tab{flex:1 1 0;min-width:76px;min-height:42px;padding:10px 8px;border:none;border-radius:9px;background:transparent;color:var(--text-3,#8a8078);font-size:13.5px;font-weight:500;white-space:nowrap}
  .cx-tab:hover{color:var(--text,#ece7e1);background:var(--bg-3,#2a2420)}
  .cx-tab.cx-on{color:var(--text,#ece7e1);background:var(--bg-3,#2a2420);font-weight:600}

  .cx-body{flex:1 1 auto;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;padding:18px 18px 24px}
  .cx-note{margin:0 0 14px;font-size:12.5px;line-height:1.55;color:var(--text-3,#8a8078)}

  .cx-tun{border:1px solid var(--line-2,#2c2621);border-radius:11px;padding:12px 14px;margin:0 0 10px;background:var(--bg,#1a1613)}
  .cx-tun-top{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .cx-dot{width:9px;height:9px;border-radius:50%;flex:0 0 auto;background:#6b7280}
  .cx-dot.cx-up{background:#10B981}
  .cx-dot.cx-down{background:#EF4444}
  .cx-dot.cx-wait{background:#F59E0B}
  .cx-dot.cx-unk{background:#6b7280}
  .cx-tun-name{font-weight:600;font-size:14px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .cx-badge{flex:0 0 auto;font-size:10px;text-transform:uppercase;letter-spacing:.05em;font-weight:600;padding:2px 7px;border-radius:6px;background:var(--bg-3,#2a2420);color:var(--text-3,#8a8078)}
  .cx-tun-state{font-size:12px;color:var(--text-3,#8a8078);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .cx-tun-acts{margin-left:auto;display:flex;align-items:center;gap:4px;flex:0 0 auto}
  .cx-ic{background:transparent;border:none;color:var(--text-3,#8a8078);font-size:12px;padding:6px 8px;border-radius:7px}
  .cx-ic:hover{color:var(--text,#ece7e1);background:var(--bg-3,#2a2420)}
  .cx-ic-x{font-size:17px;line-height:1}
  .cx-ic.cx-danger{color:#EF4444;font-weight:600}
  .cx-tun-sub{margin-top:8px;font-size:12px;line-height:1.5;color:var(--text-3,#8a8078);word-break:break-word}
  .cx-tun-sub code{font-family:var(--mono,ui-monospace,Menlo,Consolas,monospace);font-size:11.5px;color:var(--text-2,#b8afa5)}
  .cx-login{display:inline-block;margin-top:10px;padding:7px 13px;border-radius:9px;background:var(--accent,#d97757);color:#fff;text-decoration:none;font-size:13px;font-weight:600}
  .cx-err{margin:0 0 12px;font-size:12.5px;color:#EF4444}

  .cx-add-row{display:flex;gap:10px;margin:16px 0 0}
  .cx-btn{padding:9px 14px;border-radius:10px;border:1px solid var(--line,#3a322c);background:var(--bg-3,#2a2420);color:var(--text,#ece7e1);font-size:13.5px;font-weight:500}
  .cx-btn:hover{border-color:var(--text-3,#8a8078)}
  .cx-btn.cx-on{border-color:var(--accent,#d97757);color:var(--accent,#d97757)}
  .cx-btn.cx-primary{margin-top:16px;background:var(--accent,#d97757);border-color:var(--accent,#d97757);color:#fff;font-weight:600}
  .cx-btn.cx-primary:hover{filter:brightness(1.06)}

  .cx-form{margin-top:14px;border:1px dashed var(--line,#3a322c);border-radius:11px;padding:14px 16px 16px}
  .cx-label{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--text-3,#8a8078);margin:14px 0 5px;font-weight:600}
  .cx-form .cx-label:first-child{margin-top:0}
  .cx-in{width:100%;padding:9px 11px;border-radius:9px;border:1px solid var(--line,#3a322c);background:var(--panel,#17130f);color:var(--text,#ece7e1);font-family:var(--mono,ui-monospace,Menlo,Consolas,monospace);font-size:12.5px;outline:none}
  .cx-in:focus{border-color:var(--accent,#d97757)}
  .cx-in::placeholder{color:var(--text-3,#8a8078)}
  .cx-file{font-family:var(--font,system-ui);padding:7px 9px;margin-bottom:8px}
  .cx-ta{resize:vertical;min-height:110px;line-height:1.45}

  .cx-applying{position:absolute;inset:0;z-index:2;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:24px;text-align:center;background:color-mix(in srgb,var(--bg-2,#211c18) 88%,transparent);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px)}
  .cx-sp{width:34px;height:34px;border-radius:50%;border:3px solid var(--line,#3a322c);border-top-color:var(--accent,#d97757);animation:cx-spin .8s linear infinite}
  .cx-applying-msg{max-width:34ch;font-size:13px;line-height:1.55;color:var(--text-2,#b8afa5)}
  @keyframes cx-spin{to{transform:rotate(360deg)}}
  @media (prefers-reduced-motion:reduce){.cx-sp{animation-duration:2.4s}}

  /* full-screen sheet on phones (this is an installed PWA) */
  @media (max-width:620px){
    .cx-scrim{padding:0;align-items:stretch}
    .cx-panel{max-width:none;max-height:none;height:100%;border:0;border-radius:0}
    .cx-body{padding-bottom:calc(24px + env(safe-area-inset-bottom))}
    .cx-head{padding-top:calc(14px + env(safe-area-inset-top))}
  }
  `;
  const el = document.createElement("style");
  el.id = "connections-css";
  el.textContent = css;
  document.head.appendChild(el);
}
// #endregion
