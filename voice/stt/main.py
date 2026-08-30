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
import threading
import wave

SR = 16000                                              # what the client resamples to
SEG_MAX_S = float(os.environ.get("STT_SEG_MAX_S", "12"))    # force a commit on a monologue
SILENCE_S = float(os.environ.get("STT_SILENCE_S", "0.7"))   # trailing quiet that ends a segment
SILENCE_RMS = float(os.environ.get("STT_SILENCE_RMS", "0.012"))  # normalised RMS floor for "quiet"
MIN_PARTIAL_S = float(os.environ.get("STT_MIN_PARTIAL_S", "0.6"))  # don't transcribe less than this
SESSION_TTL_S = 300

# Biases the decoder towards names it would otherwise spell phonetically. Whisper takes this as if it
# were the preceding transcript, so it is a plain sentence, not a word list.
VOCAB_FILE = os.path.join(os.path.dirname(__file__), "vocab.txt")
try:
    with open(VOCAB_FILE) as _f:
        INITIAL_PROMPT = _f.read().strip() or None
except OSError:
    INITIAL_PROMPT = None

_lock = threading.Lock()          # faster-whisper model calls are serialised
_sessions: dict[str, dict] = {}
_sessions_lock = threading.Lock()


def _rms(pcm: bytes) -> float:
    if not pcm:
        return 0.0
    a = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
    return float(np.sqrt(np.mean(a * a))) if a.size else 0.0


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


_last_ms = 0.35  # rolling cost of one partial pass, used to throttle the next one


def _transcribe_pcm(pcm: bytes) -> str:
    global _last_ms
    path = _wav_bytes(pcm)
    dur = len(pcm) / (SR * 2)
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
                initial_prompt=INITIAL_PROMPT,
                # A live buffer almost always ends mid-word, and that is exactly what sends Whisper
                # into a repetition loop: it decodes to the 448-token ceiling and a 3s clip takes 11s.
                # Speech runs at well under 12 tokens/second, so this only ever truncates a runaway.
                max_new_tokens=min(448, int(dur * 12) + 24),
                hallucination_silence_threshold=2.0,
            )
            text = "".join(s.text for s in segments).strip()
        _last_ms = time.time() - t0
        # One line per partial would be a line every half second; only the slow ones are worth knowing
        # about, and a slow one means the decoder went long on a mid-word boundary.
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


@app.post("/live")
async def live(request: Request, sid: str, final: int = 0):
    """One dictation chunk in, the running transcript out."""
    chunk = await request.body()
    _gc_sessions()
    with _sessions_lock:
        st = _sessions.get(sid)
        if st is None:
            st = {"buf": bytearray(), "committed": [], "partial": "", "seen": time.time(), "since": 0}
            _sessions[sid] = st
        st["seen"] = time.time()
    if chunk:
        st["buf"] += chunk
        st["since"] += len(chunk)

    bytes_per_s = SR * 2
    buf = bytes(st["buf"])
    dur = len(buf) / bytes_per_s

    # End of dictation: flush whatever is left and drop the session.
    if final:
        tail = _transcribe_pcm(buf) if dur >= 0.25 else ""
        with _sessions_lock:
            _sessions.pop(sid, None)
        text = _join(st["committed"] + [tail])
        print(f"[stt] live {sid[:8]} done: {len(text)} chars", flush=True)
        return {"committed": text, "partial": "", "done": True}

    if dur < MIN_PARTIAL_S:
        return {"committed": _join(st["committed"]), "partial": st["partial"], "done": False}

    # Commit on a natural pause (or a monologue that has run long enough to risk quadratic cost).
    tail = buf[-int(SILENCE_S * bytes_per_s):]
    quiet = _rms(tail) < SILENCE_RMS
    spoke = _rms(buf) >= SILENCE_RMS
    if (quiet and spoke and dur >= SILENCE_S + 0.3) or dur >= SEG_MAX_S:
        text = _transcribe_pcm(buf)
        st["buf"] = bytearray()
        st["since"] = 0
        st["partial"] = ""
        if text:
            st["committed"].append(text)
        return {"committed": _join(st["committed"]), "partial": "", "done": False}

    # Otherwise redraw the in-progress segment. The gate is the cost of the LAST pass, not a fixed
    # interval: a short buffer refreshes every chunk, and a long one backs off instead of queueing
    # requests behind each other until the partial text is further behind than it is useful.
    if st["since"] >= max(0.35, _last_ms) * bytes_per_s:
        st["since"] = 0
        st["partial"] = _transcribe_pcm(buf)
    return {"committed": _join(st["committed"]), "partial": st["partial"], "done": False}
# #endregion
