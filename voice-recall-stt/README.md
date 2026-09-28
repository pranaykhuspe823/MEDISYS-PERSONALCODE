# MEDISYS — Voice Patient-Recall STT (self-hosted, free)

Local speech-to-text for the hands-free Patient Recall feature (Press-and-hold
mic on the doctor's **My Queue** page → `POST /api/voice/query`). Separate
from `language/service.py` (Sarvam AI, used only by the unrelated
voice-*prescription* dictation feature) — this one exists so patient-recall
has no API key, no account, and no per-request cost.

## Why this lives in its own folder

Same reasoning as `language/`: `server/` (Node/Express) stays untouched
except for one proxy call (`transcribeAudio()` in `server/voiceQuery.js`)
that forwards the recorded clip to this service over local HTTP.

## Engine: faster-whisper (local, CPU)

Runs OpenAI's Whisper model locally via
[faster-whisper](https://github.com/SYSTRAN/faster-whisper) — no GPU
required, no API key ever. The model weights (~150MB for the default `base`
size) download from Hugging Face **the first time** this service starts,
then are cached in `model_cache/` and reused completely offline after that.

## One-time setup

```bash
cd voice-recall-stt
python -m venv venv
venv\Scripts\activate        # Windows — use `source venv/bin/activate` on macOS/Linux
pip install -r requirements.txt
```

No `.env` is required — everything has a working default. Copy
`.env.example` to `.env` only if you want a bigger/smaller model or a
different port.

## Running

```bash
cd voice-recall-stt
venv\Scripts\activate
python service.py
# Listens on http://127.0.0.1:8600 by default — first start downloads the
# model, which needs internet just that once.
```

The Node backend expects this service at `http://127.0.0.1:8600` by
default — override with `VOICE_RECALL_STT_URL` in `server/.env` if it runs
elsewhere. Without this service reachable, `server/voiceQuery.js` falls back
to `VOICE_QUERY_MOCK_TRANSCRIPT` so the rest of the pipeline still works for
development.

## Endpoints

- `GET /health` — readiness + which model size is loaded.
- `POST /transcribe` — multipart `audio` (whatever the browser's
  `MediaRecorder` produced, e.g. webm — faster-whisper decodes it directly).
  Returns `{ transcript, detectedLanguage, detectedLanguageProbability }`.
  Always runs Whisper's "translate" task, so `transcript` is English
  regardless of what language was spoken.

## Notes

- First request after startup is slower (model warm-up); subsequent ones are
  fast on CPU with the default `base` size + int8 quantization.
- If transcripts come back inaccurate for short "name, complaint" phrases,
  try `WHISPER_MODEL_SIZE=small` (slower, more accurate) in `.env`.
- If audio decoding ever fails, faster-whisper's bundled decoder normally
  handles webm/wav without a system `ffmpeg` install — but installing
  `ffmpeg` and having it on `PATH` is a reasonable first thing to try if
  `/transcribe` errors on a specific browser's recording format.
