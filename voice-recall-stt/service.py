"""
MEDISYS Voice Patient-Recall — local speech-to-text service
-------------------------------------------------------------
Standalone microservice used ONLY by POST /api/voice/query (see
server/voiceQuery.js) — separate from language/service.py, which is Sarvam
AI's hosted API used for the (unrelated) voice-prescription dictation
feature. This one exists specifically so patient-recall has a genuinely
free, self-hosted STT option: no API key, no per-request cost, no account.

Engine: faster-whisper (a CTranslate2 reimplementation of OpenAI's Whisper)
running locally on CPU. The model is downloaded from Hugging Face the FIRST
time this service starts with a given WHISPER_MODEL_SIZE, then cached in
model_cache/ and reused offline after that — "offline after first run," not
offline from the very first `pip install`.

Always runs Whisper's "translate" task (not "transcribe") regardless of the
spoken language, so /transcribe's output is consistently English text — the
same shape server/voiceQuery.js's name/complaint parser and matching logic
expect, mirroring what language/service.py's Sarvam translation step
produces for the prescription pipeline. If a doctor speaks fully in English
this is a no-op; if they code-switch into Hindi/Marathi mid-sentence, it's
translated same as the rest.

One-time setup:
    cd voice-recall-stt
    python -m venv venv && venv\\Scripts\\activate   (Windows)
    pip install -r requirements.txt

Running:
    python service.py
    # Listens on http://127.0.0.1:8600 by default
"""

import os
import shutil
import tempfile
import logging

from flask import Flask, request, jsonify
from dotenv import load_dotenv
from faster_whisper import WhisperModel

load_dotenv()

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("medisys.voice_recall_stt")

app = Flask(__name__)

MODEL_SIZE = os.environ.get("WHISPER_MODEL_SIZE", "small")
# "small" (~500MB) is the default — real testing against a laptop mic
# showed "base" (~150MB) confidently mis-hearing short "name, complaint"
# phrases (detectedLanguageProbability as low as 0.50, i.e. barely better
# than a coin flip — a strong sign of a model too small for the input, not
# a plumbing bug). "small" trades some speed for materially better accuracy
# on exactly this kind of short, real-world-noisy clip. Go to "medium" if
# it's still not good enough; drop back to "base" only if speed becomes the
# actual bottleneck. See faster-whisper's model list for every option.
DEVICE = os.environ.get("WHISPER_DEVICE", "cpu")
# int8 quantization is the practical default for CPU inference — several
# times faster than float32 with only a small accuracy cost, and doesn't
# need a GPU. Switch to "float16" if WHISPER_DEVICE=cuda on a machine that
# has one.
COMPUTE_TYPE = os.environ.get("WHISPER_COMPUTE_TYPE", "int8")

log.info("Loading Whisper model '%s' (device=%s, compute_type=%s)... first run downloads it from Hugging Face.", MODEL_SIZE, DEVICE, COMPUTE_TYPE)
model = WhisperModel(MODEL_SIZE, device=DEVICE, compute_type=COMPUTE_TYPE, download_root="model_cache")
log.info("Whisper model loaded.")


@app.get("/health")
def health():
    return jsonify({"status": "ok", "model": MODEL_SIZE, "device": DEVICE})


@app.post("/transcribe")
def transcribe():
    """
    Multipart form fields:
      audio - the recorded push-to-talk clip (webm/wav/whatever the browser's
              MediaRecorder produced — faster-whisper decodes it directly,
              no separate ffmpeg conversion step needed).
    No language field: Whisper auto-detects the spoken language and always
    translates to English (see module docstring) — the doctor doesn't pick
    a language for this feature the way the prescription dictation UI does.
    """
    if "audio" not in request.files:
        return jsonify({"error": "No audio file provided"}), 400

    audio_file = request.files["audio"]

    # Buffer to a real temp file rather than handing faster-whisper the raw
    # Werkzeug upload stream directly. A browser MediaRecorder clip is a
    # webm/opus *container* — decoding it needs to seek around that
    # container's structure, which an HTTP request stream can't do (it's
    # forward-only). Passing the stream in didn't raise an exception; it
    # silently decoded as zero/near-zero audio, so /transcribe kept
    # returning 200 with an empty transcript — indistinguishable from
    # "genuine silence" until this was traced. A seekable on-disk file is
    # the documented-safe way to hand faster-whisper an arbitrary container.
    suffix = os.path.splitext(audio_file.filename or "")[1] or ".webm"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        audio_file.save(tmp)
        tmp_path = tmp.name

    # Always overwrites debug_last_clip.<ext> with the most recent upload —
    # gitignored, dev-only troubleshooting aid so a bad transcription can
    # actually be listened to afterward instead of guessed at from logs
    # alone. Cheap (one extra file copy) and safe to leave on permanently:
    # this service only ever runs on localhost.
    try:
        debug_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), f"debug_last_clip{suffix}")
        shutil.copyfile(tmp_path, debug_path)
    except OSError:
        pass

    try:
        audio_bytes = os.path.getsize(tmp_path)
        # vad_filter strips leading/trailing silence and non-speech gaps
        # before they reach the model — meaningfully improves accuracy on
        # real (as opposed to studio-clean) mic input, at negligible cost.
        segments, info = model.transcribe(tmp_path, task="translate", beam_size=5, vad_filter=True)
        transcript = " ".join(segment.text.strip() for segment in segments).strip()
        log.info("Transcribed %d bytes -> %d chars (lang=%s, p=%.2f): %r", audio_bytes, len(transcript), info.language, info.language_probability, transcript[:120])
    except Exception as exc:
        log.exception("Whisper transcription failed")
        return jsonify({"error": "Speech-to-text request failed.", "detail": str(exc)}), 502
    finally:
        try:
            os.remove(tmp_path)
        except OSError:
            pass

    if not transcript:
        # Reachable and ran without error, but recognized no speech at all
        # (silence, clip cut off before any words, mic muted, etc.) — a
        # distinct, honest outcome from a real transcript, NOT an error the
        # caller should paper over. See server/voiceQuery.js: this must not
        # be treated the same as "service unreachable" (which falls back to
        # a mock transcript for dev convenience) — silently substituting a
        # canned demo name here would return a real, but WRONG, patient's
        # data as if it were the actual match, which is worse than clearly
        # failing.
        log.warning("Transcription produced no speech (%d bytes in) — mic may have been muted, clip too short, or recorded silence.", audio_bytes)

    return jsonify({
        "transcript": transcript,
        "detectedLanguage": info.language,
        "detectedLanguageProbability": info.language_probability,
    })


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=int(os.environ.get("PORT", 8600)))
