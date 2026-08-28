// artifacts.tsx — a self-contained "artifacts" module for the /app chat surface, giving the
// assistant message the same treatment claude.ai does: plain markdown stays inline, fenced code
// gets a syntax-highlighted card with copy, and anything renderable (HTML, SVG, a React/JSX/TSX
// component, a DOM script, or a mermaid diagram) becomes an inline artifact card that opens a live
// preview in a SANDBOXED iframe.
//
// Self-contained on purpose: the only coupling to main.tsx is the small props contract on
// AssistantContent / ArtifactViewer at the bottom. All styles are injected from here (kept out of
// styles.css), matching the pattern used in voice.tsx. Nothing in this file edits or imports
// main.tsx internals — rewriteLocalRefs is re-implemented locally so the module owns its behaviour.
//
// SECURITY: preview iframes get sandbox="allow-scripts" and NEVER allow-same-origin, so artifact
// code cannot reach the parent origin, its cookies, or localStorage. The parent-side markdown path
// is unchanged from main.tsx (marked + the same local-ref rewrite), so it is no less safe than today.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { marked } from "marked";
import hljs from "highlight.js/lib/common";

// Defensive: match main.tsx's marked config so the module renders identically if used on its own.
marked.setOptions({ gfm: true, breaks: true });

// #region types
export type ArtifactKind = "html" | "svg" | "react" | "js" | "mermaid";

export interface Artifact {
  id: string;          // stable-ish per message (index + content hash) so React keys/panels are stable
  kind: ArtifactKind;
  lang: string;        // the original fence info-string language token (lowercased)
  code: string;        // the raw fenced body
  title: string;       // detected title (html <title>/<h1>, component name) or a kind label
}

export type Segment =
  | { type: "markdown"; text: string }
  | { type: "code"; lang: string; code: string }
  | { type: "artifact"; artifact: Artifact };

export type ArtifactViewerMode = "panel" | "sheet";
// #endregion

// #region parsing
// A tiny content hash (djb2) for artifact ids — not cryptographic, just stable per body.
function shortHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

const RE_JSX = /(?:return\s*\(?\s*<[A-Za-z]|=>\s*\(?\s*<[A-Za-z]|<[A-Za-z][^>]*>[\s\S]*<\/[A-Za-z])/;
const RE_REACT = /\bReactDOM\b|\bReact\b|from\s*['"]react|require\(\s*['"]react/;
const RE_COMPONENT = /export\s+default|function\s+[A-Z]\w*|const\s+[A-Z]\w*\s*=/;
const RE_DOM = /\bdocument\.|\bwindow\.|getContext\s*\(|requestAnimationFrame|new\s+Chart|\bd3\.|\bTHREE\.|<canvas/;

function looksReact(code: string): boolean {
  return RE_REACT.test(code) || (RE_JSX.test(code) && RE_COMPONENT.test(code));
}
function looksDom(code: string): boolean {
  return RE_DOM.test(code);
}

// Decide whether a fenced block is a previewable artifact and, if so, what kind. Returns null for a
// normal code block (bash, python, json, plain ts, etc.).
function classifyFence(info: string, code: string): ArtifactKind | null {
  const lang = (info.trim().split(/\s+/)[0] || "").toLowerCase();
  switch (lang) {
    case "html":
    case "htm":
      return "html";
    case "svg":
      return "svg";
    case "xml":
      return /<svg[\s>]/i.test(code) ? "svg" : null;
    case "jsx":
    case "tsx":
    case "react":
      return "react";
    case "js":
    case "javascript":
    case "mjs":
    case "ts":
    case "typescript":
      return looksReact(code) ? "react" : looksDom(code) && lang !== "ts" && lang !== "typescript" ? "js" : null;
    case "mermaid":
    case "mmd":
      return "mermaid";
    default:
      return null;
  }
}

function detectTitle(kind: ArtifactKind, code: string): string {
  if (kind === "html" || kind === "js") {
    const t = code.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (t?.[1]?.trim()) return t[1].trim();
    const h = code.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    if (h?.[1]) return h[1].replace(/<[^>]+>/g, "").trim() || "HTML";
    return kind === "js" ? "Script" : "HTML";
  }
  if (kind === "svg") return "SVG";
  if (kind === "mermaid") return "Diagram";
  // react: name the default-exported / App component
  const m =
    code.match(/export\s+default\s+function\s+([A-Za-z_$][\w$]*)/) ||
    code.match(/function\s+([A-Z][\w$]*)\s*\(/) ||
    code.match(/(?:const|let|var)\s+([A-Z][\w$]*)\s*=/) ||
    code.match(/export\s+default\s+([A-Za-z_$][\w$]*)/);
  return m?.[1] ? `<${m[1]} />` : "React component";
}

// Split an assistant message into ordered segments. Line-based fence scanner (robust to blank lines
// and nested backticks inside a block, and tolerant of an unterminated fence while streaming).
export function parseAssistant(text: string): Segment[] {
  const src = text || "";
  const lines = src.split("\n");
  const segs: Segment[] = [];
  let md: string[] = [];
  const flushMd = () => {
    if (md.length) {
      const joined = md.join("\n");
      if (joined.trim() !== "") segs.push({ type: "markdown", text: joined });
    }
    md = [];
  };

  let i = 0;
  let artIndex = 0;
  const fenceOpen = /^(\s{0,3})(`{3,}|~{3,})(.*)$/;
  while (i < lines.length) {
    const m = lines[i].match(fenceOpen);
    if (m) {
      const marker = m[2];
      const info = m[3] || "";
      // collect until a matching closing fence (same char, >= length, nothing but whitespace after)
      const closeRe = new RegExp(`^\\s{0,3}${marker[0]}{${marker.length},}\\s*$`);
      const body: string[] = [];
      let j = i + 1;
      let closed = false;
      for (; j < lines.length; j++) {
        if (closeRe.test(lines[j])) { closed = true; break; }
        body.push(lines[j]);
      }
      const code = body.join("\n");
      flushMd();
      const kind = classifyFence(info, code);
      if (kind) {
        const lang = (info.trim().split(/\s+/)[0] || "").toLowerCase();
        segs.push({
          type: "artifact",
          artifact: { id: `a${artIndex++}-${shortHash(code)}`, kind, lang, code, title: detectTitle(kind, code) },
        });
      } else {
        segs.push({ type: "code", lang: (info.trim().split(/\s+/)[0] || "").toLowerCase(), code });
      }
      i = closed ? j + 1 : j; // skip past the closing fence, or to EOF if never closed
    } else {
      md.push(lines[i]);
      i++;
    }
  }
  flushMd();
  return segs;
}
// #endregion

// #region local-ref rewriting + file helpers
// Download URL for a local path Claude wrote, via the /app proxy route (mirrors main.tsx).
export function downloadUrl(convId: string | null | undefined, path: string): string {
  return `/app/api/download?id=${encodeURIComponent(convId || "")}&path=${encodeURIComponent(path)}`;
}

// True when an href points at a local file Claude produced (not a remote/anchor/data URL).
export function isLocalFileHref(href: string): boolean {
  return !/^(https?:|mailto:|tel:|#|data:|blob:|\/app\/api\/)/i.test(href);
}

// Re-implemented locally (cannot import main.tsx). Same behaviour: local <img>/<a> point at the
// download route; remote/data/blob refs are left alone. Keeps the parent markdown path as safe as today.
function rewriteLocalRefs(html: string, convId: string | null): string {
  const dl = (p: string) => downloadUrl(convId, p);
  return html
    .replace(/<img([^>]*?)\ssrc="([^"]+)"([^>]*)>/g, (m, pre, src, post) =>
      /^(https?:|data:|blob:|\/app\/api\/)/i.test(src) ? `<img${pre} src="${src}"${post} loading="lazy">` : `<img${pre} src="${dl(src)}"${post} loading="lazy">`)
    .replace(/<a([^>]*?)\shref="([^"]+)"([^>]*)>/g, (m, pre, href, post) =>
      /^(https?:|mailto:|#|\/app\/api\/)/i.test(href) ? m : `<a${pre} href="${dl(href)}"${post} target="_blank" rel="noreferrer" download>`);
}

const EXT_ICON: Record<string, string> = {
  pdf: "📄", zip: "🗜", csv: "📊", xlsx: "📊", xls: "📊", json: "🧾", txt: "📄", md: "📝",
  png: "🖼", jpg: "🖼", jpeg: "🖼", gif: "🖼", svg: "🖼", mp4: "🎬", mov: "🎬", mp3: "🎵", wav: "🎵",
};
function extOf(name: string): string {
  const m = name.match(/\.([A-Za-z0-9]+)$/);
  return m ? m[1].toLowerCase() : "";
}
function fmtBytes(n?: number): string | null {
  if (n == null || !isFinite(n)) return null;
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}

// A download card for a local file Claude saved. href is the ALREADY-rewritten download URL (or use
// downloadUrl()); name/size are display-only.
export function FileCard({ href, name, size }: { href: string; name: string; size?: number }) {
  const ext = extOf(name);
  const icon = EXT_ICON[ext] || "📎";
  const sz = fmtBytes(size);
  return (
    <a className="ct-file-card" href={href} target="_blank" rel="noreferrer" download title={`Download ${name}`}>
      <span className="ct-file-ic" aria-hidden>{icon}</span>
      <span className="ct-file-meta">
        <span className="ct-file-name">{name}</span>
        <span className="ct-file-sub">{ext ? ext.toUpperCase() : "FILE"}{sz ? ` · ${sz}` : ""}</span>
      </span>
      <svg className="ct-file-dl" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12" /><path d="M7 11l5 5 5-5" /><path d="M5 21h14" /></svg>
    </a>
  );
}
// #endregion

// #region CodeBlock
function CopyButton({ text, className }: { text: string; className?: string }) {
  const [done, setDone] = useState(false);
  const onCopy = useCallback(async () => {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else {
        const ta = document.createElement("textarea");
        ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove();
      }
      setDone(true); setTimeout(() => setDone(false), 1400);
    } catch { /* clipboard blocked — no-op */ }
  }, [text]);
  return (
    <button className={"ct-copy" + (className ? " " + className : "") + (done ? " done" : "")} onClick={onCopy} title="Copy">
      {done ? (
        <><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>Copied</>
      ) : (
        <><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg>Copy</>
      )}
    </button>
  );
}

// Syntax-highlighted code card with a language header + copy. Highlighting via highlight.js common
// bundle; unknown languages fall back to auto-detect.
export function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const html = useMemo(() => {
    const language = (lang || "").toLowerCase();
    try {
      if (language && hljs.getLanguage(language)) return hljs.highlight(code, { language, ignoreIllegals: true }).value;
      return hljs.highlightAuto(code).value;
    } catch {
      // fall back to escaped plain text
      return code.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] as string));
    }
  }, [code, lang]);
  return (
    <div className="ct-code">
      <div className="ct-code-head">
        <span className="ct-code-lang">{lang || "text"}</span>
        <CopyButton text={code} />
      </div>
      <pre className="hljs"><code dangerouslySetInnerHTML={{ __html: html }} /></pre>
    </div>
  );
}
// #endregion

// #region iframe document builders
// Escape a string that is being injected between <script>…</script> so a literal "</script>" in the
// content cannot terminate the tag early. (Only for injected JS/strings, not for full HTML docs.)
function escScriptClose(s: string): string {
  return s.replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--");
}

const IFRAME_RESET = `*{box-sizing:border-box}html,body{margin:0}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:#fff;color:#111;padding:0}#root{min-height:100vh}pre.__art_err{white-space:pre-wrap;word-break:break-word;font:13px/1.5 ui-monospace,Menlo,Consolas,monospace;color:#b00020;background:#fff5f5;border:1px solid #ffd3d3;border-radius:8px;padding:12px;margin:14px}`;

const REACT_CDN = `<script crossorigin src="https://unpkg.com/react@18/umd/react.production.min.js"></script><script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>`;

// Wrap a partial HTML fragment into a full document; pass full docs through untouched.
function htmlDoc(code: string): string {
  if (/^\s*<!doctype|^\s*<html[\s>]/i.test(code)) return code;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${IFRAME_RESET}</style></head><body>${code}</body></html>`;
}

function svgDoc(code: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${IFRAME_RESET}html,body{height:100%}body{display:flex;align-items:center;justify-content:center;padding:16px}svg{max-width:100%;max-height:100%;height:auto}</style></head><body>${code}</body></html>`;
}

// A DOM/canvas script: give it a #root + #app mount point and run it after load.
function jsDoc(code: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${IFRAME_RESET}</style></head><body><div id="root"></div><div id="app"></div><script>try{\n${escScriptClose(code)}\n}catch(e){document.body.innerHTML='<pre class="__art_err">'+String((e&&e.stack)||e).replace(/</g,'&lt;')+'</pre>';}<\/script></body></html>`;
}

function mermaidDoc(code: string): string {
  const json = escScriptClose(JSON.stringify(code));
  return `<!doctype html><html><head><meta charset="utf-8"><style>${IFRAME_RESET}html,body{height:100%}body{display:flex;align-items:center;justify-content:center;padding:16px}#root{max-width:100%}svg{max-width:100%;height:auto}</style></head><body><div id="root"></div><script type="module">import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';mermaid.initialize({startOnLoad:false});try{const {svg}=await mermaid.render('m',${json});document.getElementById('root').innerHTML=svg;}catch(e){document.body.innerHTML='<pre class="__art_err">'+String((e&&e.message)||e).replace(/</g,'&lt;')+'</pre>';}<\/script></body></html>`;
}

// @babel/standalone is loaded lazily from a CDN (script injection) rather than bundled: the app's
// build (app/build.ts) does not enable Bun code-splitting, so a bundled dynamic import would inline
// Babel (~2.3MB min) into the eager shell. The npm package stays installed for the pinned version +
// types; at runtime we fetch the matching build the first time a React artifact is opened, mirroring
// the way the preview iframe already pulls React from unpkg. Cached after the first load.
interface BabelStandalone {
  transform: (code: string, opts: Record<string, unknown>) => { code?: string | null };
}
const BABEL_CDN = "https://unpkg.com/@babel/standalone@8.0.4/babel.min.js";
let babelPromise: Promise<BabelStandalone> | null = null;
function loadBabel(): Promise<BabelStandalone> {
  if (babelPromise) return babelPromise;
  babelPromise = new Promise<BabelStandalone>((resolve, reject) => {
    const w = window as unknown as { Babel?: BabelStandalone };
    if (w.Babel) return resolve(w.Babel);
    const s = document.createElement("script");
    s.src = BABEL_CDN; s.async = true;
    s.onload = () => (w.Babel ? resolve(w.Babel) : reject(new Error("Babel failed to initialise")));
    s.onerror = () => { babelPromise = null; reject(new Error("Could not load the JSX transpiler (network blocked?)")); };
    document.head.appendChild(s);
  });
  return babelPromise;
}

// Transpile React/JSX/TSX to browser-runnable JS. Modules are converted to CommonJS so
// `import`/`export` are legal inside a classic <script>, and a tiny require() shim maps
// react/react-dom to the UMD globals.
async function reactDoc(code: string): Promise<string> {
  const Babel = await loadBabel();
  const out = Babel.transform(code, {
    filename: "artifact.tsx",
    // classic runtime => React.createElement against the UMD global (the React UMD build does not
    // expose the automatic jsx-runtime); commonjs => import/export are legal in a classic <script>.
    presets: [["react", { runtime: "classic" }], "typescript", ["env", { modules: "commonjs", targets: { chrome: "90" } }]],
  });
  const js = out.code || "";
  const body = escScriptClose(js);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${IFRAME_RESET}</style>${REACT_CDN}</head><body><div id="root"></div><script>
(function(){
  try{
    var module={exports:{}};var exports=module.exports;
    function require(m){
      if(m==='react')return window.React;
      if(m==='react-dom'||m==='react-dom/client')return window.ReactDOM;
      if(m==='react/jsx-runtime'||m==='react/jsx-dev-runtime')return window.React;
      throw new Error("Cannot import '"+m+"' in an artifact preview");
    }
${body}
    var Comp=(module.exports&&(module.exports.default||module.exports.App||module.exports.Main))||(typeof App!=='undefined'?App:null);
    if(!Comp)throw new Error('No default export or component named App was found to render.');
    var root=window.ReactDOM.createRoot(document.getElementById('root'));
    root.render(window.React.createElement(Comp));
  }catch(e){document.body.innerHTML='<pre class="__art_err">'+String((e&&e.stack)||e).replace(/</g,'&lt;')+'</pre>';}
})();
window.addEventListener('error',function(ev){var b=document.getElementById('root');if(b&&!b.hasChildNodes()){document.body.innerHTML='<pre class="__art_err">'+String(ev.message).replace(/</g,'&lt;')+'</pre>';}});
<\/script></body></html>`;
}

async function buildArtifactDoc(a: Artifact): Promise<string> {
  switch (a.kind) {
    case "html": return htmlDoc(a.code);
    case "svg": return svgDoc(a.code);
    case "js": return jsDoc(a.code);
    case "mermaid": return mermaidDoc(a.code);
    case "react": return reactDoc(a.code);
  }
}

const DOWNLOAD_EXT: Record<ArtifactKind, string> = { html: "html", svg: "svg", js: "js", mermaid: "mmd", react: "jsx" };
// #endregion

// #region ArtifactCard
function KindIcon({ kind }: { kind: ArtifactKind }) {
  const common = { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  if (kind === "svg") return (<svg {...common}><path d="M3 3h18v18H3z" /><path d="M8 12l2.5 3L16 8" /></svg>);
  if (kind === "react") return (<svg {...common}><circle cx="12" cy="12" r="1.6" /><ellipse cx="12" cy="12" rx="10" ry="4" /><ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(60 12 12)" /><ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(120 12 12)" /></svg>);
  if (kind === "mermaid") return (<svg {...common}><rect x="3" y="4" width="7" height="5" rx="1" /><rect x="14" y="15" width="7" height="5" rx="1" /><path d="M6.5 9v3.5A2.5 2.5 0 0 0 9 15h5.5" /></svg>);
  // html / js
  return (<svg {...common}><path d="M8 3L3 12l5 9" /><path d="M16 3l5 9-5 9" /></svg>);
}

const KIND_LABEL: Record<ArtifactKind, string> = { html: "HTML", svg: "SVG", react: "React", js: "Script", mermaid: "Diagram" };

// Compact inline card. Tap "Open" (or the card) to launch the viewer.
export function ArtifactCard({ artifact, onOpen }: { artifact: Artifact; onOpen: (a: Artifact) => void }) {
  return (
    <button className="ct-art-card" onClick={() => onOpen(artifact)} title={`Open ${artifact.title}`}>
      <span className="ct-art-thumb" aria-hidden><KindIcon kind={artifact.kind} /></span>
      <span className="ct-art-meta">
        <span className="ct-art-title">{artifact.title}</span>
        <span className="ct-art-kind">{KIND_LABEL[artifact.kind]} · click to open</span>
      </span>
      <span className="ct-art-open">Open<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M7 17L17 7" /><path d="M8 7h9v9" /></svg></span>
    </button>
  );
}
// #endregion

// #region ArtifactViewer
type Tab = "preview" | "source";

// The live renderer. Works as an embedded right-hand panel (mode="panel", fills its container) or as
// a full-screen sheet (mode="sheet"). main.tsx chooses which based on viewport width.
export function ArtifactViewer({ artifact, mode, onClose }: { artifact: Artifact; mode: ArtifactViewerMode; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("preview");
  const [doc, setDoc] = useState<string>("");
  const [err, setErr] = useState<string | null>(null);
  const [building, setBuilding] = useState(true);

  useEffect(() => {
    let live = true;
    setBuilding(true); setErr(null);
    buildArtifactDoc(artifact)
      .then((d) => { if (live) { setDoc(d); setBuilding(false); } })
      .catch((e: unknown) => { if (live) { setErr(e instanceof Error ? e.message : String(e)); setBuilding(false); } });
    return () => { live = false; };
  }, [artifact.id, artifact.code, artifact.kind]);

  // Esc closes the full-screen sheet.
  useEffect(() => {
    if (mode !== "sheet") return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, onClose]);

  const download = useCallback(() => {
    const blob = new Blob([artifact.code], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `${(artifact.title || "artifact").replace(/[^\w.-]+/g, "_").slice(0, 40) || "artifact"}.${DOWNLOAD_EXT[artifact.kind]}`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }, [artifact]);

  const openInTab = useCallback(() => {
    if (!doc) return;
    const blob = new Blob([doc], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank", "noopener");
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }, [doc]);

  return (
    <div className={"ct-av ct-av-" + mode}>
      <div className="ct-av-head">
        <div className="ct-av-tabs">
          <button className={"ct-av-tab" + (tab === "preview" ? " on" : "")} onClick={() => setTab("preview")}>Preview</button>
          <button className={"ct-av-tab" + (tab === "source" ? " on" : "")} onClick={() => setTab("source")}>Source</button>
        </div>
        <div className="ct-av-title" title={artifact.title}>{artifact.title}</div>
        <div className="ct-av-actions">
          <CopyButton text={artifact.code} className="ct-av-btn" />
          <button className="ct-av-btn" onClick={download} title="Download source"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12" /><path d="M7 11l5 5 5-5" /><path d="M5 21h14" /></svg>Save</button>
          <button className="ct-av-btn" onClick={openInTab} disabled={!doc} title="Open preview in a new tab"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M14 4h6v6" /><path d="M20 4l-9 9" /><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></svg></button>
          <button className="ct-av-close" onClick={onClose} title="Close">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>
      </div>
      <div className="ct-av-body">
        {tab === "preview" ? (
          err ? (
            <div className="ct-av-error"><b>Could not render this artifact</b><pre>{err}</pre></div>
          ) : building ? (
            <div className="ct-av-loading"><span className="ct-av-spin" />Rendering…</div>
          ) : (
            <iframe
              className="ct-av-frame"
              title={artifact.title}
              sandbox="allow-scripts allow-popups allow-forms allow-modals"
              srcDoc={doc}
            />
          )
        ) : (
          <div className="ct-av-source"><CodeBlock code={artifact.code} lang={artifact.lang || artifact.kind} /></div>
        )}
      </div>
    </div>
  );
}
// #endregion

// #region AssistantContent (drop-in replacement for main.tsx's <Assistant>)
function Markdown({ text, convId }: { text: string; convId: string | null }) {
  const html = useMemo(() => rewriteLocalRefs(marked.parse(text || "") as string, convId), [text, convId]);
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}

// Renders a whole assistant message: markdown runs, code cards, artifact cards, and an image
// lightbox. onOpenArtifact is called when a card is opened — main.tsx owns where <ArtifactViewer>
// goes (split-screen panel on desktop, full-screen sheet on mobile).
export function AssistantContent({ text, convId, onOpenArtifact }: { text: string; convId?: string | null; onOpenArtifact?: (a: Artifact) => void }) {
  const segs = useMemo(() => parseAssistant(text), [text]);
  const cid = convId ?? null;
  const [light, setLight] = useState<string | null>(null);

  // Tap an inline image to open a lightbox (images already resolve via rewriteLocalRefs).
  const onImgClick = useCallback((e: React.MouseEvent) => {
    const t = e.target as HTMLElement;
    if (t.tagName === "IMG") { const src = (t as HTMLImageElement).currentSrc || (t as HTMLImageElement).src; if (src) { e.preventDefault(); setLight(src); } }
  }, []);

  return (
    <div className="md-root" onClick={onImgClick}>
      {segs.map((s, i) => {
        if (s.type === "markdown") return <Markdown key={i} text={s.text} convId={cid} />;
        if (s.type === "code") return <CodeBlock key={i} code={s.code} lang={s.lang} />;
        return <ArtifactCard key={s.artifact.id} artifact={s.artifact} onOpen={(a) => onOpenArtifact?.(a)} />;
      })}
      {light && (
        <div className="ct-lightbox" onClick={() => setLight(null)} role="dialog" aria-modal>
          <img src={light} alt="" />
          <button className="ct-lightbox-x" onClick={() => setLight(null)} aria-label="Close">×</button>
        </div>
      )}
    </div>
  );
}
// #endregion

// #region styles (injected once, mirrors voice.tsx's approach; reuses styles.css CSS vars)
function injectArtifactCss() {
  if (typeof document === "undefined" || document.getElementById("artifacts-css")) return;
  const css = `
  .md-root > .md + .md{margin-top:0}
  /* code card */
  .ct-code{border:1px solid var(--line-2);border-radius:11px;margin:0 0 12px;overflow:hidden;background:#120f0c}
  .ct-code-head{display:flex;align-items:center;gap:8px;padding:7px 10px 7px 13px;background:var(--bg-2);border-bottom:1px solid var(--line-2)}
  .ct-code-lang{font-family:var(--mono);font-size:11.5px;color:var(--text-3);text-transform:uppercase;letter-spacing:.05em;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .ct-copy{display:inline-flex;align-items:center;gap:5px;background:transparent;border:1px solid var(--line);color:var(--text-2);border-radius:7px;padding:4px 9px;font-size:12px;font-family:inherit;transition:background .12s,color .12s,border-color .12s}
  .ct-copy:hover{background:var(--bg-3);color:var(--text)}
  .ct-copy.done{color:var(--success,#10B981);border-color:color-mix(in srgb,var(--success,#10B981) 45%,transparent)}
  .ct-code pre{margin:0;padding:12px 14px;overflow-x:auto;background:#120f0c}
  .ct-code pre code{font-family:var(--mono);font-size:12.5px;line-height:1.55;background:none;padding:0}
  /* file card */
  .ct-file-card{display:inline-flex;align-items:center;gap:11px;max-width:100%;margin:4px 0;padding:9px 13px;background:var(--bg-2);border:1px solid var(--line);border-radius:11px;color:var(--text);text-decoration:none;transition:border-color .12s,background .12s}
  .ct-file-card:hover{border-color:var(--accent);background:var(--bg-3)}
  .ct-file-ic{font-size:20px;line-height:1;flex:0 0 auto}
  .ct-file-meta{display:flex;flex-direction:column;min-width:0;gap:1px}
  .ct-file-name{font-size:13.5px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .ct-file-sub{font-size:11px;color:var(--text-3);letter-spacing:.03em}
  .ct-file-dl{flex:0 0 auto;color:var(--text-3)}
  .ct-file-card:hover .ct-file-dl{color:var(--accent)}
  /* artifact card */
  .ct-art-card{display:flex;align-items:center;gap:12px;width:100%;text-align:left;margin:2px 0 12px;padding:12px 14px;background:var(--bg-2);border:1px solid var(--line);border-radius:12px;color:var(--text);transition:border-color .12s,background .12s}
  .ct-art-card:hover{border-color:var(--accent);background:var(--bg-3)}
  .ct-art-thumb{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px;border-radius:9px;background:color-mix(in srgb,var(--accent) 14%,transparent);color:var(--accent)}
  .ct-art-meta{display:flex;flex-direction:column;min-width:0;flex:1;gap:2px}
  .ct-art-title{font-size:14px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .ct-art-kind{font-size:11.5px;color:var(--text-3)}
  .ct-art-open{flex:0 0 auto;display:inline-flex;align-items:center;gap:4px;font-size:12.5px;font-weight:600;color:var(--accent);border:1px solid color-mix(in srgb,var(--accent) 40%,transparent);border-radius:8px;padding:6px 11px}
  .ct-art-card:hover .ct-art-open{background:color-mix(in srgb,var(--accent) 16%,transparent)}
  /* viewer — shared */
  .ct-av{display:flex;flex-direction:column;background:var(--panel);border:1px solid var(--line);min-height:0;overflow:hidden}
  .ct-av-panel{height:100%;width:100%;border-radius:0;border-top:none;border-bottom:none;border-right:none}
  .ct-av-sheet{position:fixed;inset:0;z-index:80;border:none;border-radius:0}
  .ct-av-head{flex:0 0 auto;display:flex;align-items:center;gap:10px;padding:9px 12px;border-bottom:1px solid var(--line-2);background:var(--bg-2)}
  .ct-av-tabs{flex:0 0 auto;display:inline-flex;background:var(--bg);border:1px solid var(--line);border-radius:9px;padding:2px}
  .ct-av-tab{background:transparent;border:none;color:var(--text-3);font:inherit;font-size:12.5px;font-weight:500;padding:5px 12px;border-radius:7px}
  .ct-av-tab.on{background:var(--bg-3);color:var(--text)}
  .ct-av-title{flex:1;min-width:0;font-size:13px;font-weight:500;color:var(--text-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:center}
  .ct-av-actions{flex:0 0 auto;display:inline-flex;align-items:center;gap:6px}
  .ct-av-btn{display:inline-flex;align-items:center;gap:5px;background:transparent;border:1px solid var(--line);color:var(--text-2);border-radius:8px;padding:5px 9px;font:inherit;font-size:12px;transition:background .12s,color .12s}
  .ct-av-btn:hover:not(:disabled){background:var(--bg-3);color:var(--text)}
  .ct-av-btn:disabled{opacity:.45;cursor:default}
  .ct-av-close{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;background:transparent;border:1px solid var(--line);color:var(--text-2);border-radius:8px}
  .ct-av-close:hover{background:var(--bg-3);color:var(--text)}
  .ct-av-body{flex:1;min-height:0;position:relative;display:flex;background:#fff}
  .ct-av-frame{flex:1;width:100%;height:100%;border:none;background:#fff}
  .ct-av-source{flex:1;min-height:0;overflow:auto;background:var(--panel);padding:12px}
  .ct-av-source .ct-code{margin:0}
  .ct-av-loading{flex:1;display:flex;align-items:center;justify-content:center;gap:9px;color:var(--text-3);font-size:13px;background:var(--panel)}
  .ct-av-spin{width:14px;height:14px;border-radius:50%;border:2px solid var(--line);border-top-color:var(--accent);animation:spin .8s linear infinite}
  .ct-av-error{flex:1;overflow:auto;padding:18px;background:var(--panel);color:var(--text-2);font-size:13px}
  .ct-av-error b{display:block;margin-bottom:8px;color:var(--danger,#e0685f)}
  .ct-av-error pre{white-space:pre-wrap;word-break:break-word;font-family:var(--mono);font-size:12px;background:var(--bg-2);border:1px solid var(--line-2);border-radius:8px;padding:12px}
  /* image lightbox */
  .ct-lightbox{position:fixed;inset:0;z-index:90;background:rgba(0,0,0,.86);display:flex;align-items:center;justify-content:center;padding:24px;cursor:zoom-out}
  .ct-lightbox img{max-width:100%;max-height:100%;border-radius:8px;box-shadow:0 20px 60px rgba(0,0,0,.6)}
  .ct-lightbox-x{position:fixed;top:14px;right:16px;width:40px;height:40px;border-radius:50%;background:rgba(255,255,255,.12);border:none;color:#fff;font-size:26px;line-height:1}
  .ct-lightbox-x:hover{background:rgba(255,255,255,.22)}
  /* highlight.js — warm dark theme tuned to the app palette */
  .hljs{color:#ece7e1;background:transparent}
  .hljs-comment,.hljs-quote{color:#8a8078;font-style:italic}
  .hljs-keyword,.hljs-selector-tag,.hljs-literal,.hljs-doctag,.hljs-formula{color:#d98b6c}
  .hljs-string,.hljs-regexp,.hljs-addition,.hljs-attribute,.hljs-meta .hljs-string{color:#9fce8a}
  .hljs-number,.hljs-symbol,.hljs-bullet,.hljs-link,.hljs-selector-attr,.hljs-template-variable,.hljs-variable{color:#e0b872}
  .hljs-title,.hljs-section,.hljs-name,.hljs-selector-id,.hljs-selector-class{color:#7fb0e0;font-weight:600}
  .hljs-type,.hljs-class .hljs-title,.hljs-built_in,.hljs-builtin-name{color:#6fc2c2}
  .hljs-attr,.hljs-property,.hljs-params{color:#c9a7e6}
  .hljs-tag,.hljs-punctuation{color:#b8afa5}
  .hljs-emphasis{font-style:italic}.hljs-strong{font-weight:700}
  @media (max-width:820px){.ct-av-head{gap:6px;padding:8px 8px calc(8px)}.ct-av-title{display:none}.ct-av-btn span{display:none}}
  `;
  const el = document.createElement("style"); el.id = "artifacts-css"; el.textContent = css; document.head.appendChild(el);
}
injectArtifactCss();
// #endregion
