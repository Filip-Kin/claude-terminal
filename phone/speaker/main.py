# claude-speaker: voiceprint check for the phone bridge.
#
# The bridge posts the caller's first utterance (Twilio media stream: mu-law, 8 kHz, mono). We keep
# the voiced part, compute a speaker embedding (NeMo TitaNet-large through sherpa-onnx; its training
# data includes telephone speech) and score it against the voiceprints enrolled for that user.
# Loopback only. Voiceprints and the last utterances live under PHONE_STATE.
import base64
import json
import os
import time
import wave
from pathlib import Path

import numpy as np
import sherpa_onnx
from fastapi import FastAPI
from pydantic import BaseModel
from scipy.signal import resample_poly

STATE = Path(os.environ.get("PHONE_STATE", "/var/lib/claude-phone"))
MODEL = os.environ.get("SPEAKER_MODEL", str(STATE / "models" / "nemo_en_titanet_large.onnx"))
PRINTS = STATE / "voiceprints"
CALLS = STATE / "calls"          # first utterance of each call, kept for threshold tuning
KEEP_CALL_DAYS = 30
SR_IN, SR = 8000, 16000

# region audio
_MULAW = None


def mulaw_to_float(data: bytes) -> np.ndarray:
    """G.711 mu-law bytes to float32 in -1..1."""
    global _MULAW
    if _MULAW is None:
        u = ~np.arange(256, dtype=np.uint8)
        t = ((u & 0x0F).astype(np.int32) << 3) + 0x84
        t <<= (u & 0x70) >> 4
        _MULAW = (np.where(u & 0x80, 0x84 - t, t - 0x84) / 32768.0).astype(np.float32)
    return _MULAW[np.frombuffer(data, dtype=np.uint8)]


def voiced(x: np.ndarray, sr: int) -> np.ndarray:
    """Energy gate: keep 20 ms frames well above the noise floor, plus 100 ms either side."""
    n = sr // 50
    frames = x[: len(x) // n * n].reshape(-1, n)
    if len(frames) == 0:
        return x[:0]
    db = 10 * np.log10((frames**2).mean(axis=1) + 1e-10)
    floor = np.percentile(db, 10)
    keep = db > max(floor + 12, -50)
    keep = np.convolve(keep, np.ones(11), mode="same") > 0
    return frames[keep].reshape(-1)


def prepare(b64: str) -> tuple[np.ndarray, int, np.ndarray]:
    """Returns (voiced 16 kHz audio, voiced ms, raw 8 kHz audio)."""
    raw = mulaw_to_float(base64.b64decode(b64))
    v = voiced(raw, SR_IN)
    ms = int(len(v) * 1000 / SR_IN)
    return resample_poly(v, 2, 1).astype(np.float32), ms, raw
# endregion

# region model
_extractor = sherpa_onnx.SpeakerEmbeddingExtractor(
    sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=MODEL, num_threads=int(os.environ.get("SPEAKER_THREADS", "4")), provider="cpu")
)


def embed(x: np.ndarray) -> np.ndarray:
    s = _extractor.create_stream()
    s.accept_waveform(sample_rate=SR, waveform=x)
    s.input_finished()
    e = np.asarray(_extractor.compute(s), dtype=np.float32)
    return e / (np.linalg.norm(e) + 1e-9)
# endregion

# region voiceprints
def load(user: str) -> dict[str, list[list[float]]]:
    f = PRINTS / f"{user}.json"
    return json.loads(f.read_text()) if f.exists() else {}


def save(user: str, prints: dict[str, list[list[float]]]) -> None:
    PRINTS.mkdir(parents=True, exist_ok=True)
    tmp = PRINTS / f"{user}.json.tmp"
    tmp.write_text(json.dumps(prints))
    tmp.replace(PRINTS / f"{user}.json")


def score(prints: dict[str, list[list[float]]], e: np.ndarray) -> tuple[float, str]:
    """Cosine against each label's centroid (one label per device type); the best label wins."""
    best, where = -1.0, ""
    for label, vecs in prints.items():
        c = np.mean(np.asarray(vecs, dtype=np.float32), axis=0)
        s = float(np.dot(c / (np.linalg.norm(c) + 1e-9), e))
        if s > best:
            best, where = s, label
    return best, where


def keep_call(user: str, call: str, raw: np.ndarray, meta: dict) -> None:
    d = CALLS / user
    d.mkdir(parents=True, exist_ok=True)
    cutoff = time.time() - KEEP_CALL_DAYS * 86400
    for old in d.iterdir():
        if old.stat().st_mtime < cutoff:
            old.unlink()
    stem = f"{time.strftime('%Y%m%d-%H%M%S')}-{''.join(ch for ch in call if ch.isalnum())[-8:]}"
    with wave.open(str(d / f"{stem}.wav"), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR_IN)
        w.writeframes((np.clip(raw, -1, 1) * 32767).astype(np.int16).tobytes())
    (d / f"{stem}.json").write_text(json.dumps(meta))
# endregion

app = FastAPI()
USER_OK = __import__("re").compile(r"^[a-z0-9_-]{1,32}$")


class Clip(BaseModel):
    user: str
    audio: str            # base64 mu-law 8 kHz
    label: str = "phone"  # enrol: which device type this sample came from
    call: str = ""


@app.get("/health")
def health():
    return {"ok": True, "model": Path(MODEL).name, "dim": _extractor.dim}


@app.get("/users")
def users():
    out = {}
    for f in sorted(PRINTS.glob("*.json")):
        out[f.stem] = {label: len(v) for label, v in json.loads(f.read_text()).items()}
    return out


@app.post("/enroll")
def enroll(c: Clip):
    if not USER_OK.match(c.user) or not USER_OK.match(c.label):
        return {"error": "bad user or label", "speechMs": 0}
    x, ms, _ = prepare(c.audio)
    if ms < 3000:  # too little speech to be a useful sample
        return {"speechMs": 0, "skipped": True}
    prints = load(c.user)
    prints.setdefault(c.label, []).append(embed(x).tolist())
    save(c.user, prints)
    return {"speechMs": ms, "samples": len(prints[c.label])}


@app.post("/verify")
def verify(c: Clip):
    if not USER_OK.match(c.user):
        return {"enrolled": False, "score": None, "speechMs": 0}
    prints = load(c.user)
    x, ms, raw = prepare(c.audio)
    if not prints:
        return {"enrolled": False, "score": None, "speechMs": ms}
    if ms < 500:
        s, where = None, ""
    else:
        s, where = score(prints, embed(x))
    keep_call(c.user, c.call, raw, {"score": s, "label": where, "speechMs": ms})
    print(f"[speaker] verify {c.user} score={s} label={where} speech={ms}ms", flush=True)
    return {"enrolled": True, "score": s, "label": where, "speechMs": ms}
