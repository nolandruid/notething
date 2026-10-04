import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { opt, ROOT } from "./env.js";

export const VIDEO_EXT = new Set([".mp4", ".mov", ".mkv", ".webm", ".m4a", ".mp3", ".wav"]);
export const isVideo = (f: string) => VIDEO_EXT.has(path.extname(f).toLowerCase());

export interface Transcript {
  file: string;
  title?: string | null;
  duration: number;
  segments: { start: number; end: number; text: string }[];
}

const REMOTE_DIR = "/tmp/notething";
const transcriptDir = (courseDir: string) => path.join(courseDir, ".transcripts");

/** Cache path: content/<course>/.transcripts/<video filename>.json (or <url-hash>.json for URLs). */
export function transcriptPath(courseDir: string, source: string) {
  const name = source.startsWith("http") ? `url-${crypto.createHash("sha256").update(source).digest("hex").slice(0, 12)}` : path.basename(source);
  return path.join(transcriptDir(courseDir), `${name}.json`);
}

/** Find an existing transcript for a local video (accepts <name>.mp4.json or <name>.json). */
export function cachedTranscript(courseDir: string, source: string): Transcript | undefined {
  const candidates = [transcriptPath(courseDir, source)];
  if (!source.startsWith("http")) candidates.push(path.join(transcriptDir(courseDir), `${path.parse(source).name}.json`));
  for (const p of candidates) if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  return undefined;
}

const ssh = (host: string, cmd: string) => execFileSync("ssh", [host, cmd], { stdio: ["ignore", "pipe", "inherit"] }).toString();
const scp = (from: string, to: string) => execFileSync("scp", ["-q", from, to], { stdio: "inherit" });

/**
 * Transcribe a local video file or URL with faster-whisper.
 * Default: locally via `uv run --with faster-whisper scripts/transcribe.py`.
 * Optional: on a remote box over SSH when TRANSCRIBE_SSH_HOST is set (uploads are deleted afterwards).
 * Output is cached at content/<course>/.transcripts/<video filename>.json and reused.
 */
export function transcribe(courseDir: string, source: string): Transcript | undefined {
  const cached = cachedTranscript(courseDir, source);
  if (cached) return cached;
  const out = transcriptPath(courseDir, source);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const host = opt("TRANSCRIBE_SSH_HOST");
  const model = opt("WHISPER_MODEL", "small");
  const isUrl = source.startsWith("http");
  console.log(`  ⇣ Transcribing ${isUrl ? source : path.basename(source)} ${host ? `on ${host}` : "locally"} (whisper ${model})…`);
  try {
    if (host) remoteTranscribe(host, source, out, model);
    else {
      const args = ["run", "--with", "faster-whisper", ...(isUrl ? ["--with", "yt-dlp"] : []), path.join(ROOT, "scripts", "transcribe.py"), source, out];
      execFileSync("uv", args, { stdio: "inherit", env: { ...process.env, WHISPER_MODEL: model } });
    }
  } catch (e) {
    console.warn(`  ! Transcription failed for ${source}: ${(e as Error).message}\n    (local mode needs uv: https://docs.astral.sh/uv/ — or set TRANSCRIBE_SSH_HOST)`);
    return undefined;
  }
  const t: Transcript = JSON.parse(fs.readFileSync(out, "utf8"));
  if (!isUrl) t.file = path.basename(source);
  fs.writeFileSync(out, JSON.stringify(t));
  return t;
}

function remoteTranscribe(host: string, source: string, out: string, model: string) {
  const py = opt("TRANSCRIBE_PYTHON", "~/notething-venv/bin/python");
  const id = crypto.randomBytes(6).toString("hex");
  const isUrl = source.startsWith("http");
  const remoteIn = isUrl ? source : `${REMOTE_DIR}/${id}${path.extname(source)}`;
  const remoteOut = `${REMOTE_DIR}/${id}.json`;
  try {
    ssh(host, `mkdir -p ${REMOTE_DIR}`);
    scp(path.join(ROOT, "scripts", "transcribe.py"), `${host}:${REMOTE_DIR}/transcribe.py`);
    if (!isUrl) scp(source, `${host}:${remoteIn}`);
    const quotedIn = `'${remoteIn.replace(/'/g, "'\\''")}'`;
    ssh(host, `WHISPER_MODEL=${model} ${py} ${REMOTE_DIR}/transcribe.py ${quotedIn} ${remoteOut}`);
    scp(`${host}:${remoteOut}`, out);
  } finally {
    // Remote disk can be tight: always clean up what we uploaded.
    try { ssh(host, `rm -f ${isUrl ? "" : remoteIn} ${remoteOut}`); } catch { /* ignore */ }
  }
}

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** Render a transcript as timestamped text for the prompt, e.g. "[12:34] so the budget line…". */
export function transcriptText(t: Transcript): string {
  return t.segments.map((s) => `[${mmss(s.start)}] ${s.text}`).join("\n");
}
