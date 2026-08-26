import type { IncomingMessage, ServerResponse } from "node:http";

export function sendJson(res: ServerResponse, code: number, payload: unknown, headers: Record<string, string> = {}): void {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(body);
}

export function sendText(res: ServerResponse, code: number, text: string, headers: Record<string, string> = {}): void {
  res.writeHead(code, { "Content-Type": "text/plain; charset=utf-8", ...headers });
  res.end(text);
}

export function sendHtml(res: ServerResponse, code: number, html: string): void {
  res.writeHead(code, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(html);
}

export function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { Location: location, "Cache-Control": "no-store" });
  res.end();
}

async function rawBody(req: IncomingMessage, limit = 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    total += (c as Buffer).length;
    if (total > limit) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function readJsonBody<T = unknown>(req: IncomingMessage): Promise<T> {
  const text = await rawBody(req);
  return (text ? JSON.parse(text) : {}) as T;
}

export async function readFormBody(req: IncomingMessage): Promise<URLSearchParams> {
  const text = await rawBody(req);
  return new URLSearchParams(text);
}

/** Minimal HTML-escape for the small status pages we render. */
export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
