# claude-stt — local Whisper speech-to-text for the chat app's hands-free voice mode.
#
# Records mic audio in the browser (MediaRecorder -> webm/opus on Chrome/Android,
# mp4/aac on iOS Safari), POSTs the blob here, faster-whisper transcribes it -> text.
# All server-side so it works identically on iOS (no Web Speech API there) and Android.
#
# Binds loopback only; the claude-terminal sidecar proxies it at /app/api/stt and
# owner-gates the request. Never exposed directly.
import os
import time
import tempfile

import numpy as np

from fastapi import FastAPI, Request, UploadFile, File, Form
from fastapi.responses import JSONResponse
from faster_whisper import WhisperModel

MODEL_SIZE = os.environ.get("STT_MODEL", "small.en")
DEVICE = os.environ.get("STT_DEVICE", "cpu")
COMPUTE = os.environ.get("STT_COMPUTE", "int8")
# faster-whisper is CPU-thread-bound; give it a healthy slice of the 5900X but leave
# headroom for the TTS service and the sidecar.
CPU_THREADS = int(os.environ.get("STT_THREADS", "8"))

print(f"[stt] loading {MODEL_SIZE} device={DEVICE} compute={COMPUTE} threads={CPU_THREADS}", flush=True)
_t0 = time.time()
model = WhisperModel(MODEL_SIZE, device=DEVICE, compute_type=COMPUTE, cpu_threads=CPU_THREADS)
print(f"[stt] model ready in {time.time() - _t0:.1f}s", flush=True)

app = FastAPI()


@app.get("/health")
def health():
    return {"ok": True, "model": MODEL_SIZE, "device": DEVICE, "compute": COMPUTE}


@app.post("/transcribe")
async def transcribe(file: UploadFile = File(...), language: str = Form("en")):
    raw = await file.read()
    if not raw:
        return JSONResponse({"error": "empty audio"}, status_code=400)

    # Persist to a temp file; faster-whisper decodes via PyAV/ffmpeg which handles
    # webm/opus and mp4/aac transparently.
    suffix = os.path.splitext(file.filename or "")[1] or ".webm"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tf:
        tf.write(raw)
        path = tf.name

    t0 = time.time()
    try:
        segments, info = model.transcribe(
            path,
            language=None if language == "auto" else language,
            beam_size=1,           # greedy — fastest, plenty accurate for short turns
            vad_filter=True,       # drop leading/trailing silence -> faster + cleaner
            vad_parameters={"min_silence_duration_ms": 300},
            condition_on_previous_text=False,
        )
        text = "".join(s.text for s in segments).strip()
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"error": f"transcribe failed: {e}"}, status_code=500)
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass

    dt = time.time() - t0
    print(f"[stt] {len(raw)} bytes -> {len(text)} chars in {dt:.2f}s: {text[:80]!r}", flush=True)
    return {"text": text, "language": info.language, "seconds": round(dt, 3)}


# #region live dictation (streaming transcription for the composer mic)
# The one-shot /transcribe above is right for hands-free voice mode: one utterance in, one text out.
# Dictation is different — you want to watch words appear while you talk, and you may talk for a
# minute. So the browser sends raw PCM16 mono 16k in ~500ms chunks tagged with a session id, and this
# keeps a per-session buffer:
#
#   * every chunk, the live (uncommitted) buffer is re-transcribed -> "partial" text, redrawn in grey
#   * when the buffer ends in enough silence, that segment is committed -> "committed" text, black
#   * committing clears the buffer, so cost stays bounded by segment length, not dictation length
#
# Plain HTTP rather than a websocket, deliberately: it reuses the existing owner-gated proxy in the
# sidecar and works on iOS Safari, which is the platform that forced server-side speech in the first
# place. On loopback, a POST per 500ms costs nothing measurable.
#
# Three things here exist because they were measured, not assumed. See the notes on each: the vocab
# prompt is gone, the temperature fallback is gone, and near-silent buffers are never decoded at all.
import re
import threading
import wave
import zlib

SR = 16000                                              # what the client resamples to
SEG_MAX_S = float(os.environ.get("STT_SEG_MAX_S", "12"))    # force a commit on a monologue
SILENCE_S = float(os.environ.get("STT_SILENCE_S", "0.7"))   # trailing quiet that ends a segment
MIN_PARTIAL_S = float(os.environ.get("STT_MIN_PARTIAL_S", "0.6"))  # don't transcribe less than this
SESSION_TTL_S = 300

# Level handling is RELATIVE, not absolute. The old absolute floor (normalised RMS 0.012) was above
# the whole signal on a phone held at arm's length with noise suppression on: `spoke` was never true,
# so the pause-commit never fired, every segment ran to the 12s cap, and every partial re-decoded a
# 12s buffer. Measured on a quiet-phone sample: real speech peaks at ~0.016 per 100ms window, true
# silence at ~0.0008. So gate on the loudest window (speech survives a long buffer with one word in
# it) and take "quiet" as a fraction of what this speaker actually sounds like.
SPEECH_RMS = float(os.environ.get("STT_SPEECH_RMS", "0.004"))   # below this, the buffer is not speech
QUIET_FRAC = float(os.environ.get("STT_QUIET_FRAC", "0.12"))    # of the session's own speech level
QUIET_FLOOR = 0.0015

# vocab.txt used to be fed to the decoder as `initial_prompt`. Whisper treats that as the preceding
# transcript, so on a quiet or trailing-off buffer the decoder would stop transcribing and simply
# CONTINUE THE LIST: real dictation came back as "...it would be really... React, ffmpeg, FRC, FRC, T"
# and "Klipper, Zoraxy, is still routing the wiki subdomain". Measured over 38 buffers of silence,
# mid-word truncations and trailing-off speech: prompt on = 1 leak + 1 repetition loop + 0.62s mean
# decode; prompt off = 0 leaks, 0 repetition loops, 0.33s mean. `hotwords=` is the same mechanism
# under a different name and leaked identically, so it is not a fix either.
# The names are still corrected — by the Haiku cleanup pass, which has the same list and, unlike the
# decoder, can tell a name from a transcript. vocab.txt is left in place as the source of that list.

_lock = threading.Lock()          # faster-whisper model calls are serialised
_sessions: dict[str, dict] = {}
_sessions_lock = threading.Lock()


def _rms(pcm: bytes) -> float:
    if not pcm:
        return 0.0
    a = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
    return float(np.sqrt(np.mean(a * a))) if a.size else 0.0


def _win_rms(pcm: bytes, ms: int = 100) -> np.ndarray:
    """Per-window RMS. Level decisions use windows, not a whole-buffer mean, because a mean over a
    long buffer is dominated by the pauses inside it."""
    a = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
    n = int(ms / 1000 * SR)
    k = len(a) // n
    if k < 1:
        return np.array([float(np.sqrt(np.mean(a * a)))] if a.size else [0.0], dtype=np.float32)
    w = a[: k * n].reshape(k, n)
    return np.sqrt((w * w).mean(axis=1))


def _loudest(pcm: bytes) -> float:
    v = _win_rms(pcm)
    return float(v.max()) if v.size else 0.0


def _wav_bytes(pcm: bytes) -> str:
    """faster-whisper wants a file/stream; a WAV header round-trip is cheaper than resampling."""
    tf = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    with wave.open(tf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm)
    tf.close()
    return tf.name


# A live buffer almost always ends mid-word, and a decoder that runs out of confidence there starts
# repeating instead of stopping: "dts dts dts", "-b-b-b-b-b", "f---ing f---ing f---ing". max_new_tokens
# bounds how long that runs, which bounds the LATENCY, but the garbage still reaches the composer.
# These two catch it as output.
_RUN_RE = re.compile(r"(.{1,12}?)\1{3,}")           # 'TTTTTT', '-b-b-b-b-b-b', 'T2M, T2M, T2M, T2M, '
# 4+ copies, not 3: "no no no" and "really really really" are things people actually say.
_WORDRUN_RE = re.compile(r"\b([\w'\-]+)([,.]?\s+)(?:\1\2){3,}", re.IGNORECASE)


def _find_run(t: str):
    """First repetition run worth cutting at. Short accidental matches (a doubled space, 'ha ha')
    are not worth truncating a sentence for; a run has to be substantial to be a decoder loop."""
    for m in _RUN_RE.finditer(t):
        if len(m.group(0)) >= 10 and m.group(1).strip():
            return m
    return None


def _sanitise(text: str) -> str:
    """Strip a degenerate tail, keep the real words in front of it.

    base.en on a mid-word buffer produces things like 'Right so the plan for tomorrow is to finish
    the ████████' (yes, literal U+2588 runs), 'Zoraxy is still a f---ing f---ing f---ing', or
    '-b-b-b-b-b'. The words BEFORE the run are correct, so cutting at the run beats dropping the
    segment: dropping loses speech the user actually said, which is the same complaint by another
    route.
    """
    t = _WORDRUN_RE.sub(r"\1\2", text.strip())
    t = re.sub(r"[\u2580-\u259f]+", "", t)
    m = _find_run(t)
    if m:
        t = t[: m.start()]
    t = t.strip().rstrip(" ,-")
    # Whisper answers a buffer it cannot read with punctuation rather than nothing: "//", "...",
    # "♪". None of that is a word, and all of it lands in the message box.
    if not re.search(r"[0-9A-Za-z]", t):
        return ""
    # Compression ratio is the standard Whisper repetition tell; real English sits well under 2.4.
    # If it still trips after trimming, the whole output is a loop and there is nothing to keep.
    if len(t) >= 16 and len(t) / max(1, len(zlib.compress(t.encode()))) > 2.4:
        return ""
    return t


_last_ms = 0.35  # rolling cost of one partial pass, used to throttle the next one


def _transcribe_pcm(pcm: bytes) -> str:
    global _last_ms
    dur = len(pcm) / (SR * 2)
    # Never decode something that is not speech. Whisper on silence does not return nothing, it
    # invents ("If you have any questions, please leave them in the comments"), and that invention
    # lands in the message box. True silence measures ~0.0008 against ~0.016 for quiet speech, so
    # this rejects with a 4x margin either way.
    if _loudest(pcm) < SPEECH_RMS:
        return ""
    path = _wav_bytes(pcm)
    t0 = time.time()
    try:
        with _lock:
            segments, _info = model.transcribe(
                path,
                language="en",
                beam_size=1,
                vad_filter=True,
                vad_parameters={"min_silence_duration_ms": 300},
                condition_on_previous_text=False,
                # Speech runs at well under 12 tokens/second, so this only ever truncates a runaway.
                max_new_tokens=min(448, int(dur * 12) + 24),
                # One greedy pass, no temperature fallback. The default ladder re-decodes the same
                # audio up to six times when it dislikes the result, which is where the 11s worst
                # case came from — and on a mid-word buffer it dislikes the result often. Measured:
                # fallback on = 0.62s mean / 2.33s worst; pinned to 0 = 0.25s mean / 0.41s worst,
                # with fewer hallucinations, not more.
                temperature=[0.0],
            )
            text = "".join(s.text for s in segments).strip()
        _last_ms = time.time() - t0
        clean = _sanitise(text)
        if len(clean) < len(text) - 2:
            print(f"[stt] live trimmed degenerate output buf={dur:.1f}s: {text[:70]!r} -> {clean[:70]!r}", flush=True)
        text = clean
        # One line per partial would be a line every half second; only the slow ones are worth
        # knowing about, and a slow one means the decoder went long on a mid-word boundary.
        if _last_ms > 1.5:
            print(f"[stt] live slow pass buf={dur:.1f}s cost={_last_ms:.2f}s chars={len(text)}", flush=True)
        return text
    except Exception as e:  # noqa: BLE001
        print(f"[stt] live transcribe failed: {e}", flush=True)
        return ""
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


def _gc_sessions() -> None:
    cut = time.time() - SESSION_TTL_S
    with _sessions_lock:
        for k in [k for k, v in _sessions.items() if v["seen"] < cut]:
            _sessions.pop(k, None)


def _join(parts: list[str]) -> str:
    return " ".join(p for p in parts if p).strip()


def _new_session() -> dict:
    return {
        "buf": bytearray(),
        "committed": [],
        "partial": "",
        "seen": time.time(),
        "since": 0,
        "recv": 0,            # PCM bytes accepted so far, so a client retry can be de-duplicated
        "hi": 0.0,            # loudest window this session — the speaker's own speech level
        "lock": threading.Lock(),
    }


def _reply(st: dict, done: bool = False) -> dict:
    return {"committed": _join(st["committed"]), "partial": st["partial"], "done": done,
            "recv": st["recv"]}


@app.post("/live")
async def live(request: Request, sid: str, final: int = 0, off: int = -1):
    """One dictation chunk in, the running transcript out.

    `off` is the byte offset of this chunk within the session's audio. It lets the client retry a
    chunk whose response it never saw without the audio being appended twice — which used to mean the
    client had to choose between duplicated words and a hole in the sentence. Clients that do not
    send it get the old append-blindly behaviour.
    """
    chunk = await request.body()
    _gc_sessions()
    with _sessions_lock:
        st = _sessions.get(sid)
        if st is None:
            st = _new_session()
            _sessions[sid] = st
        st["seen"] = time.time()

    # Per session, so two requests for the same sid (the final flush racing a partial still in
    # flight) cannot both mutate the buffer or double-transcribe the same audio.
    with st["lock"]:
        if chunk:
            if off >= 0 and off < st["recv"]:
                chunk = chunk[st["recv"] - off:]     # replay of audio already accepted
            if chunk:
                st["buf"] += chunk
                st["since"] += len(chunk)
                st["recv"] += len(chunk)
                st["hi"] = max(st["hi"] * 0.995, _loudest(chunk))

        bytes_per_s = SR * 2
        buf = bytes(st["buf"])
        dur = len(buf) / bytes_per_s

        # End of dictation: flush whatever is left and drop the session.
        if final:
            tail = _transcribe_pcm(buf) if dur >= 0.25 else ""
            text = _join(st["committed"] + [tail])
            with _sessions_lock:
                _sessions.pop(sid, None)
            print(f"[stt] live {sid[:8]} done: {len(text)} chars", flush=True)
            return {"committed": text, "partial": "", "done": True, "recv": st["recv"]}

        if dur < MIN_PARTIAL_S:
            return _reply(st)

        # Commit on a natural pause (or a monologue that has run long enough to risk quadratic cost).
        # Both tests are relative to this speaker's own level, so a quiet mic still segments.
        quiet_at = max(QUIET_FLOOR, st["hi"] * QUIET_FRAC)
        tail_w = _win_rms(buf[-int(SILENCE_S * bytes_per_s):])
        quiet = bool(tail_w.size) and float(tail_w.max()) < quiet_at
        spoke = st["hi"] >= SPEECH_RMS
        if (quiet and spoke and dur >= SILENCE_S + 0.3) or dur >= SEG_MAX_S:
            text = _transcribe_pcm(buf)
            st["buf"] = bytearray()
            st["since"] = 0
            st["partial"] = ""
            if text:
                st["committed"].append(text)
            return _reply(st)

        # Otherwise redraw the in-progress segment. The gate is the cost of the LAST pass, not a fixed
        # interval: a short buffer refreshes every chunk, and a long one backs off instead of queueing
        # requests behind each other until the partial text is further behind than it is useful.
        if st["since"] >= max(0.35, _last_ms) * bytes_per_s:
            st["since"] = 0
            text = _transcribe_pcm(buf)
            # A pass that came back empty on audio we already know is speech is a dropped decode, not
            # a correction. Keeping the previous partial stops the composer flashing back to nothing.
            if text or not spoke:
                st["partial"] = text
        return _reply(st)
# #endregion
