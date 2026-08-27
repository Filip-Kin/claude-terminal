// voice.tsx — hands-free, phone-call-style voice mode for the chat app.
//
// Fully server-side speech so it works identically on iOS (no Web Speech API there) and
// Android: the browser records mic audio with MediaRecorder, POSTs it to the NAS Whisper
// service via /app/api/stt -> text; that text becomes a normal chat turn; Claude's reply
// is streamed, chunked by sentence, and each sentence is sent to the NAS Kokoro service
// via /app/api/tts -> audio, played in a queue so Claude starts talking before the whole
// reply is done. After Claude finishes speaking it auto-resumes listening (hands-free);
// if the user starts talking while Claude speaks, playback stops (barge-in).
//
// Self-contained on purpose: the only coupling to main.tsx is the VoiceBridge props
// contract below. All styles are injected from here (kept out of styles.css).
import React, { useEffect, useRef, useState, useCallback } from "react";
import { AskCard, type AskItem } from "./askcard";

// #region bridge contract (how main.tsx wires voice into the live conversation)
export type VoiceAppEvent =
  | { t: "text_delta"; text: string }
  | { t: "text"; text: string }
  | { t: "user"; text: string }
  | { t: "thinking_progress"; tokens: number }
  | { t: "result"; [k: string]: unknown }
  | { t: "busy"; busy: boolean }
  | { t: "error"; message: string }
  | { t: string; [k: string]: unknown };

export interface VoiceBridge {
  // send a user turn into the live/visible conversation (starts one if needed)
  submit: (text: string) => Promise<string | null>;
  // subscribe to the normalized event stream of the visible conversation; returns unsubscribe
  subscribe: (fn: (e: VoiceAppEvent) => void) => () => void;
}
// #endregion

type Phase = "idle" | "listening" | "transcribing" | "thinking" | "speaking" | "error";

// #region speakable text (strip markdown so we don't read syntax or code aloud)
function speakable(md: string): string {
  let s = md;
  s = s.replace(/```[\s\S]*?```/g, " . "); // drop fenced code blocks
  s = s.replace(/`[^`]*`/g, (m) => m.replace(/`/g, "")); // inline code -> its text
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, " "); // images
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1"); // links -> label
  s = s.replace(/^#{1,6}\s+/gm, ""); // headings
  s = s.replace(/^\s*>+\s?/gm, ""); // blockquotes
  s = s.replace(/^\s*[-*+]\s+/gm, ""); // bullet markers
  s = s.replace(/^\s*\d+\.\s+/gm, ""); // numbered markers
  s = s.replace(/(\*\*|__|\*|_|~~)/g, ""); // emphasis
  s = s.replace(/\|/g, " "); // table pipes
  s = s.replace(/[ \t]+/g, " ");
  return s.trim();
}

// Pull complete sentences out of a growing buffer; return [sentences, remainder].
function takeSentences(buf: string): [string[], string] {
  const out: string[] = [];
  let rest = buf;
  // sentence end = . ! ? … possibly with closing quote/paren, followed by space or end
  const re = /([^.!?…]+[.!?…]+["')\]]*)(\s+|$)/g;
  let m: RegExpExecArray | null;
  let lastIdx = 0;
  while ((m = re.exec(rest))) {
    const sent = m[1].trim();
    if (sent) out.push(sent);
    lastIdx = re.lastIndex;
  }
  rest = rest.slice(lastIdx);
  return [out, rest];
}
// #endregion

// #region audio playback queue (Web Audio so barge-in can stop instantly)
class SpeechPlayer {
  private ctx: AudioContext;
  private queue: AudioBuffer[] = [];
  private src: AudioBufferSourceNode | null = null;
  private playing = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  onStart?: () => void;
  onDrain?: () => void;

  constructor(ctx: AudioContext) { this.ctx = ctx; }

  async enqueue(wav: ArrayBuffer) {
    let buf: AudioBuffer;
    try { buf = await this.ctx.decodeAudioData(wav.slice(0)); } catch { return; }
    this.queue.push(buf);
    if (!this.playing) this.playNext();
  }

  private playNext() {
    const buf = this.queue.shift();
    if (!buf) { this.playing = false; this.onDrain?.(); return; }
    const first = !this.playing;
    this.playing = true;
    if (first) this.onStart?.();
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.ctx.destination);
    const advance = () => { if (this.src === src) { this.src = null; if (this.timer) { clearTimeout(this.timer); this.timer = null; } this.playNext(); } };
    src.onended = advance;
    this.src = src;
    try { src.start(); } catch {}
    // safety net: if onended never fires (flaky audio backend), advance after the clip's length
    this.timer = setTimeout(advance, (buf.duration + 0.35) * 1000);
  }

  get isActive() { return this.playing || this.queue.length > 0; }

  stop() {
    this.queue = [];
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.src) { try { this.src.onended = null; this.src.stop(); } catch {} this.src = null; }
    this.playing = false;
  }
}
// #endregion

async function pickMime(): Promise<string> {
  const cands = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/aac", "audio/ogg;codecs=opus"];
  for (const c of cands) { try { if ((window as any).MediaRecorder?.isTypeSupported?.(c)) return c; } catch {} }
  return ""; // let the browser choose (iOS often returns "" -> audio/mp4)
}

export function VoiceMode({ bridge, open, onClose, pendingAsk, onAnswer }: { bridge: VoiceBridge; open: boolean; onClose: () => void; pendingAsk?: AskItem; onAnswer?: (askId: string, answer: string) => void }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [heard, setHeard] = useState(""); // last user transcript
  const [caption, setCaption] = useState(""); // live assistant caption (what's being said)
  const [level, setLevel] = useState(0); // mic level 0..1 for the visualiser
  const [err, setErr] = useState("");

  const phaseRef = useRef<Phase>("idle");
  const setPhaseR = (p: Phase) => { phaseRef.current = p; setPhase(p); };

  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const playerRef = useRef<SpeechPlayer | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const rafRef = useRef<number | null>(null);
  const mimeRef = useRef<string>("");

  // per-turn assistant text buffering for sentence chunking + TTS
  const sentBufRef = useRef("");
  const turnDoneRef = useRef(true);
  const expectedUserRef = useRef<string | null>(null); // text of the turn voice just submitted
  const armedRef = useRef(false); // only speak after our own user turn echoes back (skip replayed/in-flight text)
  const ttsChainRef = useRef<Promise<void>>(Promise.resolve());
  const activeRef = useRef(false); // voice mode active

  const clearRaf = () => { if (rafRef.current != null) cancelAnimationFrame(rafRef.current); rafRef.current = null; };

  // --- teardown everything ---
  const teardown = useCallback(() => {
    activeRef.current = false;
    clearRaf();
    try { recRef.current?.state !== "inactive" && recRef.current?.stop(); } catch {}
    recRef.current = null;
    playerRef.current?.stop();
    try { streamRef.current?.getTracks().forEach((t) => t.stop()); } catch {}
    streamRef.current = null;
    try { ctxRef.current?.close(); } catch {}
    ctxRef.current = null; analyserRef.current = null; playerRef.current = null;
    setPhaseR("idle"); setLevel(0);
  }, []);

  // #region listening + VAD
  const startListening = useCallback(() => {
    if (!activeRef.current) return;
    const stream = streamRef.current, ctx = ctxRef.current, analyser = analyserRef.current;
    if (!stream || !ctx || !analyser) return;
    setHeard(""); setCaption("");
    setPhaseR("listening");

    // fresh recorder capturing the whole listening segment (webm chunks aren't
    // independently decodable, so we stop() to flush one complete clip per utterance)
    chunksRef.current = [];
    let rec: MediaRecorder;
    try { rec = mimeRef.current ? new MediaRecorder(stream, { mimeType: mimeRef.current }) : new MediaRecorder(stream); }
    catch { try { rec = new MediaRecorder(stream); } catch { setErr("recorder unavailable"); setPhaseR("error"); return; } }
    recRef.current = rec;
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunksRef.current.push(e.data); };
    let onstopSend = false;
    rec.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: mimeRef.current || (chunksRef.current[0] as any)?.type || "audio/webm" });
      chunksRef.current = [];
      if (onstopSend && blob.size > 1200) void transcribeAndSubmit(blob);
      else if (activeRef.current && phaseRef.current === "listening") startListening(); // was a silence-only segment: keep listening
    };
    rec.start();

    // VAD via analyser RMS
    const data = new Uint8Array(analyser.fftSize);
    const segStart = performance.now();
    let speech = false, lastVoice = segStart, floor = 0.015, floorN = 0;
    const SIL_MS = 1100, MAX_UTTER_MS = 20000, MAX_IDLE_MS = 30000;

    const tick = () => {
      if (!activeRef.current || phaseRef.current !== "listening") return;
      analyser.getByteTimeDomainData(data);
      let sum = 0; for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sum += v * v; }
      const rms = Math.sqrt(sum / data.length);
      setLevel(Math.min(1, rms * 6));
      const now = performance.now();
      if (floorN < 12) { floor = (floor * floorN + rms) / (floorN + 1); floorN++; } // ambient calibration
      const thr = Math.max(0.05, floor * 2.2);
      if (rms > thr) { if (!speech) speech = true; lastVoice = now; }
      const finish = (send: boolean) => { onstopSend = send; clearRaf(); if (send) setPhaseR("transcribing"); try { rec.stop(); } catch {} };
      if (speech && now - lastVoice > SIL_MS) return finish(true);
      if (speech && now - segStart > MAX_UTTER_MS) return finish(true);
      if (!speech && now - segStart > MAX_IDLE_MS) return finish(false); // restart segment, drop buffer
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, []);
  // #endregion

  // #region STT -> submit turn
  const transcribeAndSubmit = useCallback(async (blob: Blob) => {
    setPhaseR("transcribing");
    const ext = (mimeRef.current.includes("mp4") || mimeRef.current.includes("aac")) ? "mp4" : mimeRef.current.includes("ogg") ? "ogg" : "webm";
    const fd = new FormData();
    fd.append("file", blob, `utt.${ext}`);
    let text = "";
    try {
      const r = await fetch("/app/api/stt", { method: "POST", body: fd });
      const d = await r.json();
      text = (d?.text || "").trim();
    } catch { /* network */ }
    if (!activeRef.current) return;
    if (!text) { startListening(); return; } // heard nothing usable -> keep listening
    setHeard(text);
    // begin a fresh assistant turn — disarm until our own user turn echoes back, so any
    // replayed history or an in-flight previous reply isn't spoken as this turn.
    sentBufRef.current = ""; turnDoneRef.current = false; setCaption("");
    expectedUserRef.current = text; armedRef.current = false;
    setPhaseR("thinking");
    try { await bridge.submit(text); } catch { setErr("send failed"); setPhaseR("error"); }
  }, [bridge, startListening]);
  // #endregion

  // #region TTS
  const speakSentence = useCallback((sentence: string) => {
    const clean = speakable(sentence);
    if (!clean || !/[a-z0-9]/i.test(clean)) return;
    // serialise TTS fetches so audio enqueues in sentence order
    ttsChainRef.current = ttsChainRef.current.then(async () => {
      if (!activeRef.current) return;
      try {
        const r = await fetch("/app/api/tts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: clean }) });
        if (!r.ok) return;
        const buf = await r.arrayBuffer();
        if (!activeRef.current) return;
        await playerRef.current?.enqueue(buf);
      } catch { /* ignore a failed sentence */ }
    });
  }, []);
  // #endregion

  // #region consume the conversation event stream while voice mode is open
  useEffect(() => {
    if (!open) return;
    const unsub = bridge.subscribe((e) => {
      if (!activeRef.current) return;
      if (e.t === "user") {
        // arm only when OUR submitted turn echoes back; ignore other/replayed user turns
        if (!armedRef.current && expectedUserRef.current != null && (e as any).text === expectedUserRef.current) {
          armedRef.current = true; sentBufRef.current = ""; setCaption("");
        }
        return;
      }
      if (!armedRef.current) return; // pre-arm: skip replayed history / in-flight prior reply
      if (e.t === "text_delta" || e.t === "text") {
        const t = (e as any).text || "";
        if (!t) return;
        setCaption((c) => (c + t).slice(-600));
        sentBufRef.current += t;
        const [sents, rest] = takeSentences(sentBufRef.current);
        sentBufRef.current = rest;
        for (const s of sents) speakSentence(s);
      } else if (e.t === "result" || (e.t === "busy" && (e as any).busy === false)) {
        // turn complete: flush any trailing partial sentence
        if (!turnDoneRef.current) {
          turnDoneRef.current = true;
          const tail = sentBufRef.current.trim(); sentBufRef.current = "";
          if (tail) speakSentence(tail);
        }
      } else if (e.t === "error") {
        setErr((e as any).message || "error");
      }
    });
    return unsub;
  }, [open, bridge, speakSentence]);
  // #endregion

  // #region barge-in + hands-free loop (drives phase transitions off playback state)
  useEffect(() => {
    if (!open) return;
    let raf = 0;
    const data = new Uint8Array(2048);
    let loud = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const analyser = analyserRef.current, player = playerRef.current;
      if (!analyser || !player) return;
      const speakingOrThinking = phaseRef.current === "speaking" || phaseRef.current === "thinking";
      // move thinking -> speaking once audio actually starts
      if (phaseRef.current === "thinking" && player.isActive) setPhaseR("speaking");
      // hands-free: assistant done + audio drained -> listen again
      if (phaseRef.current === "speaking" && turnDoneRef.current && !player.isActive) { startListening(); return; }
      if (!speakingOrThinking) return;
      // barge-in detection (higher bar than listening; echoCancellation removes most TTS bleed)
      analyser.getByteTimeDomainData(data);
      let sum = 0; for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sum += v * v; }
      const rms = Math.sqrt(sum / data.length);
      setLevel(Math.min(1, rms * 6));
      if (rms > 0.12) { loud++; } else { loud = Math.max(0, loud - 1); }
      if (loud > 8 && player.isActive) { // sustained user speech over the TTS
        player.stop(); ttsChainRef.current = Promise.resolve(); turnDoneRef.current = true; loud = 0;
        startListening();
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [open, startListening]);
  // #endregion

  // #region open/close lifecycle
  useEffect(() => {
    if (!open) { teardown(); return; }
    let cancelled = false;
    (async () => {
      setErr("");
      try {
        mimeRef.current = await pickMime();
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        const AC: typeof AudioContext = (window as any).AudioContext || (window as any).webkitAudioContext;
        const ctx = new AC();
        try { await ctx.resume(); } catch {}
        ctxRef.current = ctx;
        const src = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 2048; analyser.smoothingTimeConstant = 0.3;
        src.connect(analyser);
        analyserRef.current = analyser;
        const player = new SpeechPlayer(ctx);
        playerRef.current = player;
        activeRef.current = true;
        startListening();
      } catch (e: any) {
        if (cancelled) return;
        setErr(e?.name === "NotAllowedError" ? "microphone permission denied" : "could not start audio: " + (e?.message || e));
        setPhaseR("error");
      }
    })();
    return () => { cancelled = true; teardown(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  // #endregion

  useEffect(() => { injectVoiceCss(); }, []);

  if (!open) return null;
  const label = phase === "listening" ? "Listening…" : phase === "transcribing" ? "…" : phase === "thinking" ? "Thinking…" : phase === "speaking" ? "Speaking…" : phase === "error" ? "Problem" : "";
  return (
    <div className="voice-overlay" role="dialog" aria-label="Voice mode">
      <div className="voice-top">
        <span className="voice-badge">Voice</span>
        <button className="voice-x" onClick={onClose} aria-label="Exit voice mode">Done</button>
      </div>
      <div className="voice-center">
        <div className={"voice-orb voice-" + phase}>
          <span className="vo-ring vo-ring1" />
          <span className="vo-ring vo-ring2" />
          <div className="voice-orb-blob" style={{ transform: `scale(${1 + (phase === "listening" ? level * 0.5 : phase === "speaking" ? 0.14 : 0)})` }}>
            <span className="vo-sheen" />
            <span className="vo-gloss" />
          </div>
        </div>
        <div className="voice-state">{label}</div>
        {err ? <div className="voice-err">{err}</div> : null}
      </div>
      {pendingAsk && onAnswer ? (
        <div className="voice-ask"><AskCard it={pendingAsk} onAnswer={onAnswer} /></div>
      ) : null}
      <div className="voice-transcript">
        {heard ? <div className="voice-heard"><span>You</span>{heard}</div> : null}
        {caption ? <div className="voice-said"><span>Claude</span>{caption}</div> : null}
      </div>
      <div className="voice-controls">
        {(phase === "speaking" || phase === "thinking") && (
          <button className="voice-skip" onClick={() => { playerRef.current?.stop(); ttsChainRef.current = Promise.resolve(); turnDoneRef.current = true; startListening(); }}>Interrupt</button>
        )}
      </div>
    </div>
  );
}

// #region injected styles (kept out of styles.css so voice is a drop-in module)
let cssDone = false;
function injectVoiceCss() {
  if (cssDone) return; cssDone = true;
  const css = `
  .voice-overlay{position:fixed;inset:0;z-index:60;display:flex;flex-direction:column;background:radial-gradient(120% 90% at 50% 12%,#1c1c22 0%,#0d0d10 62%);color:#ececf1;padding:env(safe-area-inset-top) 16px 24px;overflow:hidden}
  .voice-top{display:flex;align-items:center;justify-content:space-between;padding:14px 4px 0}
  .voice-badge{font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#8f8fa3;font-weight:600}
  .voice-x{background:rgba(255,255,255,.08);border:none;color:#ececf1;border-radius:999px;padding:8px 16px;font-size:14px;font-weight:600;cursor:pointer}
  .voice-x:active{background:rgba(255,255,255,.16)}
  .voice-center{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:26px}
  /* --- morphing voice orb: an organic blob that morphs shape + spins an inner sheen,
        reacts to mic level (scale) and state (colour), with ripple rings while listening --- */
  .voice-orb{position:relative;width:188px;height:188px;display:flex;align-items:center;justify-content:center;--vo-a:#d97757;--vo-b:#b95e42;--vo-glow:rgba(217,119,87,.55)}
  .voice-listening{--vo-a:#5b8cff;--vo-b:#3f6ad8;--vo-glow:rgba(91,140,255,.55)}
  .voice-thinking{--vo-a:#f5b64a;--vo-b:#e0912a;--vo-glow:rgba(245,182,74,.5)}
  .voice-transcribing{--vo-a:#8b8bf0;--vo-b:#6a6ad8;--vo-glow:rgba(139,139,240,.5)}
  .voice-orb-blob{position:relative;width:130px;height:130px;overflow:hidden;background:linear-gradient(150deg,var(--vo-a),var(--vo-b));box-shadow:0 0 60px var(--vo-glow),inset 0 6px 22px rgba(255,255,255,.18),inset 0 -10px 26px rgba(0,0,0,.28);transition:transform .1s ease-out,box-shadow .3s,background .4s;will-change:transform,border-radius;border-radius:42% 58% 57% 43% / 53% 44% 56% 47%;animation:blobMorph 7s ease-in-out infinite}
  .vo-sheen{position:absolute;inset:-40%;background:conic-gradient(from 0deg,transparent 0deg,rgba(255,255,255,.28) 70deg,transparent 150deg,rgba(255,255,255,.16) 250deg,transparent 330deg);animation:blobSpin 6s linear infinite;opacity:.7}
  .vo-gloss{position:absolute;left:22%;top:14%;width:42%;height:34%;border-radius:50%;background:radial-gradient(circle at 40% 40%,rgba(255,255,255,.55),transparent 70%);filter:blur(2px)}
  .vo-ring{position:absolute;width:130px;height:130px;border-radius:50%;border:2px solid var(--vo-glow);opacity:0}
  .voice-listening .vo-ring1{animation:voRipple 1.9s ease-out infinite}
  .voice-listening .vo-ring2{animation:voRipple 1.9s ease-out infinite .95s}
  .voice-thinking .voice-orb-blob{animation:blobMorph 3.2s ease-in-out infinite,voBreathe 1.4s ease-in-out infinite}
  .voice-speaking .voice-orb-blob{animation:blobMorph 2.4s ease-in-out infinite,voBeat 1s ease-in-out infinite}
  .voice-speaking .vo-sheen{animation-duration:2.4s}
  .voice-transcribing .voice-orb-blob{animation:blobMorph 2s ease-in-out infinite}
  @keyframes blobMorph{0%,100%{border-radius:42% 58% 57% 43% / 53% 44% 56% 47%}33%{border-radius:62% 38% 44% 56% / 46% 60% 40% 54%}66%{border-radius:45% 55% 64% 36% / 62% 42% 58% 38%}}
  @keyframes blobSpin{to{transform:rotate(360deg)}}
  @keyframes voRipple{0%{opacity:.55;transform:scale(.85)}100%{opacity:0;transform:scale(1.55)}}
  @keyframes voBreathe{0%,100%{box-shadow:0 0 40px var(--vo-glow),inset 0 6px 22px rgba(255,255,255,.18),inset 0 -10px 26px rgba(0,0,0,.28)}50%{box-shadow:0 0 78px var(--vo-glow),inset 0 6px 22px rgba(255,255,255,.22),inset 0 -10px 26px rgba(0,0,0,.28)}}
  @keyframes voBeat{0%,100%{box-shadow:0 0 46px var(--vo-glow),inset 0 6px 22px rgba(255,255,255,.2),inset 0 -10px 26px rgba(0,0,0,.28)}50%{box-shadow:0 0 92px var(--vo-glow),inset 0 8px 26px rgba(255,255,255,.28),inset 0 -10px 26px rgba(0,0,0,.28)}}
  @media (prefers-reduced-motion:reduce){.voice-orb-blob,.vo-sheen,.vo-ring{animation:none!important}}
  .voice-state{font-size:19px;font-weight:600;color:#c9c9d6;min-height:24px}
  .voice-err{font-size:14px;color:#ff8f8f;max-width:320px;text-align:center}
  .voice-transcript{max-height:34vh;overflow-y:auto;display:flex;flex-direction:column;gap:12px;padding:0 6px 8px;-webkit-overflow-scrolling:touch}
  .voice-heard,.voice-said{font-size:16px;line-height:1.5;border-radius:14px;padding:12px 14px}
  .voice-heard{background:rgba(91,140,255,.14);align-self:flex-end;max-width:88%}
  .voice-said{background:rgba(255,255,255,.05);align-self:flex-start;max-width:92%;color:#dcdce6}
  .voice-heard span,.voice-said span{display:block;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#8f8fa3;margin-bottom:4px;font-weight:600}
  .voice-ask{width:100%;max-width:640px;margin:0 auto 8px;padding:0 6px}
  .voice-controls{display:flex;justify-content:center;min-height:52px;align-items:center}
  .voice-skip{background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.12);color:#ececf1;border-radius:999px;padding:12px 26px;font-size:15px;font-weight:600;cursor:pointer}
  .voice-skip:active{background:rgba(255,255,255,.16)}
  @media (min-width:720px){.voice-transcript{max-width:640px;margin:0 auto;width:100%}}
  /* composer mic button: static (no constant animation); the icon just reacts on tap */
  .voice-open-btn{position:relative;transform-origin:center}
  .voice-open-btn svg{transition:transform .12s ease}
  .voice-open-btn:active svg{transform:scale(.9)}
  `;
  const el = document.createElement("style"); el.id = "voice-css"; el.textContent = css; document.head.appendChild(el);
}
// #endregion
