// Phone bridge: a call to the Twilio number becomes a chat in the caller's own /app.
// Caller id picks the user (Filip or a guest) and so the sidecar; the carrier attestation and a
// voiceprint on the first utterance decide whether the call may run a prompt at all.
// Ported from Brandon McDonald's deploy/phone/bridge.py (brandmcd/claude-terminal 178451b).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  admit, enrollStep, gather, HANGUP, isGoodbye, LINES, loadConfig, pause, play, redirect, say, signatureOk, spoken, userForCaller,
  startStream, TONES, twiml, voiceStep, voiceVerdict, type EnrollState, type PhoneConfig, type PhoneUser, type VoiceCheck,
} from "./lib";
import { startSetup } from "./setup";

const STATE = process.env.PHONE_STATE || "/var/lib/claude-phone";
let cfg: PhoneConfig = loadConfig(join(STATE, "config.json"));
const reloadCfg = () => { cfg = loadConfig(join(STATE, "config.json")); }; // users change from the setup page
const SID = process.env.TWILIO_ACCOUNT_SID || "";
const TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const AUDIO_DIR = join(STATE, "audio");
const ENROLL_DIR = join(STATE, "enroll");
const MAX_AUDIO_BYTES = 8000 * 90; // 90 s of 8 kHz mu-law per utterance window

const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

//#region state
type Turn = {
  id: string; user: PhoneUser; conv: string | null; started: number;
  done: boolean; failed: boolean; answer: string; callback: boolean; to: string;
};
type Call = {
  sid: string; user: PhoneUser; from: string; conv: string | null; turn: string | null; model?: string;
  token: string; audio: Uint8Array[]; audioBytes: number;
  verified: boolean; shortTries: number; retried: boolean; pending: string | null; // pending = the question said before a voice retry
  enroll: EnrollState | null;
};
const calls = new Map<string, Call>();
const byToken = new Map<string, Call>();
const turns = new Map<string, Turn>();

function takeAudio(c: Call): Uint8Array {
  const out = new Uint8Array(c.audioBytes);
  let o = 0;
  for (const chunk of c.audio) { out.set(chunk, o); o += chunk.length; }
  c.audio = []; c.audioBytes = 0;
  return out;
}

function endCall(sid: string) {
  const c = calls.get(sid);
  if (!c) return;
  byToken.delete(c.token);
  calls.delete(sid);
}
//#endregion

//#region sidecar
type Json = Record<string, unknown>;

async function sidecar(user: PhoneUser, method: "GET" | "POST", path: string, body?: Json): Promise<Json | null> {
  const r = await fetch(user.sidecar + path, {
    method, headers: { "remote-user": user.name, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000),
  });
  if (r.status === 404) return null;
  return (await r.json()) as Json;
}

type StreamEvent = { t: string; sessionId?: string; text?: string; cid?: string; message?: string };

/** Follow the chat's live stream from our own user turn to its result. The answer is the text after
 *  the last tool call. Sets the real session id on the turn as soon as the stream reports it. */
async function followTurn(t: Turn, streamId: string, cid: string): Promise<void> {
  const r = await fetch(`${t.user.sidecar}/app/stream/${encodeURIComponent(streamId)}`, { headers: { "remote-user": t.user.name } });
  if (!r.ok || !r.body) throw new Error(`stream ${r.status}`);
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "", mine = false, answer: string[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error("stream ended before the result");
    buf += dec.decode(value, { stream: true });
    let cut: number;
    while ((cut = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, cut); buf = buf.slice(cut + 2);
      const data = frame.split("\n").find((l) => l.startsWith("data: "));
      if (!data) continue;
      const e = JSON.parse(data.slice(6)) as StreamEvent;
      if (e.t === "init" && e.sessionId) { t.conv = e.sessionId; const c = callOfTurn(t.id); if (c) c.conv = e.sessionId; }
      else if (e.t === "user" && e.cid === cid) { mine = true; answer = []; }
      else if (!mine) continue;
      else if (e.t === "text_delta" && e.text) answer.push(e.text); // the live stream sends text as deltas
      else if (e.t === "block_end") answer.push(" ");
      else if (e.t === "tool_start" || e.t === "tool_use" || e.t === "tool_result") answer = [];
      else if (e.t === "error") throw new Error(e.message || "chat error");
      else if (e.t === "closed") throw new Error("chat closed");
      else if (e.t === "result") { t.answer = spoken(answer.join(""), cfg.sayLimit); await reader.cancel(); return; }
    }
  }
}

function callOfTurn(tid: string): Call | undefined {
  for (const c of calls.values()) if (c.turn === tid) return c;
  return undefined;
}

const MODEL_ASK = /^(?:switch to|use|ask|talk to)\s+(fable|opus|sonnet|haiku)\b[,.!:]?\s*(.*)$/i;

async function pickModel(user: PhoneUser, family: string): Promise<string> {
  const cat = (await sidecar(user, "GET", "/app/api/models")) ?? {};
  const list = [...((cat.models as Json[]) ?? []), ...((cat.moreModels as Json[]) ?? [])];
  const hit = list.find((m) => [m.label, m.id, m.resolvedModel].some((v) => typeof v === "string" && v.toLowerCase().includes(family.toLowerCase())));
  if (!hit || typeof hit.id !== "string") throw new Error("model not available: " + family);
  return hit.id;
}

function startTurn(c: Call, heard: string): Turn {
  const t: Turn = { id: crypto.randomUUID(), user: c.user, conv: c.conv, started: Date.now(), done: false, failed: false, answer: "", callback: false, to: c.from };
  turns.set(t.id, t);
  c.turn = t.id;
  void runTurn(c, t, heard);
  return t;
}

async function runTurn(c: Call, t: Turn, heard: string) {
  try {
    let text = heard;
    const ask = text.match(MODEL_ASK);
    if (ask) {
      c.model = await pickModel(c.user, ask[1]);
      if (c.conv) await sidecar(c.user, "POST", "/app/api/model", { id: c.conv, model: c.model });
      text = ask[2] || "Briefly confirm which model I am speaking with.";
    }
    text = "(phone call) " + text;
    const cid = crypto.randomUUID();
    const turn = { text, voice: true, human: true, cid };
    let streamId = c.conv;
    let sent = c.conv ? await sidecar(c.user, "POST", "/app/api/send", { id: c.conv, ...turn }) : null;
    if (!sent || sent.error) { // no chat yet, or it was closed: start one (resume by id when there is one)
      sent = await sidecar(c.user, "POST", "/app/api/start", { ...turn, ...(c.conv ? { resume: c.conv } : {}), ...(c.user.cwd ? { cwd: c.user.cwd } : {}), ...(c.model ? { model: c.model } : {}) });
      if (!sent || sent.error || typeof sent.id !== "string") throw new Error(String(sent?.error ?? "chat did not start"));
      streamId = sent.id;
    }
    log("turn", t.id.slice(0, 8), c.user.name, JSON.stringify(heard.slice(0, 80)));
    await followTurn(t, streamId as string, cid);
    t.done = true;
    log("done", t.id.slice(0, 8), `${((Date.now() - t.started) / 1000).toFixed(1)}s`, t.callback ? "callback" : "");
    if (t.callback) await placeCallback(t);
  } catch (e) {
    t.failed = t.done = true; // done, so nothing phones back with an empty answer
    log("turn error", t.id.slice(0, 8), String(e));
  }
}
//#endregion

//#region twilio api + voiceprint
async function placeCallback(t: Turn) {
  const body = new URLSearchParams({ To: t.to, From: cfg.from, Url: `${cfg.publicUrl}/twilio/callback?turn=${t.id}`, StatusCallback: `${cfg.publicUrl}/twilio/status` });
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Calls.json`, {
    method: "POST", body, headers: { authorization: "Basic " + btoa(`${SID}:${TOKEN}`) }, signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) log("callback error", r.status, (await r.text()).slice(0, 200));
}

async function speaker(path: string, user: string, audio: Uint8Array, extra: Json = {}): Promise<Json> {
  const r = await fetch(cfg.speakerUrl + path, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ user, audio: Buffer.from(audio).toString("base64"), ...extra }), signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`speaker ${path} ${r.status}`);
  return (await r.json()) as Json;
}

function armedEnrollment(user: string): string | null {
  const f = join(ENROLL_DIR, user);
  if (!existsSync(f)) return null;
  const [until, label] = readFileSync(f, "utf8").trim().split("\t");
  if (Date.now() > Number(until)) { rmSync(f); return null; }
  return label || "phone";
}

/** Push to the user the call belongs to: each sidecar serves /notify for its own devices. */
function notifyUser(user: PhoneUser, title: string, body: string) {
  void fetch(user.sidecar + "/notify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title, body, url: "/_phone/", tag: "phone-refused" }) })
    .catch((e) => log("notify error", String(e)));
}
//#endregion

//#region call flow
type Params = Record<string, string>;
const GOODBYE = () => play(cfg, "goodbye") + HANGUP;
/** Enrolment prompt: the line says sentence i, a tone marks the caller's turn. */
const sayAfterMe = (i: number) => play(cfg, `enroll_p${i + 1}`) + gather(cfg, play(cfg, "tone"), { timeout: 8 }) + GOODBYE();

async function route(path: string, q: URLSearchParams, p: Params): Promise<string> {
  const sid = p.CallSid || "";

  if (path === "/twilio/status") {
    if (["completed", "busy", "failed", "no-answer", "canceled"].includes(p.CallStatus || "")) {
      const c = calls.get(sid);
      const t = c?.turn ? turns.get(c.turn) : undefined;
      if (t && !t.done) t.callback = true; // the caller hung up on a running turn: phone back with the answer
      endCall(sid);
    }
    return twiml();
  }

  if (path === "/twilio/voice") {
    reloadCfg();
    const from = p.From || "", stir = p.StirVerstat || "-";
    const a = admit(cfg, from, stir);
    log("incoming", from, "stir", stir, a.ok ? a.user.name : a.why);
    if (!a.ok) {
      const u = userForCaller(cfg, from);
      if (a.why === "attestation" && u) notifyUser(u, "Phone call refused", `Caller id ${from}, attestation ${stir}`);
      return twiml(play(cfg, "private"), HANGUP);
    }
    const label = armedEnrollment(a.user.name);
    const c: Call = {
      sid, user: a.user, from, conv: null, turn: null, token: crypto.randomUUID(), audio: [], audioBytes: 0,
      verified: false, shortTries: 0, retried: false, pending: null, enroll: label ? { label, done: 0, misses: 0 } : null,
    };
    calls.set(sid, c); byToken.set(c.token, c);
    if (c.enroll) return twiml(startStream(cfg, c.token), play(cfg, "enroll_intro"), sayAfterMe(0));
    return twiml(startStream(cfg, c.token), gather(cfg, play(cfg, "greet")), GOODBYE());
  }

  if (path === "/twilio/callback") {
    const t = turns.get(q.get("turn") || "");
    if (!t) return twiml(play(cfg, "result_in_app"), HANGUP);
    // We dialled the number on file and the answer belongs to a turn that passed the voice check.
    const c: Call = { sid, user: t.user, from: t.to, conv: t.conv, turn: null, token: crypto.randomUUID(), audio: [], audioBytes: 0, verified: false, shortTries: 0, retried: false, pending: null, enroll: null };
    calls.set(sid, c); byToken.set(c.token, c);
    return twiml(startStream(cfg, c.token), play(cfg, "answer_intro"), say(cfg, t.answer), gather(cfg, play(cfg, "anything_else")), GOODBYE());
  }

  const c = calls.get(sid);
  if (!c) return twiml(play(cfg, "lost_track"), HANGUP);

  if (path === "/twilio/heard") {
    const text = (p.SpeechResult || "").trim();
    const audio = takeAudio(c);

    if (c.enroll) {
      // The first accepted sentence of a call replaces that device's earlier voiceprint.
      const r = audio.length ? await speaker("/enroll", c.user.name, audio, { label: c.enroll.label, minMs: cfg.enrollMinMs, reset: c.enroll.done === 0 }) : {};
      const speechMs = Number(r.speechMs) || 0;
      const step = enrollStep(c.enroll, speechMs, cfg.enrollMinMs);
      log("enroll", c.user.name, c.enroll.label, `sentence ${c.enroll.done + 1}`, `${speechMs} ms`, step.kind);
      c.enroll = step.state;
      if (step.kind === "done") {
        rmSync(join(ENROLL_DIR, c.user.name), { force: true });
        return twiml(play(cfg, "chime"), play(cfg, "enroll_done"), HANGUP);
      }
      if (step.kind === "failed") return twiml(play(cfg, "enroll_failed"), HANGUP);
      return twiml(play(cfg, step.kind === "next" ? "chime" : "enroll_again"), sayAfterMe(step.state.done));
    }

    if (!text) return c.conv ? twiml(GOODBYE()) : twiml(gather(cfg, play(cfg, "sorry_catch")), GOODBYE());

    let ask = text;
    if (!c.verified) {
      const r = await speaker("/verify", c.user.name, audio, { call: sid, learnAt: cfg.learnScore, maxSamples: cfg.maxSamples });
      const check: VoiceCheck = { enrolled: r.enrolled === true, score: typeof r.score === "number" ? r.score : null, speechMs: Number(r.speechMs) || 0 };
      const verdict = voiceVerdict(cfg, check);
      const step = voiceStep(verdict, c);
      log("voice", c.user.name, verdict, "score", check.score?.toFixed(3) ?? "-", `${check.speechMs} ms`, r.label ?? "", r.learned ? "learned" : "", step);
      if (step === "say-more") { c.shortTries++; return twiml(gather(cfg, play(cfg, "say_more")), GOODBYE()); }
      if (step === "retry") {
        // One more sample before refusal: the line reads a sentence and the caller repeats it.
        c.retried = true; c.pending = text;
        return twiml(play(cfg, "retry_intro"), play(cfg, "enroll_p1"), gather(cfg, play(cfg, "tone"), { timeout: 8 }), GOODBYE());
      }
      if (step === "refuse") {
        notifyUser(c.user, "Phone call refused", `Voice score ${check.score?.toFixed(2) ?? "none"}`);
        endCall(sid);
        return twiml(play(cfg, verdict === "not-enrolled" ? "not_enrolled" : "not_recognised"), HANGUP);
      }
      c.verified = true;
      if (c.pending) { ask = c.pending; c.pending = null; } // the retry sentence is not the question
    }

    if (isGoodbye(ask)) return twiml(GOODBYE());
    startTurn(c, ask);
    return twiml(play(cfg, "on_it"), redirect("/twilio/wait"));
  }

  if (path === "/twilio/wait") {
    const t = c.turn ? turns.get(c.turn) : undefined;
    if (!t || t.failed) return twiml(play(cfg, "broke"), HANGUP);
    if (t.done) return twiml(say(cfg, t.answer), gather(cfg, "", { timeout: 8 }), GOODBYE());
    const waited = (Date.now() - t.started) / 1000;
    if (waited > cfg.holdSeconds) { t.callback = true; return twiml(play(cfg, "callback_later"), HANGUP); }
    const filler = waited > 20 && Math.floor(waited) % 30 < 2 ? play(cfg, "still_working") : "";
    return twiml(filler, pause(1), redirect("/twilio/wait"));
  }

  return twiml(HANGUP);
}
//#endregion

//#region server
type WsData = { call: Call | null };

if (import.meta.main) {
  if (!SID || !TOKEN) { console.error("TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are required"); process.exit(1); }
  mkdirSync(ENROLL_DIR, { recursive: true });
  if (!existsSync(join(STATE, "config.json"))) writeFileSync(join(STATE, "config.json"), JSON.stringify({ users: [] }, null, 2));

  Bun.serve<WsData, never>({
    hostname: "127.0.0.1", port: cfg.port, idleTimeout: 60,
    async fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/twilio/media") return server.upgrade(req, { data: { call: null } }) ? undefined : new Response("upgrade required", { status: 426 });
      if (req.method === "GET" && url.pathname === "/health") reloadCfg();
      if (req.method === "GET" && url.pathname === "/health") return Response.json({ ok: true, calls: calls.size, users: cfg.users.map((u) => u.name) });
      if (req.method === "GET" && url.pathname.startsWith("/twilio/audio/")) {
        const name = url.pathname.slice("/twilio/audio/".length).replace(/\.wav$/, "");
        const f = Bun.file(join(AUDIO_DIR, name + ".wav"));
        return (name in LINES || TONES.includes(name)) && (await f.exists()) ? new Response(f, { headers: { "content-type": "audio/wav", "cache-control": "public, max-age=86400" } }) : new Response("not found", { status: 404 });
      }
      if (req.method !== "POST" || !url.pathname.startsWith("/twilio/")) return new Response("not found", { status: 404 });
      const p: Params = Object.fromEntries(new URLSearchParams(await req.text()));
      if (!signatureOk(TOKEN, cfg.publicUrl + url.pathname + url.search, p, req.headers.get("x-twilio-signature") || "")) {
        log("bad signature", url.pathname);
        return new Response("forbidden", { status: 403 });
      }
      let body: string;
      try { body = await route(url.pathname, url.searchParams, p); }
      catch (e) { log("error", url.pathname, String(e)); body = twiml(play(cfg, "broke"), HANGUP); }
      return new Response(body, { headers: { "content-type": "text/xml" } });
    },
    websocket: {
      // Twilio media stream: one JSON message per 20 ms of caller audio (mu-law 8 kHz, base64).
      message(ws, raw) {
        const m = JSON.parse(String(raw)) as { event: string; start?: { callSid: string; customParameters?: Record<string, string> }; media?: { track: string; payload: string } };
        if (m.event === "start") {
          const c = byToken.get(m.start?.customParameters?.token || "");
          if (!c || c.sid !== m.start?.callSid) { log("media refused", m.start?.callSid); ws.close(); return; }
          ws.data.call = c;
        } else if (m.event === "media" && ws.data.call && m.media?.track === "inbound") {
          const c = ws.data.call;
          if ((c.verified && !c.enroll) || c.audioBytes >= MAX_AUDIO_BYTES) return; // audio is kept only until the voice check
          const chunk = Buffer.from(m.media.payload, "base64");
          c.audio.push(chunk); c.audioBytes += chunk.length;
        }
      },
    },
  });
  startSetup({
    state: STATE, port: cfg.port + 1, owner: process.env.PHONE_OWNER || "filip",
    guestsTsv: process.env.GUESTS_TSV || "/home/filip/guest-claude/guests.tsv",
    origin: process.env.PHONE_SETUP_ORIGIN || "https://claude.filipkin.com", cfg: () => cfg, reload: reloadCfg,
  });
  log(`listening on 127.0.0.1:${cfg.port}`, `users: ${cfg.users.map((u) => u.name).join(", ") || "none"}`);
}
//#endregion
