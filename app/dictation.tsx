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
const MAX_FAILS = 3;     // consecutive network failures before giving up

// #region capture plumbing
// Runs on the audio thread and does nothing but hand frames back, so a busy main thread (React
// re-rendering the transcript as it grows) can't drop audio the way a ScriptProcessor would.
const WORKLET_SRC = `
class DictationTap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) this.port.postMessage(new Float32Array(ch));
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
  const pendingRef = useRef<Float32Array[]>([]);   // resampled 16k audio not yet posted
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const inflightRef = useRef(false);
  const sidRef = useRef("");
  const failsRef = useRef(0);
  const textRef = useRef({ committed: "", partial: "" });
  const activeRef = useRef(false);
  const levelRef = useRef(0);
  const discardRef = useRef(false);

  const available = typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && opts.enabled !== false;

  const emit = useCallback((done: boolean) => {
    const { committed, partial } = textRef.current;
    const joined = [committed, partial].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    onTextRef.current(joined, done);
  }, []);

  const teardownAudio = useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    try { nodeRef.current?.disconnect(); } catch { /* */ }
    try { srcRef.current?.disconnect(); } catch { /* */ }
    try { sinkRef.current?.disconnect(); } catch { /* */ }
    try { streamRef.current?.getTracks().forEach((t) => t.stop()); } catch { /* */ }
    try { void ctxRef.current?.close(); } catch { /* */ }
    nodeRef.current = null; srcRef.current = null; sinkRef.current = null;
    streamRef.current = null; ctxRef.current = null; resamplerRef.current = null;
    pendingRef.current = [];
    setLevel(0); levelRef.current = 0;
  }, []);

  // Drain everything captured so far into one POST. `final` closes the session server-side and
  // returns the whole transcript.
  const post = useCallback(async (final: boolean): Promise<boolean> => {
    const chunks = pendingRef.current;
    pendingRef.current = [];
    let total = 0; for (const c of chunks) total += c.length;
    const merged = new Float32Array(total);
    let off = 0; for (const c of chunks) { merged.set(c, off); off += c.length; }
    const body = pcm16(merged);
    try {
      const r = await fetch(`/app/api/stt/live?sid=${encodeURIComponent(sidRef.current)}&final=${final ? 1 : 0}`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body,
      });
      if (!r.ok) throw new Error("stt " + r.status);
      const d = await r.json();
      failsRef.current = 0;
      textRef.current = { committed: String(d?.committed || ""), partial: String(d?.partial || "") };
      if (!discardRef.current) emit(false);
      return true;
    } catch {
      failsRef.current++;
      if (failsRef.current >= MAX_FAILS) setError("lost the transcription service");
      // Losing a chunk is better than stalling: the audio is already gone, so keep the session going.
      return false;
    }
  }, [emit]);

  const stop = useCallback(() => {
    if (!activeRef.current) return;
    activeRef.current = false;
    setActive(false);
    teardownAudio();
    void (async () => {
      const ok = await post(true);
      const raw = [textRef.current.committed, textRef.current.partial].filter(Boolean).join(" ").trim();
      textRef.current = { committed: raw, partial: "" };
      if (discardRef.current) { discardRef.current = false; return; }
      if (!ok || !raw) { emit(true); return; }
      if (!tidyRef.current) { emit(true); return; }
      // Cleanup pass: punctuation, filler, project names. Any failure keeps the raw transcript.
      setTidying(true);
      try {
        const r = await fetch("/app/api/stt/cleanup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: raw }) });
        const d = await r.json();
        const tidied = String(d?.text || "").trim();
        if (tidied && !discardRef.current) textRef.current = { committed: tidied, partial: "" };
      } catch { /* keep raw */ }
      setTidying(false);
      if (!discardRef.current) emit(true);
      discardRef.current = false;
    })();
  }, [post, emit, teardownAudio]);

  const start = useCallback(() => {
    if (activeRef.current || !available) return;
    setError(null);
    discardRef.current = false;
    textRef.current = { committed: "", partial: "" };
    failsRef.current = 0;
    sidRef.current = (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36);
    activeRef.current = true;
    setActive(true);
    // Start the cleanup process now rather than when we stop: it takes far longer to start than to
    // run, and the user is about to spend several seconds talking.
    if (tidyRef.current) { void fetch("/app/api/stt/cleanup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ warm: true }) }).catch(() => {}); }
    void (async () => {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      } catch {
        activeRef.current = false; setActive(false); setError("microphone blocked"); return;
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
        levelRef.current = Math.min(1, rms * 8);
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

      timerRef.current = setInterval(() => {
        setLevel(levelRef.current);
        if (inflightRef.current || !pendingRef.current.length) return;
        inflightRef.current = true;
        void post(false).finally(() => { inflightRef.current = false; });
      }, POST_MS);
    })();
  }, [available, post]);

  const cancel = useCallback(() => { discardRef.current = true; stop(); }, [stop]);
  const toggle = useCallback(() => { if (activeRef.current) stop(); else start(); }, [start, stop]);

  useEffect(() => () => { activeRef.current = false; teardownAudio(); }, [teardownAudio]);

  return { available, active, tidying, level, error, start, stop, toggle, cancel };
}
