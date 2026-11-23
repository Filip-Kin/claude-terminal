# Phone bridge

Call one phone number and talk to your own `/app` chat. Built so "Hey Google, call Claude" works
from a phone, a watch or a smart speaker. Ported from Brandon McDonald's `deploy/phone/bridge.py`
(brandmcd/claude-terminal 178451b).

## Call flow

1. Twilio posts the call to `POST /twilio/voice`. The request must carry a valid Twilio signature.
2. Caller id picks the user, and so that user's sidecar (owner 7682, guest ttyd port + 100).
   Unknown caller: "This number is private", hang up.
3. `StirVerstat` must be in `attestation` (default `TN-Validation-Passed-A`), so a spoofed caller id
   is refused.
4. The caller's audio is forked to `wss://.../twilio/media`. The first utterance goes to
   `claude-speaker` and must score at least `threshold` against the user's voiceprint.
5. Each utterance becomes a turn in an `/app` chat (`voice: true`, so the reply is short). The
   bridge follows the chat's live stream and reads the text after the last tool call aloud.
6. A turn that runs past `holdSeconds` ends the call and phones back with the answer.

## Parts

| Part | Where | Port |
|---|---|---|
| Bridge (Twilio webhooks, media socket) | `bridge.ts`, `claude-phone.service` | 127.0.0.1:7715, public as `call.filipkin.com` |
| Self-setup page | `setup.ts`, `setup.html`, same service | 127.0.0.1:7716, public as `claude.filipkin.com/_phone/` through claude-router |
| Voiceprint service | `speaker/main.py`, `claude-speaker.service` | 127.0.0.1:7803 |
| Fixed spoken lines | `make-audio.ts` (Kokoro, `claude-tts`) | files in `/var/lib/claude-phone/audio` |
| Admin CLI | `admin.ts` | |

State is in `/var/lib/claude-phone`: `config.json` (users, the Twilio number, overrides of
`DEFAULTS` in `lib.ts`), `voiceprints/<user>.json`, `enroll/<user>` (an open enrolment window),
`calls/<user>/` (first utterance of each call with its score, 30 days, for threshold tuning),
`models/nemo_en_titanet_large.onnx`.

Twilio keys come from the secrets store at start: `twilio/account-sid`, `twilio/auth-token`.

## Setting up a person

The person signs in at `claude.filipkin.com`, opens Phone in the sidebar, saves their number and
opens an enrolment call. The next call from that number within 15 minutes records the voiceprint:
the line says five sentences (`PHRASES` in `lib.ts`), the caller repeats each after the tone, and a
chime confirms it. Enrolling a device again replaces that device's voiceprint. One voiceprint per device type (phone, watch, speaker), because each sounds
different on a call.

By hand: `bun phone/admin.ts add <user> <number>`, `bun phone/admin.ts enroll <user> [label]`,
`bun phone/admin.ts list`.

## Install

```bash
cd phone/speaker && uv sync
curl -L -o /var/lib/claude-phone/models/nemo_en_titanet_large.onnx \
  https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/nemo_en_titanet_large.onnx
bun phone/make-audio.ts
sudo install -m 644 phone/systemd/*.service /etc/systemd/system/ && sudo systemctl enable --now claude-speaker claude-phone
```

Twilio number: voice webhook `https://<host>/twilio/voice`, status callback `https://<host>/twilio/status`.

## Checks

- `bun test phone/`
- `curl 127.0.0.1:7715/health`, `curl 127.0.0.1:7803/health`
- `journalctl -u claude-phone`: one line per call (`incoming`), voice check (`voice <user> pass|fail|short score`), turn and answer time.
