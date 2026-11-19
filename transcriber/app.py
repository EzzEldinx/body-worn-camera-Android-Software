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
WHISPER_COMPUTE (default int8), WHISPER_THREADS, PARTIAL_EVERY_S, PARTIAL_WINDOW_S, PAUSE_S, PORT (default 5100), BIND (default 127.0.0.1), MAX_STREAMS (default 8).
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
PAUSE_S = float(os.environ.get("PAUSE_S", "0.6"))             # this much silence ends a sentence (the "final" text)
MIN_S = 0.8                        # shorter than this is a click or a cough: skipped
MAX_S = 12.0                       # a very long sentence is cut here so the text does not lag
PARTIAL_EVERY_S = float(os.environ.get("PARTIAL_EVERY_S", "0.8"))   # while someone is talking, a fresh draft of the text this often (0 = no drafts)
PARTIAL_WINDOW_S = float(os.environ.get("PARTIAL_WINDOW_S", "8"))   # a draft covers the last this-many seconds of the sentence
THREADS = int(os.environ.get("WHISPER_THREADS", "0"))         # 0 = the library's default (4)
DEBUG = os.environ.get("DEBUG") == "1"
SILENCE_RMS = float(os.environ.get("SILENCE_RMS", "0.012"))   # below this (0..1) a frame counts as silence

_model = None
_model_lock = threading.Lock()     # one model, one piece of audio at a time (a second stream waits its turn)
streams = {}                       # cameraId -> Worker
streams_lock = threading.Lock()


def model():
    global _model
    if _model is None:
        from faster_whisper import WhisperModel
        _model = WhisperModel(MODEL_NAME, device=DEVICE, compute_type=COMPUTE, cpu_threads=THREADS)
    return _model


def transcribe(samples, lang):
    with _model_lock:
        segs, info = model().transcribe(
            samples, language=lang, beam_size=1, vad_filter=False, condition_on_previous_text=False,
            temperature=0.0, no_speech_threshold=0.6, without_timestamps=True)
        text = " ".join(s.text.strip() for s in segs).strip()
    return text, info.language


def to_samples(frames):
    return np.frombuffer(b"".join(frames), dtype=np.int16).astype(np.float32) / 32768.0


class Worker(threading.Thread):
    """Two threads per camera: this one only reads the audio and finds the pauses (it never waits for the model, so no audio is lost),
    and `infer` turns what it hands over into text. A finished sentence ("final") is always transcribed; a draft ("partial", sent while the
    person is still talking) is dropped when a newer one or the final arrives, so a slow model shows older drafts less often, never later ones."""

    def __init__(self, camera, url, callback, lang):
        super().__init__(daemon=True)
        self.camera, self.url, self.callback, self.lang = camera, url, callback, lang
        self.stop_flag = threading.Event()
        self.proc = None
        self.started = time.time()
        self.sentences = 0
        self.cv = threading.Condition()
        self.finals = []           # [(utt, samples, t0)]
        self.partial = None        # (utt, samples, t0): only the newest draft is kept
        self.done = False
        self.utt = 0
        self.guess = None          # the language the last finished sentence was in

    def stop(self):
        self.stop_flag.set()
        try:
            if self.proc: self.proc.kill()
        except Exception:
            pass

    def post(self, text, lang, t0, utt, partial):
        body = json.dumps({"cameraId": self.camera, "text": text, "lang": lang, "ts": int(t0 * 1000), "utt": utt, "partial": partial}).encode()
        req = urllib.request.Request(self.callback, data=body, headers={"content-type": "application/json", "x-transcribe-token": TOKEN})
        try:
            urllib.request.urlopen(req, timeout=8).read()
        except Exception as e:
            print(f"[{self.camera}] callback failed: {e}", file=sys.stderr, flush=True)

    def hand_over(self, kind, utt, frames, t0):
        with self.cv:
            if kind == "final":
                if len(frames) * FRAME < MIN_S * RATE: return
                self.finals.append((utt, to_samples(frames), t0))
                if self.partial and self.partial[0] == utt: self.partial = None
            else:
                self.partial = (utt, to_samples(frames), t0)
            self.cv.notify()

    def infer(self):
        while True:
            with self.cv:
                while not self.finals and self.partial is None and not self.done:
                    self.cv.wait()
                if self.finals:
                    kind, (utt, samples, t0) = "final", self.finals.pop(0)
                elif self.partial is not None:
                    kind, (utt, samples, t0) = "partial", self.partial
                    self.partial = None
                else:
                    return
            if DEBUG: print(f"[{self.camera}] {kind} {utt}: {len(samples) / RATE:.1f} s of audio -> model", flush=True)
            t = time.time()
            try:
                # a draft is a short clip, where guessing the language goes wrong: it takes the language the last full sentence had
                text, lang = transcribe(samples, self.lang or (self.guess if kind == "partial" else None))
                if kind == "final" and lang: self.guess = lang
            except Exception as e:
                print(f"[{self.camera}] transcribe failed: {e}", file=sys.stderr, flush=True)
                continue
            if DEBUG: print(f"[{self.camera}] {kind} {utt} in {time.time() - t:.1f} s: {text!r}", flush=True)
            if kind == "partial":
                with self.cv:
                    if any(f[0] == utt for f in self.finals): continue   # the final of this sentence is already waiting: the draft is old news
            if text and len(text) > 1:
                if kind == "final": self.sentences += 1
                self.post(text, lang, t0, utt, kind == "partial")

    def run(self):
        cmd = [FFMPEG, "-nostdin", "-loglevel", "error", "-i", self.url, "-vn", "-ac", "1", "-ar", str(RATE), "-f", "s16le", "-"]
        try:
            self.proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=None if DEBUG else subprocess.DEVNULL)
        except Exception as e:
            print(f"[{self.camera}] cannot start ffmpeg: {e}", file=sys.stderr, flush=True)
            return
        worker = threading.Thread(target=self.infer, daemon=True); worker.start()
        buf, quiet, t0, last_draft = [], 0, time.time(), 0
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
                    if not buf: t0 = time.time(); self.utt += 1; last_draft = 0
                    buf.append(chunk); quiet = 0
                elif buf:
                    buf.append(chunk); quiet += 1
                    if quiet * FRAME / RATE >= PAUSE_S:
                        self.hand_over("final", self.utt, buf, t0); buf, quiet = [], 0
                        continue
                if buf and len(buf) * FRAME / RATE >= MAX_S:
                    self.hand_over("final", self.utt, buf, t0); buf, quiet = [], 0
                elif buf and PARTIAL_EVERY_S > 0 and len(buf) * FRAME >= MIN_S * RATE and (len(buf) - last_draft) * FRAME >= PARTIAL_EVERY_S * RATE:
                    last_draft = len(buf)
                    self.hand_over("partial", self.utt, buf[-int(PARTIAL_WINDOW_S * RATE / FRAME):], t0)
            if buf and not self.stop_flag.is_set():
                self.hand_over("final", self.utt, buf, t0)
        finally:
            with self.cv:
                self.done = True; self.cv.notify()
            worker.join(15)
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
