# claude-tts — local neural text-to-speech for the chat app's hands-free voice mode.
#
# Kokoro-82M: high-quality open TTS that runs comfortably on CPU. The chat app streams
# Claude's reply, chunks it by sentence, and POSTs each sentence here; we synthesise it
# to a WAV the browser plays in a queue, so Claude starts talking before the whole reply
# is done. Keeping requests per-sentence is what makes first-audio latency low.
#
# Binds loopback only; the claude-terminal sidecar proxies it at /app/api/tts and
# owner-gates the request. Never exposed directly.
import io
import os
import time

import numpy as np
import soundfile as sf
from fastapi import FastAPI
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel
from kokoro import KPipeline

SR = 24000  # Kokoro's native sample rate
LANG = os.environ.get("TTS_LANG", "a")          # 'a' = American English, 'b' = British
DEFAULT_VOICE = os.environ.get("TTS_VOICE", "af_heart")

# Kokoro is torch/CPU-bound; cap threads so it shares the box with STT + the sidecar.
try:
    import torch
    torch.set_num_threads(int(os.environ.get("TTS_THREADS", "8")))
except Exception:  # noqa: BLE001
    pass

print(f"[tts] loading Kokoro-82M lang={LANG} voice={DEFAULT_VOICE}", flush=True)
_t0 = time.time()
pipeline = KPipeline(lang_code=LANG)
# warm the graph + voice tensor so the first real request isn't the cold one
try:
    for _ in pipeline("Ready.", voice=DEFAULT_VOICE):
        pass
except Exception as e:  # noqa: BLE001
    print(f"[tts] warm failed: {e}", flush=True)
print(f"[tts] ready in {time.time() - _t0:.1f}s", flush=True)

app = FastAPI()


class SpeakReq(BaseModel):
    text: str
    voice: str | None = None
    speed: float = 1.0


@app.get("/health")
def health():
    return {"ok": True, "voice": DEFAULT_VOICE, "lang": LANG, "sr": SR}


@app.post("/speak")
def speak(req: SpeakReq):
    text = (req.text or "").strip()
    if not text:
        return JSONResponse({"error": "empty text"}, status_code=400)
    voice = req.voice or DEFAULT_VOICE
    t0 = time.time()
    try:
        chunks = [audio for _, _, audio in pipeline(text, voice=voice, speed=req.speed)]
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"error": f"synthesis failed: {e}"}, status_code=500)
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
