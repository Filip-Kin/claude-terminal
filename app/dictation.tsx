// app/dictation.tsx — live dictation for the composer: talk, watch the words land, edit, send.
//
// Different job from voice.tsx. Voice mode is a conversation: one utterance in, spoken reply out,
// hands never touch the phone. Dictation is just a faster keyboard — the text goes into the composer
// so it can be read, fixed and sent like anything typed. That difference drives everything here:
// nothing is auto-submitted, and partial text has to appear WHILE you talk rather than after.
//
// Capture is raw PCM rather than MediaRecorder, which is what voice mode uses. MediaRecorder only
// puts a container header on its first chunk, so later chunks are not independently decodable — fine
// when the whole clip is posted at once, useless when the point is to post every half second. An
// AudioWorklet gives plain Float32 frames instead: resample to 16k, convert to PCM16, post. Same
// audio on every platform, no container games, and iOS Safari (no Web Speech API, which is why this
// is server-side at all) is treated identically to Chrome.
import { useCallback, useEffect, useRef, useState } from "react";

const TARGET_SR = 16000; // what the STT service expects
const POST_MS = 500;     // how often a chunk goes up; also the floor on how fast text can appear
const LEVEL_MS = 100;    // how often the button's pulse is refreshed; the mic pulse is the only
                         // proof it is listening, so it must not run at the posting rate
const MAX_FAILS = 3;     // consecutive network failures before the button says so
// A chunk POST holds the connection open for the whole server-side decode, so the ceiling has to
// clear a slow one. Without a ceiling at all, one stalled request on a phone connection left
// `inflight` true forever: no further chunk was ever posted, no partial ever came back, and the
// text only appeared at the end when stop() issued its own request. That is the "it doesn't show
// up until I press send" report.
const CHUNK_TIMEOUT_MS = 8000;
const FINAL_TIMEOUT_MS = 15000;
const CLEANUP_TIMEOUT_MS = 20000;
const MAX_BACKLOG_S = 30; // unsent audio kept while the network is down, before the oldest is dropped

// #region capture plumbing
// Runs on the audio thread and does nothing but hand frames back, so a busy main thread (React
// re-rendering the transcript as it grows) can't drop audio the way a ScriptProcessor would.
// It batches to ~2048 samples first: `process` is called with 128-sample blocks, and posting each
// one is 125 messages a second at the main thread, which is real jank on a phone.
const WORKLET_SRC = `
class DictationTap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(2048); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice(0)); this.n = 0; }
      }
    }
    return true;
  }
}
registerProcessor('dictation-tap', DictationTap);
`;

function pcm16(samples: Float32Array): ArrayBuffer {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out.buffer;
}

function newSid(): string {
  return (typeof crypto !== "undefined" && crypto.randomUUID)
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// Linear resample to 16k, carrying the fractional read position and the last input sample across
// chunks so the joins don't click (a click reads as a consonant to Whisper).
class Resampler {
  private ratio: number;
  private pos = 0;
  private last = 0;
  private primed = false;
  constructor(inRate: number) { this.ratio = inRate / TARGET_SR; }
  push(input: Float32Array): Float32Array {
    if (this.ratio === 1) return input;
    const out: number[] = [];
    let p = this.pos;
    while (p < input.length) {
      const i = Math.floor(p);
      const frac = p - i;
      const a = i === 0 ? (this.primed ? this.last : input[0]) : input[i - 1];
      const b = input[i];
      out.push(a + (b - a) * frac);
      p += this.ratio;
    }
    this.pos = p - input.length;
    this.last = input[input.length - 1] ?? this.last;
    this.primed = true;
    return Float32Array.from(out);
  }
}
// #endregion

export interface Dictation {
  available: boolean;
  active: boolean;
  tidying: boolean;      // the cleanup pass is running after you stopped
  level: number;         // 0..1 mic level, for the button's pulse
  error: string | null;
  start: () => void;
  stop: () => void;
  toggle: () => void;
  cancel: () => void;    // stop and discard (used when the composer is cleared out from under us)
  reset: () => void;     // keep listening, but forget everything said so far (used on send)
}

/**
 * onText(text, done) fires on every update: `done` is false while dictating (the caller shows it as
 * provisional) and true once for the final, tidied text. The caller owns where the text goes.
 */
export function useDictation(opts: { onText: (text: string, done: boolean) => void; tidy?: boolean; enabled?: boolean }): Dictation {
  const { onText } = opts;
  const tidyRef = useRef(!!opts.tidy);
  useEffect(() => { tidyRef.current = !!opts.tidy; }, [opts.tidy]);
  const onTextRef = useRef(onText);
  useEffect(() => { onTextRef.current = onText; }, [onText]);

  const [active, setActive] = useState(false);
  const [tidying, setTidying] = useState(false);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const nodeRef = useRef<AudioNode | null>(null);
  const srcRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const sinkRef = useRef<GainNode | null>(null);
  const resamplerRef = useRef<Resampler | null>(null);
  const pendingRef = useRef<Float32Array[]>([]);   // resampled 16k audio not yet accepted by the server
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const levelTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const inflightRef = useRef(false);
  const inflightP = useRef<Promise<unknown> | null>(null);
  const sidRef = useRef("");
  const sentRef = useRef(0);        // PCM bytes the server has confirmed; also the retry offset
  const genRef = useRef(0);         // bumped by reset(); a reply from an older generation is dropped
  const failsRef = useRef(0);
  const textRef = useRef({ committed: "", partial: "" });
  const lastEmitRef = useRef("");
  const activeRef = useRef(false);
  const levelRef = useRef(0);
  const discardRef = useRef(false);

  const available = typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && opts.enabled !== false;

  const emit = useCallback((done: boolean) => {
    const { committed, partial } = textRef.current;
    const joined = [committed, partial].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    // Re-emitting identical text still rewrites the whole composer value, which on a phone moves the
    // caret and fights the keyboard for no gain. Only speak up when something actually changed.
    if (!done && joined === lastEmitRef.current) return;
    lastEmitRef.current = joined;
    onTextRef.current(joined, done);
  }, []);

  const teardownAudio = useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    if (levelTimerRef.current) { clearInterval(levelTimerRef.current); levelTimerRef.current = null; }
    try { nodeRef.current?.disconnect(); } catch { /* */ }
    try { srcRef.current?.disconnect(); } catch { /* */ }
    try { sinkRef.current?.disconnect(); } catch { /* */ }
    try { streamRef.current?.getTracks().forEach((t) => t.stop()); } catch { /* */ }
    try { void ctxRef.current?.close(); } catch { /* */ }
    nodeRef.current = null; srcRef.current = null; sinkRef.current = null;
    streamRef.current = null; ctxRef.current = null; resamplerRef.current = null;
    setLevel(0); levelRef.current = 0;
  }, []);

  // Drain everything captured so far into one POST. `final` closes the session server-side and
  // returns the whole transcript.
  const post = useCallback(async (final: boolean): Promise<boolean> => {
    const gen = genRef.current;
    const chunks = pendingRef.current;
    pendingRef.current = [];
    let total = 0; for (const c of chunks) total += c.length;
    const merged = new Float32Array(total);
    let off = 0; for (const c of chunks) { merged.set(c, off); off += c.length; }
    const body = pcm16(merged);
    const at = sentRef.current;
    const ctrl = new AbortController();
    const killer = setTimeout(() => ctrl.abort(), final ? FINAL_TIMEOUT_MS : CHUNK_TIMEOUT_MS);
    try {
      // `off` is where this audio belongs in the session. It is what makes a retry safe: the server
      // trims anything it already holds instead of splicing the same words in twice.
      const r = await fetch(`/app/api/stt/live?sid=${encodeURIComponent(sidRef.current)}&final=${final ? 1 : 0}&off=${at}`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body,
        signal: ctrl.signal,
      });
      if (!r.ok) throw new Error("stt " + r.status);
      const d = await r.json();
      if (gen !== genRef.current) return true; // the session was reset while this was in the air
      sentRef.current = at + body.byteLength;
      if (failsRef.current) setError(null);
      failsRef.current = 0;
      textRef.current = { committed: String(d?.committed || ""), partial: String(d?.partial || "") };
      if (!discardRef.current) emit(false);
      return true;
    } catch {
      if (gen !== genRef.current) return false;
      failsRef.current++;
      // The old code dropped the audio here. On a phone that is a hole in the middle of a sentence
      // every time a chunk misses, and the words are gone for good. Put it back at the FRONT of the
      // queue instead: sentRef has not moved, so the retry carries the same offset and the server
      // de-duplicates whatever it did manage to receive.
      if (!final && merged.length) {
        pendingRef.current.unshift(merged);
        let held = 0; for (const c of pendingRef.current) held += c.length;
        while (held > MAX_BACKLOG_S * TARGET_SR && pendingRef.current.length > 1) {
          const dropped = pendingRef.current.shift()!;
          held -= dropped.length;
          sentRef.current += dropped.length * 2; // skip the gap rather than misalign everything after it
        }
      }
      if (failsRef.current >= MAX_FAILS) setError("reconnecting to the transcription service");
      return false;
    } finally {
      clearTimeout(killer);
    }
  }, [emit]);

  const stop = useCallback(() => {
    if (!activeRef.current) return;
    activeRef.current = false;
    setActive(false);
    // Snapshot what the mic captured since the last post BEFORE tearing the graph down, because
    // teardown clears the pending queue. Doing it the other way round threw away every word spoken
    // in the last half second, and more when a decode ran slow, so dictations ended mid-thought.
    const tail = pendingRef.current;
    teardownAudio();
    pendingRef.current = tail;
    void (async () => {
      // Let any partial still in the air land first, so the final flush cannot overtake it.
      try { await inflightP.current; } catch { /* */ }
      const ok = await post(true);
      const raw = [textRef.current.committed, textRef.current.partial].filter(Boolean).join(" ").trim();
      textRef.current = { committed: raw, partial: "" };
      if (discardRef.current) { discardRef.current = false; return; }
      if (!ok || !raw) { emit(true); return; }
      if (!tidyRef.current) { emit(true); return; }
      // Cleanup pass: punctuation, filler, project names. Any failure keeps the raw transcript.
      setTidying(true);
      const gen = genRef.current;
      const ctrl = new AbortController();
      const killer = setTimeout(() => ctrl.abort(), CLEANUP_TIMEOUT_MS);
      try {
        const r = await fetch("/app/api/stt/cleanup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: raw }), signal: ctrl.signal });
        const d = await r.json();
        const tidied = String(d?.text || "").trim();
        if (tidied && !discardRef.current && gen === genRef.current) textRef.current = { committed: tidied, partial: "" };
      } catch { /* keep raw */ } finally { clearTimeout(killer); setTidying(false); }
      if (!discardRef.current) emit(true);
      discardRef.current = false;
    })();
  }, [post, emit, teardownAudio]);

  // Forget everything said so far but keep listening. The composer being cleared (by a send) is
  // authoritative: without this, the next poll returns the same server-side transcript and puts the
  // just-sent words straight back into the empty box.
  const reset = useCallback(() => {
    const oldSid = sidRef.current;
    genRef.current++;
    sidRef.current = newSid();
    sentRef.current = 0;
    pendingRef.current = [];
    textRef.current = { committed: "", partial: "" };
    lastEmitRef.current = "";
    failsRef.current = 0;
    inflightRef.current = false;
    // Best effort: let the server drop the abandoned buffer now rather than at the 5 minute sweep.
    if (oldSid) void fetch(`/app/api/stt/live?sid=${encodeURIComponent(oldSid)}&final=1&off=0`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: new ArrayBuffer(0) }).catch(() => {});
  }, []);

  const start = useCallback(() => {
    if (activeRef.current || !available) return;
    setError(null);
    discardRef.current = false;
    textRef.current = { committed: "", partial: "" };
    lastEmitRef.current = "";
    failsRef.current = 0;
    sentRef.current = 0;
    genRef.current++;
    sidRef.current = newSid();
    activeRef.current = true;
    setActive(true);
    // Start the cleanup process now rather than when we stop: it takes far longer to start than to
    // run, and the user is about to spend several seconds talking.
    if (tidyRef.current) { void fetch("/app/api/stt/cleanup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ warm: true }) }).catch(() => {}); }
    void (async () => {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      } catch (e: any) {
        // "microphone blocked" was the message for a missing mic and for an insecure origin too,
        // which sends you looking in the wrong settings screen.
        const name = e?.name || "";
        const msg = name === "NotAllowedError" || name === "SecurityError" ? "microphone permission denied"
          : name === "NotFoundError" || name === "OverconstrainedError" ? "no microphone found"
          : name === "NotReadableError" ? "the microphone is in use by something else"
          : "could not open the microphone";
        activeRef.current = false; setActive(false); setError(msg); return;
      }
      if (!activeRef.current) { try { stream.getTracks().forEach((t) => t.stop()); } catch { /* */ } return; }
      streamRef.current = stream;
      // Ask for 16k directly (Chrome honours it, which skips resampling entirely); resample when the
      // platform insists on its own rate, as iOS does.
      let ctx: AudioContext;
      try { ctx = new AudioContext({ sampleRate: TARGET_SR }); } catch { ctx = new AudioContext(); }
      ctxRef.current = ctx;
      try { await ctx.resume(); } catch { /* */ }
      resamplerRef.current = new Resampler(ctx.sampleRate);

      const onFrame = (frame: Float32Array) => {
        if (!activeRef.current) return;
        let sum = 0; for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
        const rms = Math.sqrt(sum / Math.max(1, frame.length));
        levelRef.current = Math.max(levelRef.current * 0.7, Math.min(1, rms * 8));
        const rs = resamplerRef.current?.push(frame);
        if (rs && rs.length) pendingRef.current.push(rs);
      };

      const src = ctx.createMediaStreamSource(stream);
      srcRef.current = src;
      let node: AudioNode | null = null;
      try {
        const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: "application/javascript" }));
        await ctx.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);
        const wn = new AudioWorkletNode(ctx, "dictation-tap");
        wn.port.onmessage = (e) => onFrame(e.data as Float32Array);
        node = wn;
      } catch {
        // Older Safari / locked-down browsers: the deprecated processor still works.
        const sp = ctx.createScriptProcessor(4096, 1, 1);
        sp.onaudioprocess = (e) => onFrame(new Float32Array(e.inputBuffer.getChannelData(0)));
        node = sp;
      }
      if (!activeRef.current) { try { stream.getTracks().forEach((t) => t.stop()); } catch { /* */ } return; }
      nodeRef.current = node;
      // A muted sink keeps the graph pulling without any of it reaching the speakers.
      const sink = ctx.createGain();
      sink.gain.value = 0;
      sinkRef.current = sink;
      src.connect(node);
      node.connect(sink);
      sink.connect(ctx.destination);

      // Two timers, because they answer different questions. The pulse says "I am hearing you" and
      // has to be smooth; the POST says "here is more audio" and is paced by the decoder.
      levelTimerRef.current = setInterval(() => {
        levelRef.current *= 0.75;               // decay, so the pulse falls back when you stop talking
        setLevel(levelRef.current);
      }, LEVEL_MS);
      timerRef.current = setInterval(() => {
        if (inflightRef.current || !pendingRef.current.length) return;
        inflightRef.current = true;
        const p = post(false).finally(() => { inflightRef.current = false; });
        inflightP.current = p;
        void p;
      }, POST_MS);
    })();
  }, [available, post]);

  const cancel = useCallback(() => { discardRef.current = true; stop(); }, [stop]);
  const toggle = useCallback(() => { if (activeRef.current) stop(); else start(); }, [start, stop]);

  useEffect(() => () => { activeRef.current = false; teardownAudio(); }, [teardownAudio]);

  return { available, active, tidying, level, error, start, stop, toggle, cancel, reset };
}
