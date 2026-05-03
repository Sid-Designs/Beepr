import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import ffmpegPath from "ffmpeg-static";

const detectFormat = (buf) => {
  if (!buf || buf.length < 4) return "mp3";
  const head = buf.subarray(0, 4).toString("ascii");
  if (head === "RIFF") return "wav";
  if (head === "ID3") return "mp3";
  // MP3 frame sync often starts with 0xfffb or 0xfff3 - check first byte 0xff
  if (buf[0] === 0xff) return "mp3";
  return "mp3";
};

export class StreamingTTSDecoder {
  constructor({ inputFormat = null, outputSampleRate = 48000, channels = 1 } = {}) {
    this.outputSampleRate = outputSampleRate;
    this.channels = channels;
    this._tmpFile = path.join(os.tmpdir(), `sarvam_tts_${Date.now()}.wav`);
    this._ffmpeg = null;
    this._outStream = null;
    this._stderr = "";
    this._closed = false;
    this._inputFormat = inputFormat; // if null, will detect from first chunk
    this._started = false;
  }

  _startWithFormat(fmt) {
    if (this._started) return;
    this._started = true;

    const args = [
      "-hide_banner",
      "-loglevel",
      "warning",
      "-f",
      fmt,
      "-i",
      "pipe:0",
      "-ar",
      String(this.outputSampleRate),
      "-ac",
      String(this.channels),
      "-f",
      "wav",
      "pipe:1",
    ];

    this._ffmpeg = spawn(ffmpegPath, args, { stdio: ["pipe", "pipe", "pipe"] });
    this._outStream = fs.createWriteStream(this._tmpFile);
    this._ffmpeg.stdout.pipe(this._outStream);
    this._ffmpeg.stderr.on("data", (d) => {
      try {
        this._stderr += d.toString();
      } catch (e) {}
    });
    this._ffmpeg.on("error", (err) => {
      console.error("StreamingTTSDecoder ffmpeg error:", err);
    });
  }

  writeBase64Chunk(b64) {
    if (this._closed) throw new Error("Decoder closed");
    const buf = Buffer.from(b64, "base64");

    if (!this._started) {
      const fmt = this._inputFormat || detectFormat(buf);
      this._startWithFormat(fmt);
    }

    return this._ffmpeg.stdin.write(buf);
  }

  async closeAndGetWavBuffer() {
    if (this._closed) {
      return fs.promises.readFile(this._tmpFile);
    }
    this._closed = true;

    if (!this._started) {
      // no data written; create an empty WAV
      await fs.promises.writeFile(this._tmpFile, Buffer.alloc(0));
      return Buffer.alloc(0);
    }

    this._ffmpeg.stdin.end();

    await new Promise((resolve) => this._ffmpeg.on("close", () => resolve()));
    await new Promise((resolve) => this._outStream.on("finish", () => resolve()));

    try {
      const buf = await fs.promises.readFile(this._tmpFile);
      return buf;
    } catch (err) {
      throw new Error(`Failed to read decoded WAV: ${err.message} ${this._stderr}`);
    }
  }
}

export default StreamingTTSDecoder;
