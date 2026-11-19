# VisionGuard live transcription service

Turns what a streaming camera hears into text, a sentence at a time. It is a small separate service (Python, Whisper through
`faster-whisper`) so the heavy work never runs inside the VisionGuard server, and it can later move to its own machine or a GPU box.

How it works: when a camera starts streaming, the VisionGuard server (only for a company that has the **Live captions** permission)
tells this service to listen; the service pulls the audio with ffmpeg, cuts it at pauses, transcribes each sentence and posts it back to
`/api/internal/transcript`. The server keeps the text (30 days by default, `TRANSCRIPT_DAYS`) and shows it live under the camera on the
dashboard. The service itself stores nothing.

Settings: `TRANSCRIBE_TOKEN` (required, shared with the server), `WHISPER_MODEL` (`small` default; `base` is faster and less exact, `medium` better and slower),
`WHISPER_DEVICE` (`cpu` or `cuda`), `MAX_STREAMS` (default 8), `SILENCE_RMS`, `DEBUG=1`.
Server side: `TRANSCRIBE_URL`, `TRANSCRIBE_TOKEN`, `TRANSCRIBE_RTMP_HOST`, `TRANSCRIBE_CALLBACK_BASE`, `TRANSCRIBE_LANG` (`ar`/`en`, empty = automatic), `TRANSCRIPT_DAYS`.

Run it next to the server: see `deploy/docker-compose.transcribe.yml`. To try it on a laptop: install `ffmpeg`, `pip install -r requirements.txt`,
then `TRANSCRIBE_TOKEN=secret python3 app.py` and start the server with `TRANSCRIBE_URL=http://127.0.0.1:5100 TRANSCRIBE_TOKEN=secret`.

Measured (2026-11-19, Apple M4 Max, CPU only, model `small`): a 10 second sentence took about 2 seconds, text appears about 2 s after the speaker pauses.
Not measured yet: a Linux server CPU, noisy street audio, Saudi dialects, many cameras at once.
