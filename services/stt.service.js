import { EventEmitter } from "events";
import WebSocket from "ws";

const DEFAULT_OPTIONS = {
  model: "saaras:v3",
  mode: "transcribe",
  languageCode: "en-IN",
  // Sarvam streaming supports 8k/16k sample rates.
  sampleRate: 16000,
  // Sarvam expects audio encoding labels like audio/wav.
  inputAudioCodec: "pcm_s16le",
  encoding: "audio/wav",
  highVadSensitivity: "true",
  vadSignals: "true",
  flushSignal: "false",
};

const buildSarvamWsUrl = (config) => {
  const url = new URL("wss://api.sarvam.ai/speech-to-text/ws");

  url.searchParams.set("language-code", config.languageCode);
  if (config.model) url.searchParams.set("model", config.model);
  if (config.mode) url.searchParams.set("mode", config.mode);
  if (config.sampleRate) url.searchParams.set("sample_rate", String(config.sampleRate));
  if (config.inputAudioCodec) {
    url.searchParams.set("input_audio_codec", String(config.inputAudioCodec));
  }
  if (config.highVadSensitivity != null) {
    url.searchParams.set("high_vad_sensitivity", String(config.highVadSensitivity));
  }
  if (config.vadSignals != null) {
    url.searchParams.set("vad_signals", String(config.vadSignals));
  }
  if (config.flushSignal != null) {
    url.searchParams.set("flush_signal", String(config.flushSignal));
  }

  return url.toString();
};

export const createSTTSession = async (options = {}) => {
  const apiKey = process.env.SARVAM_API_KEY;
  if (!apiKey) {
    throw new Error("SARVAM_API_KEY is not configured");
  }

  const config = { ...DEFAULT_OPTIONS, ...options };

  const wsUrl = buildSarvamWsUrl(config);
  const ws = new WebSocket(wsUrl, [`api-subscription-key.${apiKey}`], {
    headers: {
      "Api-Subscription-Key": apiKey,
    },
  });

  const events = new EventEmitter();
  const pendingChunks = [];
  let isOpen = false;
  let isClosed = false;
  let isSending = false;
  let closeEmitted = false;

  const ready = new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
    ws.once("close", (code, reason) => {
      reject(new Error(`Sarvam WS closed before open (code=${code}) ${reason || ""}`));
    });
  });

  const markClosed = (error, closeEvent) => {
    isOpen = false;
    isClosed = true;

    if (error) {
      events.emit("error", error);
    }

    if (!closeEmitted) {
      closeEmitted = true;
      events.emit("close", closeEvent);
    }

    try {
      ws.close();
    } catch {
      // best-effort
    }
  };

  const send = (chunk) => {
    if (!chunk || isClosed) return;

    if (!isOpen) {
      pendingChunks.push(chunk);
      return;
    }

    if (isSending) {
      pendingChunks.push(chunk);
      return;
    }

    isSending = true;

    try {
      const payload = {
        audio: {
          data: chunk.toString("base64"),
          sample_rate: String(config.sampleRate),
          encoding: String(config.encoding),
        },
      };

      ws.send(JSON.stringify(payload));
    } catch (error) {
      const message = String(error?.message || error || "");
      if (message.toLowerCase().includes("socket is not open")) {
        markClosed(error);
        return;
      }
      events.emit("error", error);
    } finally {
      isSending = false;
    }
  };

  const close = () => {
    if (isClosed) return;
    isClosed = true;
    try {
      if (config.flushSignal) {
        ws.send(JSON.stringify({ type: "flush" }));
      }
      ws.close();
    } catch (error) {
      events.emit("error", error);
    }

    if (!closeEmitted) {
      closeEmitted = true;
      events.emit("close", undefined);
    }
  };

  ws.on("open", () => {
    if (isClosed) return;
    isOpen = true;

    while (pendingChunks.length > 0) {
      send(pendingChunks.shift());
    }

    queueMicrotask(() => {
      if (!isClosed) events.emit("open");
    });
  });

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(String(data));
      events.emit("message", msg);
    } catch (error) {
      events.emit("error", error);
    }
  });

  ws.on("error", (error) => {
    if (isClosed) return;
    markClosed(error);
  });

  ws.on("close", (code, reason) => {
    if (closeEmitted) return;
    markClosed(undefined, { code, reason: reason ? String(reason) : undefined });
  });

  return { send, close, events, ready };
};
