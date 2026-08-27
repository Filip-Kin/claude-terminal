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

from fastapi import FastAPI, UploadFile, File, Form
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
