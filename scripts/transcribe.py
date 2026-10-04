#!/usr/bin/env python3
"""Transcribe a lecture video/audio file (or a URL via yt-dlp) with faster-whisper.

Usage: python transcribe.py <file-or-url> <out.json>
Writes {"file", "title", "duration", "language", "segments": [{"start", "end", "text"}]}.
Audio is decoded to mono 16 kHz float32 ourselves (ffmpeg if present, else PyAV), which avoids
PyAV-version quirks inside faster-whisper's own decoder. Model from $WHISPER_MODEL (default "small").

Local:  uv run --with faster-whisper scripts/transcribe.py lecture.mp4 out.json
"""
import json, os, shutil, subprocess, sys
import numpy as np


def load_audio(path):
    if shutil.which("ffmpeg"):
        raw = subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-i", path, "-f", "f32le", "-ac", "1", "-ar", "16000", "-"],
                             check=True, capture_output=True).stdout
        return np.frombuffer(raw, np.float32).copy()
    import av
    chunks = []
    with av.open(path) as container:
        resampler = av.AudioResampler(format="flt", layout="mono", rate=16000)
        for frame in container.decode(audio=0):
            for f in resampler.resample(frame):
                chunks.append(f.to_ndarray().reshape(-1))
        for f in resampler.resample(None):
            chunks.append(f.to_ndarray().reshape(-1))
    return np.concatenate(chunks).astype(np.float32) if chunks else np.zeros(0, np.float32)


src, out = sys.argv[1], sys.argv[2]
title, downloaded = None, None

if src.startswith(("http://", "https://")):
    import yt_dlp
    opts = {"format": "bestaudio/best", "outtmpl": os.path.join(os.path.dirname(out) or ".", "%(id)s.%(ext)s"), "quiet": True}
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(src, download=True)
        downloaded = ydl.prepare_filename(info)
        title = info.get("title")
    path = downloaded
else:
    path = src

from faster_whisper import WhisperModel

try:
    model = WhisperModel(os.environ.get("WHISPER_MODEL", "small"), device="auto", compute_type="int8")
    audio = load_audio(path)
    segments, info = model.transcribe(audio, vad_filter=True)
    data = {
        "file": os.path.basename(src) if not downloaded else src,
        "title": title,
        "duration": round(len(audio) / 16000, 1),
        "language": info.language,
        "segments": [{"start": round(s.start, 1), "end": round(s.end, 1), "text": s.text.strip()} for s in segments],
    }
    with open(out, "w") as f:
        json.dump(data, f)
finally:
    # Never leave a downloaded video behind, even if transcription fails.
    if downloaded and os.path.exists(downloaded):
        os.remove(downloaded)
print(f"ok {len(data['segments'])} segments, {data['duration']}s")
