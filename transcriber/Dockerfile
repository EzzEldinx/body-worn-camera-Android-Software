# VisionGuard live transcription service (Whisper on a CPU; see README.md)
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py .
RUN useradd -m asr && mkdir -p /models && chown asr /models
USER asr
# the model is downloaded once into this volume (about 480 MB for "small") and reused
ENV HF_HOME=/models BIND=0.0.0.0 PORT=5100
EXPOSE 5100
CMD ["python", "app.py"]
