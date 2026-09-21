// app/mathrender.ts — render LaTeX math in assistant markdown with KaTeX.
//
// marked would mangle TeX (it treats \, _, ^, {} as markdown), so math is pulled OUT before marked
// runs and swapped back IN after. Each span becomes an opaque placeholder token that survives marked
// untouched, then the token is replaced with KaTeX's HTML. Math inside inline `code` spans is left
// alone (fenced blocks are already separate segments upstream in parseAssistant).
//
// Delimiters, matching what Claude emits: $$...$$ and \[...\] (display), \(...\) and $...$ (inline).
// The $...$ form is guarded so a price ("$100 ... $5") never turns into math: no space just inside
// the delimiters, the opener is not followed by a digit, and \$ is a literal dollar sign.
import katex from "katex";

const OPTS = { throwOnError: false as const, strict: false as const };

function render(tex: string, display: boolean): string {
  try { return katex.renderToString(tex.trim(), { ...OPTS, displayMode: display }); }
  catch { return display ? `<div class="math-err">${escapeHtml(tex)}</div>` : `<span class="math-err">${escapeHtml(tex)}</span>`; }
}
function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
}

// Pull every math span out of `md`, returning the tokenized text plus a restore() that swaps the
// KaTeX HTML back into marked's output. Placeholders are plain alphanumerics so marked emits them
// verbatim (no wrapping, no escaping) and they can't collide with real prose.
export function extractMath(md: string): { text: string; restore: (html: string) => string } {
  if (!md || (md.indexOf("$") < 0 && md.indexOf("\\(") < 0 && md.indexOf("\\[") < 0)) {
    return { text: md, restore: (h) => h };
  }
  const store: string[] = [];
  const tok = (html: string) => { const i = store.length; store.push(html); return ` MATH${i}MATH `; };

  // Work on segments split around inline-code spans, so a `$x$` inside backticks is never math.
  const parts = md.split(/(`[^`]*`)/);
  const out = parts.map((seg) => {
    if (seg.startsWith("`") && seg.endsWith("`")) return seg; // inline code, untouched
    let s = seg;
    s = s.replace(/\$\$([\s\S]+?)\$\$/g, (_m, tex) => tok(render(tex, true)));   // $$ ... $$
    s = s.replace(/\\\[([\s\S]+?)\\\]/g, (_m, tex) => tok(render(tex, true)));   // \[ ... \]
    s = s.replace(/\\\(([\s\S]+?)\\\)/g, (_m, tex) => tok(render(tex, false)));  // \( ... \)
    // $ ... $  — guarded: not \$, opener not followed by a space, closer not preceded by a space or
    // followed by a digit (so "$5 to $10" stays currency). A digit right after the opener usually
    // means money too, so a digit-led span is math only when it looks like TeX: it carries a
    // backslash command ("$2 \cdot 5 = 50$") or is a compact token with no internal spaces
    // ("$2uv$", "$25/2$"). "$5 and you have $5" has a space and no backslash, so it stays literal.
    s = s.replace(/(^|[^\\$])\$(?![\s$])([^\n$]*?[^\s\\])\$(?!\d)/g, (_m, pre, tex) =>
      (/^\d/.test(tex) && /\s/.test(tex) && !tex.includes("\\")) ? _m : pre + tok(render(tex, false)));
    return s;
  }).join("");

  return {
    text: out,
    // The placeholder is emitted with a space on each side, but marked strips leading/trailing
    // whitespace at block boundaries (e.g. the start of a list item), which left a bare "MATH3MATH"
    // in the output. Match the surrounding spaces optionally so a trimmed placeholder still restores.
    restore: (html: string) => html.replace(/ ?MATH(\d+)MATH ?/g, (_m, i) => store[Number(i)] ?? ""),
  };
}
