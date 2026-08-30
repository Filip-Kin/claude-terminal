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

// How long a completed sentence waits to see whether a tool call follows it, in "skip the running
// commentary" mode. content_block_start for the tool arrives within a few tens of ms of the text
// ending, so this only has to cover the gap; it is also the extra delay on first audio.
const HOLD_MS = 350;
// If the user echo never comes back (a decorated turn, a backend restart), arm anyway rather than
// sitting silent in "thinking" forever with the answer already on screen.
const ARM_FALLBACK_MS = 4000;

// The backend appends a hidden <voice-mode> directive to voice turns, so the echoed user event never
// equals the text we submitted. Strip it before comparing.
function stripVoiceDirective(t: string): string {
  return (t || "").replace(/\s*<voice-mode>[\s\S]*?<\/voice-mode>\s*$/, "").trim();
}

// #region speakable text (strip markdown so we don't read syntax or code aloud)
// Numbers 0-59 as words, for reading clock times naturally (Kokoro mangles "5:30 PM" into
// "five ... thirty"). "5:30 PM" -> "five thirty P M", "5:00" -> "five o'clock", "5:05" -> "five oh five".
const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty"];
function numWords(n: number): string {
  if (n < 20) return ONES[n];
  const t = TENS[Math.floor(n / 10)] || "";
  const o = n % 10;
  return o ? `${t} ${ONES[o]}` : t;
}
function normalizeTimes(s: string): string {
  return s.replace(/\b(\d{1,2}):(\d{2})\s*([ap])\.?\s?m\.?/gi, (_m, h, mm, ap) => {
    const H = parseInt(h, 10), M = parseInt(mm, 10);
    const minute = M === 0 ? "" : M < 10 ? ` oh ${ONES[M]}` : ` ${numWords(M)}`;
    return `${numWords(H)}${minute} ${ap.toLowerCase() === "a" ? "A M" : "P M"}`;
  }).replace(/\b(\d{1,2}):(\d{2})\b/g, (_m, h, mm) => {
    const H = parseInt(h, 10), M = parseInt(mm, 10);
    if (H > 23 || M > 59) return `${h}:${mm}`; // not a clock time, leave it
    if (M === 0) return `${numWords(H)} o'clock`;
    return `${numWords(H)}${M < 10 ? ` oh ${ONES[M]}` : ` ${numWords(M)}`}`;
  });
}

function speakable(md: string): string {
  let s = normalizeTimes(md);
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
export class SpeechPlayer implements TtsPlayer {
  private ctx: AudioContext;
  private out: AudioNode;
  private queue: AudioBuffer[] = [];
  private src: AudioBufferSourceNode | null = null;
  private playing = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  onStart?: () => void;
  onDrain?: () => void;

  // `out` lets voice mode route playback through a MediaStream destination + <audio> element so the
  // OS treats it as media (louder in the car, ducks/pauses other apps). Defaults to the speakers.
  constructor(ctx: AudioContext, out?: AudioNode) { this.ctx = ctx; this.out = out || ctx.destination; }

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
    src.connect(this.out);
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

// #region shared player interface
// Both playback engines below satisfy this, so the TTS core + read-aloud + voice mode drive either
// one identically: SpeechPlayer (Web Audio, instant barge-in) or ElementPlayer (a real media element).
export interface TtsPlayer {
  enqueue(wav: ArrayBuffer): Promise<void>;
  stop(): void;
  readonly isActive: boolean;
  onStart?: () => void;
  onDrain?: () => void;
  prime?: () => void; // unlock element playback within a user gesture (no-op for Web Audio)
}
// #endregion

// #region element playback (true media: loud + takes audio focus, ducks/pauses other apps)
// Plays a queue of TTS clips through ONE HTMLAudioElement fed real blob URLs. Web Audio (SpeechPlayer)
// is routed by iOS to the quiet, mixable "ambient" category — it plays UNDER the user's music and
// never takes audio focus, which is exactly the "too quiet, didn't pause my music in the car" report.
// A media element playing actual file data is treated as MEDIA instead: it plays at media volume on
// the car speakers, takes audio focus, and pauses/ducks other apps. MediaSession metadata makes the
// OS show it as now-playing (lock screen / car head unit). prime() MUST be called inside a user
// gesture (the tap that started read-aloud or voice) so a later play() isn't blocked by autoplay policy.
// INHERENT iOS PWA LIMIT: Safari can't fully deactivate the audio session, so other apps' audio resumes
// on its own timing after we stop; and while a mic is live (always-on voice) the session is forced to
// the call type and a media element can't override it — hence always-on stays on Web Audio.

// A ~0.05s 8-bit silent WAV, used to "unlock" the media element during a user gesture on iOS.
function silentWavUrl(): string {
  const rate = 8000, n = 400, size = 44 + n;
  const b = new ArrayBuffer(size), v = new DataView(b);
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); v.setUint32(4, 36 + n, true); w(8, "WAVE"); w(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
  w(36, "data"); v.setUint32(40, n, true);
  for (let i = 0; i < n; i++) v.setUint8(44 + i, 128); // 8-bit silence
  return URL.createObjectURL(new Blob([b], { type: "audio/wav" }));
}

export class ElementPlayer implements TtsPlayer {
  private el: HTMLAudioElement;
  private queue: string[] = []; // pending object URLs
  private current: string | null = null; // URL now loaded on the element
  private playing = false;
  private started = false; // onStart (first real audio) fired yet?
  onStart?: () => void;
  onDrain?: () => void;

  constructor() {
    this.el = new Audio();
    (this.el as unknown as { playsInline: boolean }).playsInline = true;
    this.el.preload = "auto";
    // onStart = the moment audio actually starts (used to clear the "generating voice…" indicator).
    this.el.onplaying = () => { if (!this.started) { this.started = true; this.onStart?.(); } };
    try { if ("mediaSession" in navigator && "MediaMetadata" in window) navigator.mediaSession.metadata = new MediaMetadata({ title: "Claude", artist: "skuno voice" }); } catch { /* */ }
    try { if ("mediaSession" in navigator) navigator.mediaSession.setActionHandler?.("pause", () => this.stop()); } catch { /* */ }
    try { if ("mediaSession" in navigator) navigator.mediaSession.setActionHandler?.("stop", () => this.stop()); } catch { /* */ }
  }

  // iOS 16.4+: declare a media (playback) audio session so output is loud on the speakers and takes
  // audio focus (pauses/ducks other apps), rather than the quiet mixable Web-Audio default.
  private claimSession() {
    try { const as = (navigator as unknown as { audioSession?: { type: string } }).audioSession; if (as) as.type = "playback"; } catch { /* */ }
  }

  // Unlock the element (play a silent clip) during a user gesture so a later play() isn't blocked by
  // autoplay policy, and claim the media session. Safe to call more than once.
  prime() {
    this.claimSession();
    try { this.el.onended = null; this.el.onerror = null; this.el.src = silentWavUrl(); const p = this.el.play(); if (p) p.catch(() => {}); } catch { /* */ }
  }

  async enqueue(wav: ArrayBuffer) {
    const url = URL.createObjectURL(new Blob([wav], { type: "audio/wav" }));
    this.queue.push(url);
    if (!this.playing) this.playNext();
  }

  private playNext() {
    const url = this.queue.shift();
    if (!url) { this.playing = false; if (this.current) { URL.revokeObjectURL(this.current); this.current = null; } this.onDrain?.(); return; }
    if (!this.playing) this.claimSession(); // starting from idle (a mic turn may have flipped the session to record)
    this.playing = true;
    if (this.current) URL.revokeObjectURL(this.current);
    this.current = url;
    let advanced = false;
    const go = () => { if (advanced) return; advanced = true; this.playNext(); }; // advance once per clip, whatever fires first
    this.el.onended = go;
    this.el.onerror = go;
    try {
      this.el.src = url;
      try { if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing"; } catch { /* */ }
      const p = this.el.play();
      if (p) p.catch(() => go()); // autoplay blocked / decode error -> skip so the queue can't stall
    } catch { go(); }
  }

  get isActive() { return this.playing || this.queue.length > 0; }

  stop() {
    for (const u of this.queue) URL.revokeObjectURL(u);
    this.queue = [];
    this.el.onended = null; this.el.onerror = null;
    try { this.el.pause(); } catch { /* */ }
    if (this.current) { URL.revokeObjectURL(this.current); this.current = null; }
    try { this.el.removeAttribute("src"); this.el.load(); } catch { /* */ }
    try { if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "none"; } catch { /* */ }
    this.playing = false;
    this.started = false; // next playback reports first-audio again (reused player, e.g. tap-to-talk)
  }
}
// #endregion

// #region shared TTS core (one sentence -> Kokoro -> SpeechPlayer)
// The single fetch+enqueue step behind BOTH hands-free voice mode and one-shot read-aloud, so they
// use the identical server pipeline. Returns false only on a real TTS failure (so read-aloud can
// fall back to the browser voice); a skipped empty/punctuation sentence counts as success.
export async function ttsSpeakInto(player: TtsPlayer, sentence: string, isActive: () => boolean, voice?: string): Promise<boolean> {
  const clean = speakable(sentence);
  if (!clean || !/[a-z0-9]/i.test(clean)) return true;
  if (!isActive()) return true;
  try {
    const r = await fetch("/app/api/tts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(voice ? { text: clean, voice } : { text: clean }) });
    if (!r.ok) return false;
    const buf = await r.arrayBuffer();
    if (!isActive()) return true;
    await player.enqueue(buf);
    return true;
  } catch { return false; }
}
// #endregion

// #region one-shot read-aloud (long-press a message -> hear it)
// Reads a single message on demand, independent of hands-free voice mode. Prefers the same NAS
// Kokoro voice as voice mode (useServerTts) so it matches; falls back to the browser's built-in
// speechSynthesis (works offline / when the TTS sidecar is absent, e.g. iOS has SpeechSynthesis).
// Only one read-aloud runs at a time — starting a new one (or calling stopReadAloud) stops the last.
let raStop: (() => void) | null = null;
let raOnEnd: (() => void) | null = null;
export function stopReadAloud() { const s = raStop; raStop = null; const cb = raOnEnd; raOnEnd = null; if (s) s(); if (cb) cb(); }

function synthSpeak(text: string, onEnd?: () => void, onStart?: () => void) {
  try {
    const synth = window.speechSynthesis;
    if (!synth) { onEnd?.(); return; }
    synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.onstart = () => { onStart?.(); };
    u.onend = () => { if (raStop) { raStop = null; raOnEnd = null; onEnd?.(); } };
    u.onerror = u.onend;
    raStop = () => { try { u.onstart = null; u.onend = null; u.onerror = null; synth.cancel(); } catch {} };
    raOnEnd = onEnd || null;
    synth.speak(u);
  } catch { onEnd?.(); }
}

export function readAloud(raw: string, opts?: { useServerTts?: boolean; voice?: string; onStart?: () => void; onEnd?: () => void }): void {
  stopReadAloud();
  const clean = speakable(raw).trim();
  if (!clean) { opts?.onEnd?.(); return; }
  const onEnd = opts?.onEnd;
  if (!opts?.useServerTts) { synthSpeak(clean, onEnd, opts?.onStart); return; }
  // Server TTS path: chunk by sentence, fetch each, and play through a real media element so the OS
  // treats it as MEDIA (loud on the car speakers, ducks/pauses the user's music) instead of quiet Web
  // Audio. Playback starts on the first sentence rather than waiting for the whole message.
  let cancelled = false;
  let started = false;    // at least one sentence produced audio
  let enqueuedAll = false; // every sentence has been fetched + enqueued (guards against a premature drain)
  const player = new ElementPlayer();
  player.prime(); // this runs inside the tap that opened the menu -> unlock playback + claim media focus
  const done = () => { if (cancelled) return; cancelled = true; player.stop(); if (raStop) { raStop = null; raOnEnd = null; onEnd?.(); } };
  player.onStart = () => { if (!cancelled) opts?.onStart?.(); }; // first audio actually playing
  // Finish only once the whole message has been enqueued AND the queue has fully drained, so a short
  // sentence finishing before the next fetch returns can't cut the read-aloud short.
  player.onDrain = () => { if (enqueuedAll && started) done(); };
  raStop = () => { cancelled = true; player.stop(); };
  raOnEnd = onEnd || null;
  const sentences = clean.match(/\s*[^.!?…]+[.!?…]*/g) || [clean];
  void (async () => {
    for (const s of sentences) {
      if (cancelled) return;
      const t = s.trim();
      if (!t) continue;
      const ok = await ttsSpeakInto(player, t, () => !cancelled, opts?.voice); // same pipeline as voice mode
      if (cancelled) return;
      if (!ok) {
        // TTS sidecar unreachable (offline / not configured) -> finish with the browser voice
        if (!started) { player.stop(); synthSpeak(clean, onEnd, opts?.onStart); }
        return;
      }
      started = true;
    }
    enqueuedAll = true;
    if (started && !cancelled && !player.isActive) done(); // already drained before the last enqueue landed
  })();
}
// #endregion

async function pickMime(): Promise<string> {
  const cands = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/aac", "audio/ogg;codecs=opus"];
  for (const c of cands) { try { if ((window as any).MediaRecorder?.isTypeSupported?.(c)) return c; } catch {} }
  return ""; // let the browser choose (iOS often returns "" -> audio/mp4)
}

export function VoiceMode({ bridge, open, onClose, pendingAsk, onAnswer, speakFinalOnly, ttsVoice, tapToTalk }: { bridge: VoiceBridge; open: boolean; onClose: () => void; pendingAsk?: AskItem; onAnswer?: (askId: string, answer: string) => void; speakFinalOnly?: boolean; ttsVoice?: string; tapToTalk?: boolean }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [heard, setHeard] = useState(""); // last user transcript
  const [caption, setCaption] = useState(""); // live assistant caption (what's being said)
  const [level, setLevel] = useState(0); // mic level 0..1 for the visualiser
  const [err, setErr] = useState("");

  const phaseRef = useRef<Phase>("idle");
  const setPhaseR = (p: Phase) => { phaseRef.current = p; setPhase(p); };
  const speakFinalRef = useRef(!!speakFinalOnly); // read latest inside the stable subscribe closure
  useEffect(() => { speakFinalRef.current = !!speakFinalOnly; }, [speakFinalOnly]);
  const ttsVoiceRef = useRef(ttsVoice); // latest chosen Kokoro voice for the stable speakSentence closure
  useEffect(() => { ttsVoiceRef.current = ttsVoice; }, [ttsVoice]);
  // Tap-to-talk: mic is opened only while the user is actually speaking (one tap per turn), released
  // the rest of the time. That keeps the phone off the call-type audio session between turns, so the
  // car stays on media (A2DP) — playback is loud and the music can duck/resume, unlike always-on mode.
  const pttRef = useRef(!!tapToTalk);
  useEffect(() => { pttRef.current = !!tapToTalk; }, [tapToTalk]);

  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const srcNodeRef = useRef<MediaStreamAudioSourceNode | null>(null); // mic source, so tap-to-talk can disconnect it between turns
  const onstopSendRef = useRef(false); // whether the current recording should be transcribed (vs a silence-only segment)
  const playerRef = useRef<TtsPlayer | null>(null);
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
  const submitAtRef = useRef(0);   // when we last handed a turn to the bridge (arming watchdog)
  const spokeRef = useRef(false);  // did this turn produce any speech at all
  // "Skip the running commentary" mode: complete sentences wait here briefly. A tool_start inside the
  // hold window means that text was narration ("I'll check the config...") and gets dropped; nothing
  // follows it means it is the real answer, so it is spoken. This keeps the mode quiet during tool work
  // WITHOUT waiting for the whole reply to finish before saying a word.
  const holdRef = useRef<string[]>([]);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const turnDoneAtRef = useRef(0);   // when the turn finished (silence watchdog)
  const ttsPendingRef = useRef(0);   // TTS fetches in flight, so the watchdog waits for real silence

  const clearRaf = () => { if (rafRef.current != null) cancelAnimationFrame(rafRef.current); rafRef.current = null; };

  // --- teardown everything ---
  const teardown = useCallback(() => {
    activeRef.current = false;
    clearRaf();
    try { recRef.current?.state !== "inactive" && recRef.current?.stop(); } catch {}
    recRef.current = null;
    playerRef.current?.stop();
    try { srcNodeRef.current?.disconnect(); } catch {}
    srcNodeRef.current = null;
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
    onstopSendRef.current = false;
    rec.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: mimeRef.current || (chunksRef.current[0] as any)?.type || "audio/webm" });
      chunksRef.current = [];
      if (onstopSendRef.current && blob.size > 1200) void transcribeAndSubmit(blob);
      else if (pttRef.current) { releaseMic(); setPhaseR("idle"); } // tap-to-talk: no speech -> wait for the next tap
      else if (activeRef.current && phaseRef.current === "listening") startListening(); // continuous: was a silence-only segment, keep listening
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
      const finish = (send: boolean) => { onstopSendRef.current = send; clearRaf(); if (send) setPhaseR("transcribing"); try { rec.stop(); } catch {} };
      if (speech && now - lastVoice > SIL_MS) return finish(true);
      if (speech && now - segStart > MAX_UTTER_MS) return finish(true);
      if (!speech && now - segStart > MAX_IDLE_MS) return finish(false); // restart segment, drop buffer
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  // Close the mic between turns (tap-to-talk) so the phone drops the call-type audio session.
  const releaseMic = useCallback(() => {
    clearRaf();
    try { recRef.current?.state !== "inactive" && recRef.current?.stop(); } catch {}
    recRef.current = null;
    try { srcNodeRef.current?.disconnect(); } catch {}
    srcNodeRef.current = null;
    try { streamRef.current?.getTracks().forEach((t) => t.stop()); } catch {}
    streamRef.current = null; analyserRef.current = null;
    setLevel(0);
  }, []);

  // Tap-to-talk button: idle -> open the mic + start a listening segment; while listening -> a second
  // tap force-sends what's captured. Acquires the mic on demand instead of holding it open.
  const pttTap = useCallback(async () => {
    if (!activeRef.current) return;
    // This tap is a real user gesture -> unlock the media element now so a later TTS play() (which
    // happens after STT + thinking, outside any gesture) isn't blocked by iOS autoplay policy.
    playerRef.current?.prime?.();
    if (phaseRef.current === "listening") { clearRaf(); onstopSendRef.current = true; setPhaseR("transcribing"); try { recRef.current?.stop(); } catch {} return; }
    if (phaseRef.current === "speaking" || phaseRef.current === "thinking") { playerRef.current?.stop(); ttsChainRef.current = Promise.resolve(); turnDoneRef.current = true; }
    const ctx = ctxRef.current; if (!ctx) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (!activeRef.current) { stream.getTracks().forEach((t) => t.stop()); return; }
      streamRef.current = stream;
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048; analyser.smoothingTimeConstant = 0.3;
      src.connect(analyser);
      srcNodeRef.current = src; analyserRef.current = analyser;
      try { await ctx.resume(); } catch { /* */ }
      startListening();
    } catch (e: any) {
      setErr(e?.name === "NotAllowedError" ? "microphone permission denied" : "mic error: " + (e?.message || e));
      setPhaseR("idle");
    }
  }, [startListening]);
  // #endregion

  // #region STT -> submit turn
  const transcribeAndSubmit = useCallback(async (blob: Blob) => {
    setPhaseR("transcribing");
    if (pttRef.current) releaseMic(); // tap-to-talk: close the mic now so playback is media (loud, music can duck)
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
    submitAtRef.current = Date.now(); spokeRef.current = false;
    holdRef.current = []; if (holdTimerRef.current) { clearTimeout(holdTimerRef.current); holdTimerRef.current = null; }
    setPhaseR("thinking");
    try { await bridge.submit(text); } catch { setErr("send failed"); setPhaseR("error"); }
  }, [bridge, startListening]);
  // #endregion

  // #region TTS
  const speakSentence = useCallback((sentence: string) => {
    const player = playerRef.current;
    if (!player) return;
    spokeRef.current = true;
    ttsPendingRef.current++;
    // serialise TTS fetches so audio enqueues in sentence order — same core as one-shot read-aloud
    ttsChainRef.current = ttsChainRef.current
      .then(() => ttsSpeakInto(player, sentence, () => activeRef.current, ttsVoiceRef.current))
      .then(() => { ttsPendingRef.current = Math.max(0, ttsPendingRef.current - 1); });
  }, []);

  // Release everything sitting in the narration hold buffer (nothing followed it -> it was the answer).
  const flushHold = useCallback(() => {
    if (holdTimerRef.current) { clearTimeout(holdTimerRef.current); holdTimerRef.current = null; }
    const held = holdRef.current; holdRef.current = [];
    for (const s of held) speakSentence(s);
  }, [speakSentence]);

  // Queue a sentence under the hold window; each new sentence extends it, so a burst of final-answer
  // sentences is released together the moment the model pauses without calling a tool.
  const holdSentence = useCallback((sentence: string) => {
    holdRef.current.push(sentence);
    if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
    holdTimerRef.current = setTimeout(() => { holdTimerRef.current = null; flushHold(); }, HOLD_MS);
  }, [flushHold]);
  // #endregion

  // #region consume the conversation event stream while voice mode is open
  useEffect(() => {
    if (!open) return;
    const unsub = bridge.subscribe((e) => {
      if (!activeRef.current) return;
      if (e.t === "user") {
        // Arm only when OUR submitted turn echoes back; ignore other/replayed user turns. The echo is
        // the DECORATED text in voice mode (the backend appends the hidden <voice-mode> directive), so
        // compare stripped — a raw === here never matched, which left voice mode disarmed, silent and
        // stuck on "thinking" for the whole turn while the reply rendered normally in the chat.
        if (!armedRef.current && expectedUserRef.current != null && stripVoiceDirective((e as any).text) === expectedUserRef.current.trim()) {
          armedRef.current = true; sentBufRef.current = ""; setCaption("");
        }
        return;
      }
      // Backstops so a missed echo can never mute a turn again: the server flipping to busy after our
      // submit means our turn was accepted, and past the fallback window anything arriving is ours.
      if (!armedRef.current && submitAtRef.current) {
        if (e.t === "busy" && (e as any).busy === true) { armedRef.current = true; sentBufRef.current = ""; setCaption(""); return; }
        if (Date.now() - submitAtRef.current > ARM_FALLBACK_MS) { armedRef.current = true; sentBufRef.current = ""; setCaption(""); }
      }
      if (!armedRef.current) return; // pre-arm: skip replayed history / in-flight prior reply
      if (e.t === "tool_start" || e.t === "tool_use") {
        // Text that runs straight into a tool call was narration, not the answer. Drop whatever is
        // still held or half-written so it is neither spoken now nor glued onto the real answer later.
        if (holdTimerRef.current) { clearTimeout(holdTimerRef.current); holdTimerRef.current = null; }
        holdRef.current = [];
        sentBufRef.current = "";
      } else if (e.t === "text_delta" || e.t === "text") {
        const t = (e as any).text || "";
        if (!t) return;
        setCaption((c) => (c + t).slice(-600));
        sentBufRef.current += t;
        const [sents, rest] = takeSentences(sentBufRef.current);
        sentBufRef.current = rest;
        // Both modes speak as the reply streams. The difference is only that "skip the running
        // commentary" holds each sentence for HOLD_MS first, so anything a tool call follows is
        // discarded instead of read out. Waiting for the whole turn is never the answer: the reply is
        // usually finished writing long before it would have finished being spoken.
        for (const sent of sents) { if (speakFinalRef.current) holdSentence(sent); else speakSentence(sent); }
      } else if (e.t === "result" || (e.t === "busy" && (e as any).busy === false)) {
        // turn complete: release anything held and speak the trailing partial sentence
        if (!turnDoneRef.current) {
          turnDoneRef.current = true; turnDoneAtRef.current = Date.now();
          const buf = sentBufRef.current.trim(); sentBufRef.current = "";
          flushHold();
          if (buf) speakSentence(buf);
        }
      } else if (e.t === "error") {
        setErr((e as any).message || "error");
      }
    });
    return unsub;
  }, [open, bridge, speakSentence, holdSentence, flushHold]);
  // #endregion

  // #region barge-in + hands-free loop (drives phase transitions off playback state)
  useEffect(() => {
    if (!open) return;
    let raf = 0;
    const data = new Uint8Array(2048);
    let loud = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const player = playerRef.current;
      if (!player) return;
      // move thinking -> speaking once audio actually starts (works with or without a live mic)
      if (phaseRef.current === "thinking" && player.isActive) setPhaseR("speaking");
      // turn done + audio drained: hands-free listens again; tap-to-talk goes idle (music resumes) to wait for a tap
      // Silence watchdog: the turn is over, no audio is playing and nothing is being synthesised, yet
      // we are still showing "thinking". That means this turn produced no speech (TTS down, or an empty
      // reply). Hand the mic back instead of sitting on a dead screen with the answer already visible.
      if (phaseRef.current === "thinking" && turnDoneRef.current && !player.isActive && ttsPendingRef.current === 0 && turnDoneAtRef.current && Date.now() - turnDoneAtRef.current > 1500) {
        if (!spokeRef.current) setErr("nothing was read back for that reply");
        if (pttRef.current) setPhaseR("idle"); else startListening();
        return;
      }
      if (phaseRef.current === "speaking" && turnDoneRef.current && !player.isActive) {
        if (pttRef.current) setPhaseR("idle");
        else startListening();
        return;
      }
      const analyser = analyserRef.current;
      if (!analyser) return; // no live mic (tap-to-talk between turns) -> no barge-in
      const speakingOrThinking = phaseRef.current === "speaking" || phaseRef.current === "thinking";
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
        const AC: typeof AudioContext = (window as any).AudioContext || (window as any).webkitAudioContext;
        const ctx = new AC();
        try { await ctx.resume(); } catch {}
        if (cancelled) { try { ctx.close(); } catch {} return; }
        ctxRef.current = ctx;
        activeRef.current = true;
        if (pttRef.current) {
          // Tap-to-talk: no persistent mic. Play TTS through a real media element (ElementPlayer) so the
          // OS treats it as MEDIA — loud on the car speakers, ducks/pauses the user's music — instead of
          // quiet Web Audio. The mic only opens on a tap (pttTap, which also primes/unlocks the element).
          playerRef.current = new ElementPlayer();
          setPhaseR("idle");
        } else {
          // Always-on: the open mic makes the phone hold a CALL-type audio session (over car Bluetooth
          // the head unit mutes media / routes to HFP). A media element can't override that while the
          // mic is live, so we just play to the default output — inherent to hands-free listening.
          const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
          if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
          streamRef.current = stream;
          const src = ctx.createMediaStreamSource(stream);
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 2048; analyser.smoothingTimeConstant = 0.3;
          src.connect(analyser);
          srcNodeRef.current = src; analyserRef.current = analyser;
          playerRef.current = new SpeechPlayer(ctx);
          startListening();
        }
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
  const ptt = !!tapToTalk;
  const label = ptt && phase === "idle" ? "Tap to talk"
    : phase === "listening" ? (ptt ? "Listening… tap to send" : "Listening…")
    : phase === "transcribing" ? "…" : phase === "thinking" ? "Thinking…" : phase === "speaking" ? "Speaking…" : phase === "error" ? "Problem" : "";
  const interrupt = () => { playerRef.current?.stop(); ttsChainRef.current = Promise.resolve(); turnDoneRef.current = true; if (ptt) { setPhaseR("idle"); } else startListening(); };
  return (
    <div className="voice-overlay" role="dialog" aria-label="Voice mode">
      <div className="voice-top">
        <span className="voice-badge">Voice{ptt ? " · tap" : ""}</span>
        <button className="voice-x" onClick={onClose} aria-label="Exit voice mode">Done</button>
      </div>
      <div className="voice-center">
        <div className={"voice-orb voice-" + phase + (ptt ? " voice-orb-tap" : "")} onClick={ptt ? () => void pttTap() : undefined} role={ptt ? "button" : undefined} aria-label={ptt ? label : undefined}>
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
        {ptt && (phase === "idle" || phase === "listening") && (
          <button className="voice-talk" onClick={() => void pttTap()}>{phase === "listening" ? "Tap to send" : "Tap to talk"}</button>
        )}
        {(phase === "speaking" || phase === "thinking") && (
          <button className="voice-skip" onClick={interrupt}>Interrupt</button>
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
  .voice-orb-tap{cursor:pointer}
  .voice-talk{background:#d97757;border:none;color:#fff;border-radius:999px;padding:15px 40px;font-size:17px;font-weight:600;cursor:pointer;box-shadow:0 6px 20px rgba(217,119,87,.4)}
  .voice-talk:active{background:#c76644}
  @media (min-width:720px){.voice-transcript{max-width:640px;margin:0 auto;width:100%}}
  /* composer mic button: static (no constant animation); the icon just reacts on tap */
  .voice-open-btn{position:relative;transform-origin:center}
  .voice-open-btn svg{transition:transform .12s ease}
  .voice-open-btn:active svg{transform:scale(.9)}
  `;
  const el = document.createElement("style"); el.id = "voice-css"; el.textContent = css; document.head.appendChild(el);
}
// #endregion
