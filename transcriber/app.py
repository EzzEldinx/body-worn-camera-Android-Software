#!/usr/bin/env python3
"""VisionGuard live transcription sidecar.

The VisionGuard server asks this service to listen to one camera's live stream (POST /start with a signed RTMP URL).
It pulls the audio with ffmpeg, cuts it into sentences at the pauses, turns each sentence into text with Whisper
(faster-whisper, runs on a CPU, a GPU makes it faster) and posts every sentence back to the server (the callback URL).
It keeps no audio and no text: it only forwards them. It can run on the same machine as the server or on another one.

  POST /start  {"cameraId": "BWC-01-RIY", "url": "rtmp://.../live/BWC-01-RIY?sign=...", "callback": "http://.../api/internal/transcript", "lang": "ar"|"en"|null}
  POST /stop   {"cameraId": "BWC-01-RIY"}
  GET  /health -> {"ok": true, "model": "...", "streams": [...]}

Every request must carry the header  x-transcribe-token: <TRANSCRIBE_TOKEN>.
Settings (environment): TRANSCRIBE_TOKEN (required), WHISPER_MODEL (default small), WHISPER_DEVICE (cpu|cuda, default cpu),
WHISPER_COMPUTE (default int8), PORT (default 5100), BIND (default 127.0.0.1), MAX_STREAMS (default 8).
"""
import json, os, subprocess, sys, threading, time, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

TOKEN = os.environ.get("TRANSCRIBE_TOKEN", "")
MODEL_NAME = os.environ.get("WHISPER_MODEL", "small")
DEVICE = os.environ.get("WHISPER_DEVICE", "cpu")
COMPUTE = os.environ.get("WHISPER_COMPUTE", "int8")
PORT = int(os.environ.get("PORT", "5100"))
BIND = os.environ.get("BIND", "127.0.0.1")
MAX_STREAMS = int(os.environ.get("MAX_STREAMS", "8"))
FFMPEG = os.environ.get("FFMPEG", "ffmpeg")

RATE = 16000                       # Whisper wants 16 kHz mono
FRAME = RATE // 50                 # 20 ms
PAUSE_S = 0.7                      # this much silence ends a sentence
MIN_S = 0.8                        # shorter than this is a click or a cough: skipped
MAX_S = 12.0                       # a very long sentence is cut here so the text does not lag
DEBUG = os.environ.get("DEBUG") == "1"
SILENCE_RMS = float(os.environ.get("SILENCE_RMS", "0.012"))   # below this (0..1) a frame counts as silence

_model = None
_model_lock = threading.Lock()     # one model, one sentence at a time (a second stream waits its turn)
streams = {}                       # cameraId -> Worker
streams_lock = threading.Lock()


def model():
    global _model
    if _model is None:
        from faster_whisper import WhisperModel
        _model = WhisperModel(MODEL_NAME, device=DEVICE, compute_type=COMPUTE)
    return _model


def transcribe(samples, lang):
    with _model_lock:
        segs, info = model().transcribe(
            samples, language=lang, beam_size=1, vad_filter=False, condition_on_previous_text=False,
            temperature=0.0, no_speech_threshold=0.6, without_timestamps=True)
        text = " ".join(s.text.strip() for s in segs).strip()
    return text, info.language


class Worker(threading.Thread):
    def __init__(self, camera, url, callback, lang):
        super().__init__(daemon=True)
        self.camera, self.url, self.callback, self.lang = camera, url, callback, lang
        self.stop_flag = threading.Event()
        self.proc = None
        self.started = time.time()
        self.sentences = 0

    def stop(self):
        self.stop_flag.set()
        try:
            if self.proc: self.proc.kill()
        except Exception:
            pass

    def post(self, text, lang, t0):
        body = json.dumps({"cameraId": self.camera, "text": text, "lang": lang, "ts": int(t0 * 1000)}).encode()
        req = urllib.request.Request(self.callback, data=body, headers={"content-type": "application/json", "x-transcribe-token": TOKEN})
        try:
            urllib.request.urlopen(req, timeout=8).read()
        except Exception as e:
            print(f"[{self.camera}] callback failed: {e}", file=sys.stderr, flush=True)

    def flush(self, buf, t0):
        if len(buf) * FRAME < MIN_S * RATE:   # buf holds 20 ms frames
            return
        samples = np.frombuffer(b"".join(buf), dtype=np.int16).astype(np.float32) / 32768.0
        if DEBUG: print(f"[{self.camera}] sentence of {len(samples) / RATE:.1f} s -> model", flush=True)
        try:
            text, lang = transcribe(samples, self.lang)
        except Exception as e:
            print(f"[{self.camera}] transcribe failed: {e}", file=sys.stderr, flush=True)
            return
        if DEBUG: print(f"[{self.camera}] text: {text!r}", flush=True)
        if text and len(text) > 1:
            self.sentences += 1
            self.post(text, lang, t0)

    def run(self):
        cmd = [FFMPEG, "-nostdin", "-loglevel", "error", "-i", self.url, "-vn", "-ac", "1", "-ar", str(RATE), "-f", "s16le", "-"]
        try:
            self.proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=None if DEBUG else subprocess.DEVNULL)
        except Exception as e:
            print(f"[{self.camera}] cannot start ffmpeg: {e}", file=sys.stderr, flush=True)
            return
        buf, speech, quiet, t0 = [], 0, 0, time.time()
        if DEBUG: print(f"[{self.camera}] listening", flush=True)
        try:
            while not self.stop_flag.is_set():
                chunk = self.proc.stdout.read(FRAME * 2)
                if not chunk or len(chunk) < FRAME * 2:
                    if DEBUG: print(f"[{self.camera}] stream ended (read {len(chunk)} bytes, ffmpeg exit {self.proc.poll()})", flush=True)
                    break
                x = np.frombuffer(chunk, dtype=np.int16).astype(np.float32) / 32768.0
                loud = float(np.sqrt(np.mean(x * x))) > SILENCE_RMS
                if loud:
                    if not buf: t0 = time.time()
                    buf.append(chunk); speech += 1; quiet = 0
                elif buf:
                    buf.append(chunk); quiet += 1
                    if quiet * FRAME / RATE >= PAUSE_S:
                        self.flush(buf, t0); buf, speech, quiet = [], 0, 0
                if buf and len(buf) * FRAME / RATE >= MAX_S:
                    self.flush(buf, t0); buf, speech, quiet = [], 0, 0
            if buf and not self.stop_flag.is_set():
                self.flush(buf, t0)
        finally:
            self.stop()
            with streams_lock:
                if streams.get(self.camera) is self:
                    del streams[self.camera]
            print(f"[{self.camera}] stream closed after {int(time.time() - self.started)} s, {self.sentences} sentences", flush=True)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def reply(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code); self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(body))); self.end_headers()
        self.wfile.write(body)

    def authorised(self):
        return bool(TOKEN) and self.headers.get("x-transcribe-token", "") == TOKEN

    def do_GET(self):
        if not self.authorised(): return self.reply(401, {"error": "unauthorised"})
        if self.path == "/health":
            with streams_lock:
                return self.reply(200, {"ok": True, "model": MODEL_NAME, "device": DEVICE, "streams": sorted(streams)})
        self.reply(404, {"error": "not found"})

    def do_POST(self):
        if not self.authorised(): return self.reply(401, {"error": "unauthorised"})
        try:
            n = int(self.headers.get("content-length", "0"))
            d = json.loads(self.rfile.read(min(n, 65536)) or b"{}")
        except Exception:
            return self.reply(400, {"error": "bad json"})
        cam = str(d.get("cameraId", ""))[:80]
        if not cam: return self.reply(400, {"error": "cameraId missing"})
        if self.path == "/start":
            url, cb = str(d.get("url", "")), str(d.get("callback", ""))
            if not (url.startswith("rtmp://") or url.startswith("rtmps://")) or not cb.startswith("http"):
                return self.reply(400, {"error": "url must be rtmp(s):// and callback http(s)://"})
            lang = d.get("lang") if d.get("lang") in ("ar", "en") else None
            with streams_lock:
                old = streams.pop(cam, None)
                if old: old.stop()
                if len(streams) >= MAX_STREAMS: return self.reply(429, {"error": "too many streams"})
                w = Worker(cam, url, cb, lang); streams[cam] = w; w.start()
            return self.reply(200, {"ok": True})
        if self.path == "/stop":
            with streams_lock:
                w = streams.pop(cam, None)
            if w: w.stop()
            return self.reply(200, {"ok": True, "was": bool(w)})
        self.reply(404, {"error": "not found"})


if __name__ == "__main__":
    if not TOKEN:
        sys.exit("TRANSCRIBE_TOKEN is not set")
    print(f"loading model '{MODEL_NAME}' on {DEVICE} ({COMPUTE})...", flush=True)
    t = time.time(); model(); print(f"model ready in {time.time() - t:.1f} s; listening on {BIND}:{PORT}", flush=True)
    ThreadingHTTPServer((BIND, PORT), Handler).serve_forever()
