// app/manage.tsx — MCP servers + Memory + Skills management, embedded in the app's Settings modal.
// Self-contained (own fetch helpers + own injected CSS namespaced ms-*/mcp-*), so app/main.tsx
// only imports <ManageSections> and drops it into the existing settings body. Keeps collisions
// with the concurrent chat-app work to a single import + one JSX line.
import React, { useCallback, useEffect, useRef, useState } from "react";

// #region api
const J = (r: Response) => r.json();
const POST = (url: string, body: any) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(J);
const api = {
  mcpList: (id?: string | null) => fetch(`/app/api/mcp${id ? `?id=${encodeURIComponent(id)}` : ""}`).then(J),
  mcpAdd: (name: string, config: any, applyTo?: string | null) => POST("/app/api/mcp", { name, config, applyTo }),
  mcpDel: (name: string, applyTo?: string | null) => POST("/app/api/mcp/delete", { name, applyTo }),
  memList: () => fetch("/app/api/memory").then(J),
  memRead: (path: string) => fetch(`/app/api/memory/file?path=${encodeURIComponent(path)}`).then(J),
  memWrite: (path: string, content: string) => POST("/app/api/memory/file", { path, content }),
  skillList: () => fetch("/app/api/skills").then(J),
  skillRead: (name: string) => fetch(`/app/api/skill?name=${encodeURIComponent(name)}`).then(J),
  skillWrite: (name: string, content: string, create: boolean, reloadId?: string | null) => POST("/app/api/skill", { name, content, create, reloadId }),
  skillEnabled: (name: string, enabled: boolean, reloadId?: string | null) => POST("/app/api/skill/enabled", { name, enabled, reloadId }),
};
// #endregion

const STATUS_COLOR: Record<string, string> = { connected: "#10B981", failed: "#EF4444", "needs-auth": "#F59E0B", pending: "#8b8b8b", disabled: "#8b8b8b" };

// #region MCP
type McpMap = Record<string, any>;
type McpStatus = { name: string; status: string; error?: string; tools?: { name: string }[] };

function McpSection({ activeId }: { activeId: string | null }) {
  const [servers, setServers] = useState<McpMap>({});
  const [status, setStatus] = useState<Record<string, McpStatus>>({});
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<"stdio" | "http" | "sse">("stdio");
  const [command, setCommand] = useState("");
  const [argsText, setArgsText] = useState("");
  const [url, setUrl] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.mcpList(activeId);
      setServers(r.servers || {});
      const map: Record<string, McpStatus> = {};
      for (const s of (r.status || []) as McpStatus[]) map[s.name] = s;
      setStatus(map);
    } catch (e: any) { setErr(String(e?.message || e)); }
    finally { setLoading(false); }
  }, [activeId]);
  useEffect(() => { void refresh(); }, [refresh]);

  const reset = () => { setName(""); setCommand(""); setArgsText(""); setUrl(""); setTransport("stdio"); setAdding(false); setErr(null); };
  const submit = async () => {
    setErr(null);
    let config: any;
    if (transport === "stdio") {
      if (!command.trim()) return setErr("command is required");
      config = { type: "stdio", command: command.trim(), ...(argsText.trim() ? { args: argsText.trim().split(/\s+/) } : {}) };
    } else {
      if (!/^https?:\/\//.test(url.trim())) return setErr("a http(s) url is required");
      config = { type: transport, url: url.trim() };
    }
    const r = await api.mcpAdd(name.trim(), config, activeId);
    if (r.error) return setErr(r.error);
    reset(); await refresh();
  };
  const del = async (n: string) => { if (!confirm(`Remove MCP server "${n}"?`)) return; const r = await api.mcpDel(n, activeId); if (r.error) return setErr(r.error); await refresh(); };

  const names = Object.keys(servers).sort();
  return (
    <div className="ms-block">
      <div className="ms-head">
        <div><div className="ms-title">MCP servers</div><div className="ms-sub">Tools the model can call in this app. Applied to new chats{activeId ? ", and pushed live into the open chat" : ""}.</div></div>
        {!adding && <button className="ms-btn" onClick={() => setAdding(true)}>+ Add</button>}
      </div>
      {adding && (
        <div className="ms-form">
          <label>Name<input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. filesystem" /></label>
          <label>Transport
            <select value={transport} onChange={(e) => setTransport(e.target.value as any)}>
              <option value="stdio">stdio (local command)</option>
              <option value="http">http (remote url)</option>
              <option value="sse">sse (remote url)</option>
            </select>
          </label>
          {transport === "stdio" ? (
            <>
              <label>Command<input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" /></label>
              <label>Args<input value={argsText} onChange={(e) => setArgsText(e.target.value)} placeholder="-y @modelcontextprotocol/server-filesystem /home/filip" /></label>
            </>
          ) : <label>URL<input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/mcp" /></label>}
          <div className="ms-form-actions"><button className="ms-btn ghost" onClick={reset}>Cancel</button><button className="ms-btn primary" onClick={submit}>Save</button></div>
        </div>
      )}
      {err && <div className="ms-err">{err}</div>}
      <div className="ms-list">
        {loading && !names.length ? <div className="ms-empty">Loading…</div>
          : !names.length ? <div className="ms-empty">No MCP servers configured. The built-in ask_user tool is always available.</div>
          : names.map((n) => {
            const s = servers[n]; const st = status[n];
            const desc = s.type === "http" || s.type === "sse" ? s.url : [s.command, ...(s.args || [])].join(" ");
            return (
              <div key={n} className="ms-row">
                <div className="ms-row-main">
                  <div className="ms-row-name">
                    {st && <span className="ms-dot" style={{ background: STATUS_COLOR[st.status] || "#8b8b8b" }} title={st.status} />}
                    {n}<span className="ms-badge">{s.type || "stdio"}</span>
                    {st?.tools && <span className="ms-muted">{st.tools.length} tool{st.tools.length === 1 ? "" : "s"}</span>}
                    {st && <span className="ms-muted">{st.status}</span>}
                  </div>
                  <div className="ms-row-desc">{desc}</div>
                  {st?.error && <div className="ms-rowerr">{st.error}</div>}
                </div>
                <button className="ms-btn ghost" onClick={() => del(n)}>Remove</button>
              </div>
            );
          })}
      </div>
    </div>
  );
}
// #endregion

// #region Memory
type MemProject = { id: string; label: string; files: { name: string; path: string; size: number }[] };

function MemorySection() {
  const [projects, setProjects] = useState<MemProject[]>([]);
  const [sel, setSel] = useState<string>("");
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { (async () => { try { const r = await api.memList(); setProjects(r.projects || []); if (r.projects?.[0]) setSel(r.projects[0].id); } catch (e: any) { setErr(String(e?.message || e)); } })(); }, []);
  const project = projects.find((p) => p.id === sel);

  const openFile = async (path: string) => {
    setErr(null); setMsg(null);
    try { const r = await api.memRead(path); if (r.error) return setErr(r.error); setOpenPath(path); setContent(r.content); setDirty(false); }
    catch (e: any) { setErr(String(e?.message || e)); }
  };
  const save = async () => {
    if (!openPath) return; setErr(null);
    const r = await api.memWrite(openPath, content);
    if (r.error) return setErr(r.error);
    setDirty(false); setMsg(r.backup ? "Saved (backup written)" : "Saved");
  };

  return (
    <div className="ms-block">
      <div className="ms-head"><div><div className="ms-title">Memory</div><div className="ms-sub">Edit ~/.claude memory files. A backup is written before every overwrite. Changes apply to new sessions.</div></div></div>
      {err && <div className="ms-err">{err}</div>}
      <div className="ms-picker">
        <select value={sel} onChange={(e) => { setSel(e.target.value); setOpenPath(null); }}>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
      </div>
      <div className="ms-filelist">
        {project?.files.map((f) => (
          <button key={f.path} className={"ms-file" + (f.path === openPath ? " active" : "")} onClick={() => openFile(f.path)}>
            <span>{f.name}</span><span className="ms-muted">{f.size} B</span>
          </button>
        )) || <div className="ms-empty">No memory files.</div>}
      </div>
      {openPath && (
        <div className="ms-editor">
          <textarea value={content} onChange={(e) => { setContent(e.target.value); setDirty(true); setMsg(null); }} spellCheck={false} />
          <div className="ms-editor-foot">
            {msg && <span className="ms-ok">{msg}</span>}
            <div className="spacer" />
            <button className="ms-btn primary" disabled={!dirty} onClick={save}>Save</button>
          </div>
        </div>
      )}
    </div>
  );
}
// #endregion

// #region Skills
type SkillRow = { name: string; description: string; enabled: boolean; path: string };

function SkillsSection({ activeId }: { activeId: string | null }) {
  const [skills, setSkills] = useState<SkillRow[]>([]);
  const [openName, setOpenName] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [dirty, setDirty] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => { try { const r = await api.skillList(); setSkills(r.skills || []); } catch (e: any) { setErr(String(e?.message || e)); } }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const toggle = async (s: SkillRow) => { setErr(null); const r = await api.skillEnabled(s.name, !s.enabled, activeId); if (r.error) return setErr(r.error); await refresh(); };
  const edit = async (name: string) => { setErr(null); setMsg(null); setCreating(false); const r = await api.skillRead(name); if (r.error) return setErr(r.error); setOpenName(name); setContent(r.content); setDirty(false); };
  const save = async () => {
    setErr(null);
    const name = creating ? newName.trim() : openName;
    if (!name) return setErr("name required");
    const r = await api.skillWrite(name, content, creating, activeId);
    if (r.error) return setErr(r.error);
    setMsg(r.created ? "Skill created" : r.backup ? "Saved (backup written)" : "Saved");
    setDirty(false); setCreating(false); setOpenName(name); await refresh();
  };
  const startCreate = () => { setCreating(true); setOpenName(null); setNewName(""); setContent("---\nname: my-skill\ndescription: what it does and when to use it\n---\n\n# Instructions\n"); setDirty(true); setMsg(null); };

  return (
    <div className="ms-block">
      <div className="ms-head">
        <div><div className="ms-title">Skills</div><div className="ms-sub">~/.claude/skills. Toggle disables a skill on disk (reloaded live){activeId ? " into the open chat" : ""}. Edits apply to new sessions.</div></div>
        <button className="ms-btn" onClick={startCreate}>+ New</button>
      </div>
      {err && <div className="ms-err">{err}</div>}
      <div className="ms-list">
        {!skills.length ? <div className="ms-empty">No skills in ~/.claude/skills.</div> : skills.map((s) => (
          <div key={s.name} className="ms-row">
            <div className="ms-row-main">
              <div className="ms-row-name">{s.name}{!s.enabled && <span className="ms-badge">disabled</span>}</div>
              {s.description && <div className="ms-row-desc">{s.description}</div>}
            </div>
            <button className="ms-btn ghost" onClick={() => edit(s.name)}>Edit</button>
            <button role="switch" aria-checked={s.enabled} className={"ms-toggle" + (s.enabled ? " on" : "")} onClick={() => toggle(s)} title={s.enabled ? "Enabled" : "Disabled"}><span className="knob" /></button>
          </div>
        ))}
      </div>
      {(openName || creating) && (
        <div className="ms-editor">
          {creating && <label className="ms-newname">Name<input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="my-skill" /></label>}
          <textarea value={content} onChange={(e) => { setContent(e.target.value); setDirty(true); setMsg(null); }} spellCheck={false} />
          <div className="ms-editor-foot">
            {msg && <span className="ms-ok">{msg}</span>}
            <div className="spacer" />
            <button className="ms-btn ghost" onClick={() => { setOpenName(null); setCreating(false); }}>Close</button>
            <button className="ms-btn primary" disabled={!dirty} onClick={save}>Save</button>
          </div>
        </div>
      )}
    </div>
  );
}
// #endregion

let cssInjected = false;
export function ManageSections({ activeId }: { activeId: string | null }) {
  useEffect(() => {
    if (cssInjected || typeof document === "undefined") return;
    cssInjected = true;
    const el = document.createElement("style"); el.textContent = CSS; document.head.appendChild(el);
  }, []);
  return (
    <div className="ms-root">
      <McpSection activeId={activeId} />
      <MemorySection />
      <SkillsSection activeId={activeId} />
    </div>
  );
}

const CSS = `
.modal:has(.ms-root){width:min(720px,96vw);max-width:720px;max-height:88vh}
.settings-body:has(.ms-root){overflow-y:auto}
.ms-root{display:flex;flex-direction:column;gap:20px;margin-top:6px}
.ms-block{display:flex;flex-direction:column;gap:10px;border-top:1px solid #2c2c2c;padding-top:14px}
.ms-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.ms-title{font-weight:600;font-size:14px}
.ms-sub{font-size:12px;color:#8b8b8b;margin-top:2px;max-width:52ch}
.ms-muted{font-size:11px;color:#8b8b8b}
.ms-btn{border-radius:8px;border:1px solid #3a3a3a;background:#262626;color:#e6e6e6;padding:6px 12px;font-size:13px;cursor:pointer;font-family:inherit;white-space:nowrap}
.ms-btn.primary:hover,.ms-btn:hover{background:#7C3AED;border-color:#7C3AED;color:#fff}
.ms-btn.ghost{background:transparent}
.ms-btn.ghost:hover{background:#262626;border-color:#EF4444;color:#EF4444}
.ms-btn:disabled{opacity:.5;cursor:default;background:#262626;border-color:#3a3a3a;color:#888}
.ms-form,.ms-editor{display:flex;flex-direction:column;gap:10px;background:#171717;border:1px solid #2c2c2c;border-radius:10px;padding:14px}
.ms-form label,.ms-newname{display:flex;flex-direction:column;gap:4px;font-size:12px;color:#a8a8a8}
.ms-form input,.ms-form select,.ms-newname input,.ms-picker select{background:#0f0f0f;border:1px solid #333;border-radius:7px;color:#eee;padding:8px 10px;font-size:13px;font-family:inherit}
.ms-form input:focus,.ms-form select:focus,.ms-newname input:focus{outline:none;border-color:#7C3AED}
.ms-form-actions,.ms-editor-foot{display:flex;justify-content:flex-end;gap:8px;align-items:center}
.ms-editor-foot .spacer{flex:1}
.ms-err{background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.4);color:#f5a5a5;border-radius:8px;padding:8px 12px;font-size:12px}
.ms-ok{color:#10B981;font-size:12px}
.ms-list{display:flex;flex-direction:column;gap:8px}
.ms-empty{color:#8b8b8b;font-size:13px;padding:6px 0}
.ms-row{display:flex;align-items:center;justify-content:space-between;gap:10px;background:#171717;border:1px solid #2c2c2c;border-radius:10px;padding:10px 12px}
.ms-row-main{min-width:0;flex:1}
.ms-row-name{display:flex;align-items:center;gap:8px;font-weight:500;font-size:13px;flex-wrap:wrap}
.ms-dot{width:8px;height:8px;border-radius:50%;flex:none}
.ms-badge{font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:#9a9a9a;border:1px solid #333;border-radius:5px;padding:1px 5px}
.ms-row-desc{font-size:12px;color:#8b8b8b;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ms-rowerr{font-size:11px;color:#f5a5a5;margin-top:3px}
.ms-picker{display:flex}
.ms-picker select{width:100%}
.ms-filelist{display:flex;flex-direction:column;gap:4px}
.ms-file{display:flex;justify-content:space-between;align-items:center;gap:8px;background:transparent;border:1px solid transparent;border-radius:7px;color:#d6d6d6;padding:7px 10px;font-size:13px;cursor:pointer;text-align:left;font-family:inherit}
.ms-file:hover{background:#171717;border-color:#2c2c2c}
.ms-file.active{background:#171717;border-color:#7C3AED}
.ms-editor textarea{width:100%;min-height:240px;resize:vertical;background:#0f0f0f;border:1px solid #333;border-radius:8px;color:#eaeaea;padding:10px 12px;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}
.ms-editor textarea:focus{outline:none;border-color:#7C3AED}
.ms-toggle{width:38px;height:22px;border-radius:11px;border:1px solid #3a3a3a;background:#2a2a2a;position:relative;cursor:pointer;flex:none;padding:0}
.ms-toggle .knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#8b8b8b;transition:left .15s,background .15s}
.ms-toggle.on{background:#10B981;border-color:#10B981}
.ms-toggle.on .knob{left:18px;background:#fff}
`;
