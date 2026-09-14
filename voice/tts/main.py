# claude-tts — local neural text-to-speech for the chat app's hands-free voice mode.
#
# Kokoro-82M: high-quality open TTS that runs comfortably on CPU. The chat app streams
# Claude's reply, chunks it by sentence, and POSTs each sentence here; we synthesise it
# to a WAV the browser plays in a queue, so Claude starts talking before the whole reply
# is done. Keeping requests per-sentence is what makes first-audio latency low.
#
# Binds loopback only; the claude-terminal sidecar proxies it at /app/api/tts and
# owner-gates the request. Never exposed directly.
import ctypes
import gc
import io
import os
import threading
import time

import numpy as np
import soundfile as sf
from fastapi import FastAPI
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel

SR = 24000  # Kokoro's native sample rate
LANG = os.environ.get("TTS_LANG", "a")          # 'a' = American English, 'b' = British
DEFAULT_VOICE = os.environ.get("TTS_VOICE", "af_heart")

# Seconds without a /speak before the model is dropped from memory. 0 (the default) keeps the
# original behaviour: load at startup and stay loaded. Any other value loads the model on the
# first request instead and frees it after that long idle, for boxes where ~1 GB held by a voice
# mode nobody is using pushes Claude sessions into swap. Measured on a 2-vCPU / 4 GB box:
# loaded ~1.1-1.2 GB RSS, unloaded ~450 MB, never loaded 52 MB. The first sentence after an idle
# spell waits for the load: ~4s there, ~10s for the very first one since that also imports torch.
IDLE_UNLOAD_S = float(os.environ.get("TTS_IDLE_UNLOAD_S", "0"))

_lock = threading.Lock()  # guards _pipeline, _busy and _last_used
_pipeline = None
_busy = 0                 # requests currently synthesising; the model is never freed under one
_last_used = time.time()


def _load():
    # torch and kokoro are imported here rather than at the top so a lazily-loading service
    # that has not spoken yet never pays for torch (~350 MB on its own).
    import torch
    from kokoro import KPipeline

    # Kokoro is torch/CPU-bound; cap threads so it shares the box with STT + the sidecar.
    try:
        torch.set_num_threads(int(os.environ.get("TTS_THREADS", "8")))
    except Exception:  # noqa: BLE001
        pass

    print(f"[tts] loading Kokoro-82M lang={LANG} voice={DEFAULT_VOICE}", flush=True)
    t0 = time.time()
    pipeline = KPipeline(lang_code=LANG)
    # warm the graph + voice tensor so the first real request isn't the cold one
    try:
        for _ in pipeline("Ready.", voice=DEFAULT_VOICE):
            pass
    except Exception as e:  # noqa: BLE001
        print(f"[tts] warm failed: {e}", flush=True)
    print(f"[tts] ready in {time.time() - t0:.1f}s", flush=True)
    return pipeline


def _acquire():
    global _pipeline, _busy
    with _lock:  # held through a load, so concurrent first requests wait for one load
        if _pipeline is None:
            _pipeline = _load()
        _busy += 1
        return _pipeline


def _release():
    global _busy, _last_used
    with _lock:
        _busy -= 1
        _last_used = time.time()


def _unload_when_idle():
    global _pipeline
    while True:
        time.sleep(min(30.0, IDLE_UNLOAD_S))
        with _lock:
            if _pipeline is None or _busy or time.time() - _last_used < IDLE_UNLOAD_S:
                continue
            _pipeline = None
        gc.collect()
        # glibc keeps freed heap mapped, so dropping the model alone only takes RSS from ~1080
        # to ~820 MB. malloc_trim hands it back to the OS (-> ~430 MB). Not glibc: skip it.
        try:
            ctypes.CDLL("libc.so.6").malloc_trim(0)
        except (OSError, AttributeError):
            pass
        print(f"[tts] unloaded after {IDLE_UNLOAD_S:.0f}s idle", flush=True)


if IDLE_UNLOAD_S > 0:
    print(f"[tts] model loads on first request, unloads after {IDLE_UNLOAD_S:.0f}s idle", flush=True)
    threading.Thread(target=_unload_when_idle, daemon=True).start()
else:
    _pipeline = _load()

app = FastAPI()


class SpeakReq(BaseModel):
    text: str
    voice: str | None = None
    speed: float = 1.0


@app.get("/health")
def health():
    return {"ok": True, "voice": DEFAULT_VOICE, "lang": LANG, "sr": SR, "loaded": _pipeline is not None}


@app.post("/speak")
def speak(req: SpeakReq):
    text = (req.text or "").strip()
    if not text:
        return JSONResponse({"error": "empty text"}, status_code=400)
    voice = req.voice or DEFAULT_VOICE
    t0 = time.time()
    try:
        pipeline = _acquire()
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"error": f"model load failed: {e}"}, status_code=500)
    try:
        chunks = [audio for _, _, audio in pipeline(text, voice=voice, speed=req.speed)]
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"error": f"synthesis failed: {e}"}, status_code=500)
    finally:
        _release()
    if not chunks:
        return JSONResponse({"error": "no audio produced"}, status_code=500)
    audio = np.concatenate(chunks) if len(chunks) > 1 else chunks[0]
    audio = np.asarray(audio, dtype=np.float32)

    buf = io.BytesIO()
    sf.write(buf, audio, SR, format="WAV", subtype="PCM_16")
    data = buf.getvalue()
    dt = time.time() - t0
    dur = len(audio) / SR
    print(f"[tts] {len(text)} chars -> {dur:.2f}s audio in {dt:.2f}s (rtf {dt / max(dur, 0.01):.2f})", flush=True)
    return Response(
        content=data,
        media_type="audio/wav",
        headers={"X-Audio-Seconds": f"{dur:.3f}", "X-Synth-Seconds": f"{dt:.3f}"},
    )
