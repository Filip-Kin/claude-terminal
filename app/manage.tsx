// manage.tsx — the MCP / Skills / Memory sections of the Connections panel.
//
// Split out of connections.tsx so each file stays readable: connections.tsx owns the panel
// shell + the network-tunnel section, this file owns the three sections that talk to the
// /app/api/* routes. Self-contained in the same way: own fetch helpers, own injected CSS
// (ms-* namespace, app CSS vars only), no edits to styles.css.
//
// Routes used (all owner-gated by the app server):
//   GET  /app/api/mcp[?id=<session>]  -> { servers:{name:cfg}, status:[…], live:boolean }
//   POST /app/api/mcp                 { name, config, applyTo? }
//   POST /app/api/mcp/delete          { name, applyTo? }
//   POST /app/api/mcp/apply           { id }
//   GET  /app/api/memory              -> { projects:[{id,label,files:[{name,path,size}]}] }
//   GET  /app/api/memory/file?path=   -> { content }
//   POST /app/api/memory/file         { path, content } -> { ok, backup }
//   GET  /app/api/skills              -> { skills:[{name,description,enabled,path}] }
//   POST /app/api/skill/enabled       { name, enabled, reloadId? }
//
// EVERY one of these is treated as possibly-absent: an older server, a guest session, or a
// route that simply is not deployed yet. A section that cannot reach its endpoint shows one
// short inline line and stops — never a crash, never a spinner that runs forever.

import React, { useCallback, useEffect, useState } from "react";

// #region fetch helpers
// Anything that means "this endpoint is not usable here" (missing, forbidden, HTML instead of
// JSON) becomes this, so a section can show a calm line instead of a stack trace.
class Unavailable extends Error {}

function isUnavailable(e: unknown): e is Unavailable {
  return e instanceof Unavailable;
}

async function readJson(r: Response): Promise<any> {
  if (r.status === 401 || r.status === 403) throw new Unavailable("Not available to this session.");
  if (r.status === 404) throw new Unavailable("This server build does not have this feature yet.");
  const ct = r.headers.get("content-type") || "";
  if (!ct.includes("json")) throw new Unavailable("The server returned an unexpected response.");
  let body: any;
  try { body = await r.json(); } catch { throw new Unavailable("The server returned an unexpected response."); }
  if (!r.ok && !body?.error) throw new Unavailable("Request failed (" + r.status + ").");
  return body;
}

async function getJson(url: string): Promise<any> {
  let r: Response;
  try { r = await fetch(url, { credentials: "same-origin", cache: "no-store" }); }
  catch { throw new Unavailable("Could not reach the server."); }
  return readJson(r);
}

async function postJson(url: string, body: unknown): Promise<any> {
  let r: Response;
  try {
    r = await fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch { throw new Unavailable("Could not reach the server."); }
  return readJson(r);
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
// #endregion

// #region shared bits
function Note({ children }: { children: React.ReactNode }) {
  return <p className="ms-note">{children}</p>;
}

function Err({ text, onDismiss }: { text: string; onDismiss?: () => void }) {
  if (!text) return null;
  return (
    <div className="ms-err">
      <span>{text}</span>
      {onDismiss && <button className="ms-x" onClick={onDismiss} aria-label="Dismiss">×</button>}
    </div>
  );
}

// A section that could not load its data at all: one line, no retry loop, but an explicit retry.
function Dead({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <div className="ms-dead">
      <div>{text}</div>
      <button className="ms-btn" onClick={onRetry}>Try again</button>
    </div>
  );
}

function bytes(n: number): string {
  if (!Number.isFinite(n)) return "";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " kB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}

// "KEY=value" per line <-> object, for MCP env vars / HTTP headers.
function parsePairs(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i <= 0) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}
const formatPairs = (o?: Record<string, string>) =>
  o ? Object.entries(o).map(([k, v]) => k + "=" + v).join("\n") : "";
// #endregion

// #region MCP servers
export type McpEntry = {
  type?: "stdio" | "sse" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  timeout?: number;
};

// The SDK's live status blob. Field names beyond name/status are best-effort — read defensively.
type McpStatus = {
  name: string;
  status?: string;
  error?: string;
  tools?: unknown[];
  toolCount?: number;
  serverInfo?: { name?: string; version?: string };
};

const MCP_DOT: Record<string, string> = {
  connected: "#10B981",
  failed: "#EF4444",
  "needs-auth": "#F59E0B",
  pending: "#8a8078",
  disabled: "#8a8078",
};

function toolCountOf(s: McpStatus | undefined): number | null {
  if (!s) return null;
  if (Array.isArray(s.tools)) return s.tools.length;
  if (typeof s.toolCount === "number") return s.toolCount;
  return null;
}

export function McpSection({ activeId }: { activeId: string | null }) {
  const [servers, setServers] = useState<Record<string, McpEntry>>({});
  const [status, setStatus] = useState<Record<string, McpStatus>>({});
  const [live, setLive] = useState(false);
  const [loading, setLoading] = useState(true);
  const [dead, setDead] = useState("");
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");
  const [confirmName, setConfirmName] = useState<string | null>(null);

  // add/edit form
  const [editing, setEditing] = useState<null | { name: string; isNew: boolean }>(null);
  const [fName, setFName] = useState("");
  const [fType, setFType] = useState<"stdio" | "http" | "sse">("stdio");
  const [fCommand, setFCommand] = useState("");
  const [fArgs, setFArgs] = useState("");
  const [fUrl, setFUrl] = useState("");
  const [fPairs, setFPairs] = useState("");
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const r = await getJson("/app/api/mcp" + (activeId ? "?id=" + encodeURIComponent(activeId) : ""));
      setServers((r.servers || {}) as Record<string, McpEntry>);
      const map: Record<string, McpStatus> = {};
      for (const s of (r.status || []) as McpStatus[]) if (s && s.name) map[s.name] = s;
      setStatus(map);
      setLive(!!r.live);
      setDead("");
    } catch (e) {
      setDead(isUnavailable(e) ? msg(e) : "Could not load MCP servers: " + msg(e));
    } finally {
      setLoading(false);
    }
  }, [activeId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const closeForm = () => {
    setEditing(null);
    setFName(""); setFCommand(""); setFArgs(""); setFUrl(""); setFPairs(""); setFType("stdio");
  };

  const startAdd = () => {
    closeForm();
    setEditing({ name: "", isNew: true });
    setErr(""); setOk("");
  };

  const startEdit = (name: string) => {
    const s = servers[name] || {};
    const type = (s.type || "stdio") as "stdio" | "http" | "sse";
    setEditing({ name, isNew: false });
    setFName(name);
    setFType(type);
    setFCommand(s.command || "");
    setFArgs((s.args || []).join(" "));
    setFUrl(s.url || "");
    setFPairs(formatPairs(type === "stdio" ? s.env : s.headers));
    setErr(""); setOk("");
  };

  const save = async () => {
    setErr(""); setOk("");
    const name = fName.trim();
    if (!name) { setErr("Give the server a name."); return; }
    let config: McpEntry;
    if (fType === "stdio") {
      if (!fCommand.trim()) { setErr("A stdio server needs a command."); return; }
      const env = parsePairs(fPairs);
      config = {
        type: "stdio",
        command: fCommand.trim(),
        ...(fArgs.trim() ? { args: fArgs.trim().split(/\s+/) } : {}),
        ...(Object.keys(env).length ? { env } : {}),
      };
    } else {
      if (!/^https?:\/\//.test(fUrl.trim())) { setErr("A " + fType + " server needs an http(s) URL."); return; }
      const headers = parsePairs(fPairs);
      config = { type: fType, url: fUrl.trim(), ...(Object.keys(headers).length ? { headers } : {}) };
    }
    setSaving(true);
    try {
      const r = await postJson("/app/api/mcp", { name, config, applyTo: activeId || undefined });
      if (r.error) { setErr(String(r.error)); return; }
      closeForm();
      setOk(activeId && live ? "Saved and applied to this chat." : "Saved. It connects on your next chat.");
      await refresh();
    } catch (e) {
      setErr(msg(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (name: string) => {
    setConfirmName(null); setErr(""); setOk("");
    try {
      const r = await postJson("/app/api/mcp/delete", { name, applyTo: activeId || undefined });
      if (r.error) { setErr(String(r.error)); return; }
      await refresh();
    } catch (e) { setErr(msg(e)); }
  };

  const applyNow = async () => {
    setErr(""); setOk("");
    if (!activeId) return;
    try {
      const r = await postJson("/app/api/mcp/apply", { id: activeId });
      if (r.error) { setErr(String(r.error)); return; }
      setOk("Applied to this chat.");
      await refresh();
    } catch (e) { setErr(msg(e)); }
  };

  if (dead) return <Dead text={dead} onRetry={() => { void refresh(); }} />;

  const names = Object.keys(servers).sort();

  return (
    <>
      <Note>
        The tool servers this chat app connects. Changes take effect on your next chat; with a chat
        open they can be pushed into it live.
      </Note>

      <div className="ms-actions">
        <button className="ms-btn" onClick={editing ? closeForm : startAdd}>{editing ? "Cancel" : "+ Add server"}</button>
        {activeId && live && <button className="ms-btn" onClick={() => { void applyNow(); }}>Apply to this chat</button>}
      </div>

      {editing && (
        <div className="ms-form">
          <label className="ms-label" htmlFor="ms-mcp-name">Name</label>
          <input
            id="ms-mcp-name" className="ms-in" value={fName} readOnly={!editing.isNew}
            onChange={(e) => setFName(e.target.value)} placeholder="filesystem" autoCapitalize="none" autoCorrect="off"
          />
          {!editing.isNew && <div className="ms-hint">Remove and re-add to rename a server.</div>}

          <label className="ms-label" htmlFor="ms-mcp-type">Transport</label>
          <select id="ms-mcp-type" className="ms-in" value={fType} onChange={(e) => setFType(e.target.value as "stdio" | "http" | "sse")}>
            <option value="stdio">stdio — a local command</option>
            <option value="http">http — a remote URL</option>
            <option value="sse">sse — a remote URL</option>
          </select>

          {fType === "stdio" ? (
            <>
              <label className="ms-label" htmlFor="ms-mcp-cmd">Command</label>
              <input id="ms-mcp-cmd" className="ms-in" value={fCommand} onChange={(e) => setFCommand(e.target.value)} placeholder="npx" autoCapitalize="none" autoCorrect="off" />
              <label className="ms-label" htmlFor="ms-mcp-args">Arguments</label>
              <input id="ms-mcp-args" className="ms-in" value={fArgs} onChange={(e) => setFArgs(e.target.value)} placeholder="-y @modelcontextprotocol/server-filesystem /home/filip" autoCapitalize="none" autoCorrect="off" />
            </>
          ) : (
            <>
              <label className="ms-label" htmlFor="ms-mcp-url">URL</label>
              <input id="ms-mcp-url" className="ms-in" value={fUrl} onChange={(e) => setFUrl(e.target.value)} placeholder="https://example.com/mcp" autoCapitalize="none" autoCorrect="off" />
            </>
          )}

          <label className="ms-label" htmlFor="ms-mcp-pairs">{fType === "stdio" ? "Environment" : "Headers"} — one KEY=value per line, optional</label>
          <textarea id="ms-mcp-pairs" className="ms-in ms-ta ms-ta-s" value={fPairs} onChange={(e) => setFPairs(e.target.value)} placeholder={fType === "stdio" ? "API_KEY=…" : "Authorization=Bearer …"} spellCheck={false} />

          <button className="ms-btn ms-primary" onClick={() => { void save(); }} disabled={saving}>{saving ? "Saving…" : "Save server"}</button>
        </div>
      )}

      <Err text={err} onDismiss={() => setErr("")} />
      {ok && <div className="ms-ok">{ok}</div>}

      <div className="ms-list">
        {loading && !names.length ? (
          <div className="ms-empty">Loading…</div>
        ) : !names.length ? (
          <div className="ms-empty">No MCP servers yet. The built-in ask_user tool is always available.</div>
        ) : (
          names.map((n) => {
            const s = servers[n] || {};
            const st = status[n];
            const type = s.type || "stdio";
            const detail = type === "stdio" ? [s.command, ...(s.args || [])].join(" ") : s.url || "";
            const tools = toolCountOf(st);
            return (
              <div className="ms-row" key={n}>
                <div className="ms-row-top">
                  <span className="ms-dot" style={{ background: st ? MCP_DOT[st.status || ""] || "#8a8078" : "#8a8078" }} title={st?.status || "not connected in this chat"} />
                  <span className="ms-name">{n}</span>
                  <span className="ms-badge">{type}</span>
                  <span className="ms-state">
                    {st?.status || (live ? "not connected" : "no chat open")}
                    {tools !== null ? " · " + tools + (tools === 1 ? " tool" : " tools") : ""}
                  </span>
                  <span className="ms-row-acts">
                    <button className="ms-ic" onClick={() => startEdit(n)}>edit</button>
                    {confirmName === n ? (
                      <>
                        <button className="ms-ic ms-danger" onClick={() => { void remove(n); }}>remove</button>
                        <button className="ms-ic" onClick={() => setConfirmName(null)}>cancel</button>
                      </>
                    ) : (
                      <button className="ms-ic ms-ic-x" title={"Remove " + n} aria-label={"Remove " + n} onClick={() => setConfirmName(n)}>×</button>
                    )}
                  </span>
                </div>
                {detail && <div className="ms-sub"><code>{detail}</code></div>}
                {st?.error && <div className="ms-rowerr">{st.error}</div>}
                {st?.status === "needs-auth" && (
                  <div className="ms-sub">Needs authorising. Open this server's login from a terminal session (<code>/mcp</code>).</div>
                )}
              </div>
            );
          })
        )}
      </div>
    </>
  );
}
// #endregion

// #region Skills
type SkillRow = { name: string; description?: string; enabled: boolean; path?: string };

export function SkillsSection({ activeId }: { activeId: string | null }) {
  const [skills, setSkills] = useState<SkillRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [dead, setDead] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const r = await getJson("/app/api/skills");
      setSkills(((r.skills || []) as SkillRow[]).filter((s) => s && s.name));
      setDead("");
    } catch (e) {
      setDead(isUnavailable(e) ? msg(e) : "Could not load skills: " + msg(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const toggle = async (s: SkillRow) => {
    setErr(""); setBusy(s.name);
    // Optimistic: the switch should move under the thumb straight away; refresh() is the truth.
    setSkills((prev) => prev.map((x) => (x.name === s.name ? { ...x, enabled: !x.enabled } : x)));
    try {
      const r = await postJson("/app/api/skill/enabled", {
        name: s.name,
        enabled: !s.enabled,
        reloadId: activeId || undefined,
      });
      if (r.error) setErr(String(r.error));
    } catch (e) {
      setErr(msg(e));
    } finally {
      setBusy(null);
      await refresh();
    }
  };

  if (dead) return <Dead text={dead} onRetry={() => { void refresh(); }} />;

  const on = skills.filter((s) => s.enabled).length;

  return (
    <>
      <Note>
        Skills in <code>~/.claude/skills</code>. Turning one off renames its file on disk, so every
        session sees the change{activeId ? "; the open chat reloads its skills straight away" : ""}.
      </Note>

      <Err text={err} onDismiss={() => setErr("")} />

      <div className="ms-list">
        {loading && !skills.length ? (
          <div className="ms-empty">Loading…</div>
        ) : !skills.length ? (
          <div className="ms-empty">No skills in ~/.claude/skills.</div>
        ) : (
          <>
            <div className="ms-count">{on} of {skills.length} on</div>
            {skills.map((s) => (
              <div className="ms-row" key={s.name}>
                <div className="ms-row-top">
                  <span className="ms-name">{s.name}</span>
                  <span className="ms-row-acts">
                    <button
                      role="switch" aria-checked={s.enabled} aria-label={s.name}
                      className={"ms-toggle" + (s.enabled ? " on" : "")}
                      disabled={busy === s.name}
                      onClick={() => { void toggle(s); }}
                    >
                      <span className="ms-knob" />
                    </button>
                  </span>
                </div>
                {s.description && <div className="ms-sub ms-clamp">{s.description}</div>}
              </div>
            ))}
          </>
        )}
      </div>
    </>
  );
}
// #endregion

// #region Memory
type MemFile = { name: string; path: string; size: number };
type MemProject = { id: string; label: string; files: MemFile[] };

export function MemorySection() {
  const [projects, setProjects] = useState<MemProject[]>([]);
  const [sel, setSel] = useState("");
  const [loading, setLoading] = useState(true);
  const [dead, setDead] = useState("");
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");

  const [openPath, setOpenPath] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pendingOpen, setPendingOpen] = useState<string | null>(null); // file waiting on a discard

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const r = await getJson("/app/api/memory");
      const list = ((r.projects || []) as MemProject[]).filter((p) => p && p.id);
      setProjects(list);
      setSel((cur) => (cur && list.some((p) => p.id === cur) ? cur : list[0]?.id || ""));
      setDead("");
    } catch (e) {
      setDead(isUnavailable(e) ? msg(e) : "Could not load memory: " + msg(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const doOpen = async (path: string) => {
    setErr(""); setOk(""); setPendingOpen(null);
    try {
      const r = await getJson("/app/api/memory/file?path=" + encodeURIComponent(path));
      if (r.error) { setErr(String(r.error)); return; }
      setOpenPath(path);
      setContent(String(r.content ?? ""));
      setDirty(false);
    } catch (e) { setErr(msg(e)); }
  };

  // Never silently drop an edit: switching files with unsaved work asks first.
  const openFile = (path: string) => {
    if (path === openPath) return;
    if (dirty) { setPendingOpen(path); return; }
    void doOpen(path);
  };

  const save = async () => {
    if (!openPath) return;
    setErr(""); setOk(""); setSaving(true);
    try {
      const r = await postJson("/app/api/memory/file", { path: openPath, content });
      if (r.error) { setErr(String(r.error)); return; }
      setDirty(false);
      setOk(r.backup ? "Saved. A backup of the old file was written." : "Saved.");
      await refresh();
    } catch (e) { setErr(msg(e)); }
    finally { setSaving(false); }
  };

  if (dead) return <Dead text={dead} onRetry={() => { void refresh(); }} />;

  const project = projects.find((p) => p.id === sel);
  const shortPath = (p: string) => p.replace(/^.*\/\.claude\//, "~/.claude/");

  return (
    <>
      <Note>
        The memory files Claude reads at the start of a session. Every save writes a backup of the
        previous version first. Changes apply to new sessions.
      </Note>

      <Err text={err} onDismiss={() => setErr("")} />

      {loading && !projects.length ? (
        <div className="ms-empty">Loading…</div>
      ) : !projects.length ? (
        <div className="ms-empty">No memory files found.</div>
      ) : (
        <>
          <label className="ms-label" htmlFor="ms-mem-proj">Project</label>
          <select id="ms-mem-proj" className="ms-in" value={sel} onChange={(e) => { setSel(e.target.value); }}>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>

          <div className="ms-files">
            {(project?.files || []).map((f) => (
              <button
                key={f.path}
                className={"ms-file" + (f.path === openPath ? " on" : "")}
                onClick={() => openFile(f.path)}
              >
                <span className="ms-file-name">{f.name}</span>
                <span className="ms-state">{bytes(f.size)}</span>
              </button>
            ))}
            {project && !project.files.length && <div className="ms-empty">No files in this project.</div>}
          </div>
        </>
      )}

      {pendingOpen && (
        <div className="ms-confirm">
          <span>Unsaved changes in {openPath ? shortPath(openPath) : "this file"}.</span>
          <button className="ms-ic" onClick={() => setPendingOpen(null)}>keep editing</button>
          <button className="ms-ic ms-danger" onClick={() => { void doOpen(pendingOpen); }}>discard</button>
        </div>
      )}

      {openPath && (
        <div className="ms-editor">
          <div className="ms-editor-head">
            <span className="ms-sub">{shortPath(openPath)}{dirty ? " · unsaved" : ""}</span>
            <button className="ms-ic" onClick={() => { if (!dirty) { setOpenPath(null); setContent(""); } else setPendingOpen(openPath); }}>close</button>
          </div>
          <textarea
            className="ms-in ms-ta" value={content} spellCheck={false}
            onChange={(e) => { setContent(e.target.value); setDirty(true); setOk(""); }}
          />
          <div className="ms-editor-foot">
            {ok && <span className="ms-ok-inline">{ok}</span>}
            <button className="ms-btn ms-primary" disabled={!dirty || saving} onClick={() => { void save(); }}>{saving ? "Saving…" : "Save"}</button>
          </div>
        </div>
      )}
    </>
  );
}
// #endregion

// #region injected styles (app CSS vars only — nothing hardcoded but the status dots)
let cssDone = false;
export function injectManageCss() {
  if (cssDone || typeof document === "undefined") return;
  cssDone = true;
  const el = document.createElement("style");
  el.id = "manage-css";
  el.textContent = `
  .ms-note{margin:0 0 14px;font-size:12.5px;line-height:1.55;color:var(--text-3,#8a8078)}
  .ms-note code,.ms-sub code{font-family:var(--mono,ui-monospace,Menlo,Consolas,monospace);font-size:11.5px;color:var(--text-2,#b8afa5);word-break:break-word}

  .ms-actions{display:flex;flex-wrap:wrap;gap:10px;margin:0 0 14px}
  .ms-btn{padding:9px 14px;border-radius:10px;border:1px solid var(--line,#3a322c);background:var(--bg-3,#2a2420);color:var(--text,#ece7e1);font-size:13.5px;font-weight:500}
  .ms-btn:hover{border-color:var(--text-3,#8a8078)}
  .ms-btn:disabled{opacity:.5;cursor:default}
  .ms-btn.ms-primary{margin-top:16px;background:var(--accent,#d97757);border-color:var(--accent,#d97757);color:#fff;font-weight:600}
  .ms-btn.ms-primary:hover{filter:brightness(1.06)}

  .ms-list{display:flex;flex-direction:column;gap:10px}
  .ms-count{font-size:11px;text-transform:uppercase;letter-spacing:.05em;font-weight:600;color:var(--text-3,#8a8078)}
  .ms-empty{font-size:12.5px;line-height:1.55;color:var(--text-3,#8a8078);padding:4px 0}
  .ms-row{border:1px solid var(--line-2,#2c2621);border-radius:11px;padding:12px 14px;background:var(--bg,#1a1613)}
  .ms-row-top{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .ms-dot{width:9px;height:9px;border-radius:50%;flex:0 0 auto}
  .ms-name{font-weight:600;font-size:14px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .ms-badge{flex:0 0 auto;font-size:10px;text-transform:uppercase;letter-spacing:.05em;font-weight:600;padding:2px 7px;border-radius:6px;background:var(--bg-3,#2a2420);color:var(--text-3,#8a8078)}
  .ms-state{font-size:12px;color:var(--text-3,#8a8078);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .ms-row-acts{margin-left:auto;display:flex;align-items:center;gap:4px;flex:0 0 auto}
  .ms-ic{background:transparent;border:none;color:var(--text-3,#8a8078);font-size:12px;padding:6px 8px;border-radius:7px}
  .ms-ic:hover{color:var(--text,#ece7e1);background:var(--bg-3,#2a2420)}
  .ms-ic-x{font-size:17px;line-height:1}
  .ms-ic.ms-danger{color:#EF4444;font-weight:600}
  .ms-sub{margin-top:8px;font-size:12px;line-height:1.5;color:var(--text-3,#8a8078);word-break:break-word}
  .ms-clamp{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
  .ms-rowerr{margin-top:8px;font-size:12px;line-height:1.5;color:#EF4444;word-break:break-word}
  .ms-hint{font-size:11.5px;color:var(--text-3,#8a8078);margin-top:5px}

  .ms-err{display:flex;align-items:flex-start;gap:8px;margin:0 0 12px;font-size:12.5px;line-height:1.5;color:#EF4444}
  .ms-x{background:transparent;border:none;color:inherit;font-size:16px;line-height:1;padding:0 2px;margin-left:auto}
  .ms-ok{margin:0 0 12px;font-size:12.5px;color:#10B981}
  .ms-ok-inline{font-size:12px;color:#10B981;margin-right:auto}

  .ms-dead{display:flex;flex-direction:column;align-items:flex-start;gap:12px;font-size:12.5px;line-height:1.6;color:var(--text-3,#8a8078)}

  .ms-form{margin:0 0 16px;border:1px dashed var(--line,#3a322c);border-radius:11px;padding:14px 16px 16px}
  .ms-label{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--text-3,#8a8078);margin:14px 0 5px;font-weight:600}
  .ms-form .ms-label:first-child{margin-top:0}
  .ms-in{width:100%;padding:10px 11px;border-radius:9px;border:1px solid var(--line,#3a322c);background:var(--panel,#17130f);color:var(--text,#ece7e1);font-family:var(--mono,ui-monospace,Menlo,Consolas,monospace);font-size:12.5px;outline:none}
  .ms-in:focus{border-color:var(--accent,#d97757)}
  .ms-in::placeholder{color:var(--text-3,#8a8078)}
  select.ms-in{font-family:var(--font,system-ui);font-size:13px;appearance:none}
  .ms-ta{resize:vertical;min-height:240px;line-height:1.55}
  .ms-ta-s{min-height:70px}

  .ms-files{display:flex;flex-direction:column;gap:2px;margin-top:12px}
  .ms-file{display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;text-align:left;padding:10px 11px;border-radius:9px;border:1px solid transparent;background:transparent;color:var(--text-2,#b8afa5);font-family:inherit;font-size:13px}
  .ms-file:hover{background:var(--bg,#1a1613);border-color:var(--line-2,#2c2621);color:var(--text,#ece7e1)}
  .ms-file.on{background:var(--bg,#1a1613);border-color:var(--accent,#d97757);color:var(--text,#ece7e1)}
  .ms-file-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--mono,ui-monospace,Menlo,Consolas,monospace);font-size:12.5px}

  .ms-confirm{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-top:12px;padding:10px 12px;border:1px solid var(--line,#3a322c);border-radius:10px;font-size:12.5px;color:var(--text-2,#b8afa5)}

  .ms-editor{margin-top:16px}
  .ms-editor-head{display:flex;align-items:center;gap:10px;margin-bottom:6px}
  .ms-editor-head .ms-sub{margin-top:0;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .ms-editor-foot{display:flex;align-items:center;justify-content:flex-end;gap:10px;margin-top:2px}
  .ms-editor-foot .ms-primary{margin-top:10px}

  .ms-toggle{width:42px;height:25px;border-radius:999px;border:1px solid var(--line,#3a322c);background:var(--bg-3,#2a2420);position:relative;padding:0;flex:0 0 auto;transition:background .15s,border-color .15s}
  .ms-toggle.on{background:var(--accent,#d97757);border-color:var(--accent,#d97757)}
  .ms-toggle:disabled{opacity:.6}
  .ms-knob{position:absolute;top:3px;left:3px;width:17px;height:17px;border-radius:50%;background:var(--text-3,#8a8078);transition:left .15s,background .15s}
  .ms-toggle.on .ms-knob{left:20px;background:#fff}
  @media (prefers-reduced-motion:reduce){.ms-toggle,.ms-knob{transition:none}}
  `;
  document.head.appendChild(el);
}
// #endregion
