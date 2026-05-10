import { WebSocketServer } from "ws";
import {
  AudioFrame,
  AudioSource,
  AudioResampler,
  AudioResamplerQuality,
  AudioStream,
  LocalAudioTrack,
  Room,
  RoomEvent,
  TrackPublishOptions,
  TrackSource,
} from "@livekit/rtc-node";
import { generateLiveKitToken } from "../utils/livekit.util.js";
import {
  getCallSession,
  markWsConnected,
  removeCallSession,
} from "../services/callSession.service.js";
import { stopWorker } from "../services/workerLauncher.js";
import { logInfo, logWarn, logError } from "../utils/logging.util.js";

const LIVEKIT_URL = process.env.LIVEKIT_URL;
const VOBIZ_SAMPLE_RATE = Number.parseInt(
  process.env.VOBIZ_SAMPLE_RATE || "8000",
  10,
);
const VOBIZ_AUDIO_ENCODING = String(
  process.env.VOBIZ_AUDIO_ENCODING || "pcm_s16le",
).toLowerCase();
const LIVEKIT_SAMPLE_RATE = 16000;

const parseJson = (data) => {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
};

const toInt16Array = (buffer) => {
  return new Int16Array(
    buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
  );
};

const muLawToPcmSample = (muLawByte) => {
  const BIAS = 0x84;
  let mu = (~muLawByte) & 0xff;
  const sign = mu & 0x80;
  const exponent = (mu >> 4) & 0x07;
  const mantissa = mu & 0x0f;
  let sample = ((mantissa << 4) + BIAS) << exponent;
  sample = sign ? BIAS - sample : sample - BIAS;
  return sample;
};

const decodePcm = (buffer, encoding) => {
  if (encoding === "pcmu" || encoding === "mulaw") {
    const out = new Int16Array(buffer.length);
    for (let i = 0; i < buffer.length; i += 1) {
      out[i] = muLawToPcmSample(buffer[i]);
    }
    return out;
  }

  return toInt16Array(buffer);
};

const buildAudioTrack = async (room, sampleRate) => {
  const source = new AudioSource(sampleRate, 1);
  const track = LocalAudioTrack.createAudioTrack("vobiz-in", source);

  const options = new TrackPublishOptions();
  options.source = TrackSource.SOURCE_MICROPHONE;

  await room.localParticipant.publishTrack(track, options);
  return { source, track };
};

const buildResampler = (fromRate, toRate) => {
  if (fromRate === toRate) return null;
  return new AudioResampler(
    fromRate,
    toRate,
    1,
    AudioResamplerQuality.MEDIUM,
  );
};

const pushPcmToSource = async (source, resampler, pcm, sampleRate) => {
  if (!pcm || pcm.length === 0) return;
  const frame = new AudioFrame(pcm, sampleRate, 1, pcm.length);

  if (!resampler) {
    await source.captureFrame(frame);
    return;
  }

  const outputFrames = resampler.push(frame);
  for (const output of outputFrames) {
    await source.captureFrame(output);
  }
};

const encodeAudioChunk = (pcm) => {
  if (!pcm || pcm.length === 0) return "";
  const buffer = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  return buffer.toString("base64");
};

export const registerAudioWs = (server) => {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://localhost");

    console.log("[ws] upgrade request:", {
      path: url.pathname,
      query: url.search,
      url: req.url,
    });

    if (url.pathname !== "/ws/audio") {
      console.log("[ws] rejecting non-audio path:", url.pathname);
      socket.destroy();
      return;
    }

    console.log("[ws] handling audio upgrade for:", url.toString());
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", async (ws, req) => {
    const url = new URL(req.url, "http://localhost");
    const roomName = url.searchParams.get("roomName");
    const callId = url.searchParams.get("callId");

    console.log("[ws] new connection", { callId, roomName, url: req.url });
    logInfo("[vobiz] ws connected", { callId, roomName });

    if (!roomName || !callId) {
      console.log("[ws] closing: missing roomName/callId", { roomName, callId });
      logWarn("[vobiz] ws missing roomName/callId");
      ws.close();
      return;
    }

    const session = getCallSession(callId);
    if (!session) {
      console.log("[ws] closing: no session for callId", { callId });
      logWarn("[vobiz] ws no session", { callId });
      ws.close();
      return;
    }

    console.log("[ws] session found, connecting to livekit", { callId, roomName });
    markWsConnected(callId);

    const identity = `vobiz-bridge-${callId}`;
    const token = await generateLiveKitToken(roomName, identity);
    const room = new Room();

    let closed = false;

    const closeAll = async (reason) => {
      if (closed) return;
      closed = true;

      logInfo("[vobiz] ws closing", { callId, reason });
      try {
        ws.close();
      } catch {}

      try {
        await room.disconnect();
      } catch {}

      removeCallSession(callId);
      stopWorker(callId);
    };

    try {
      await room.connect(LIVEKIT_URL, token, { autoSubscribe: true });
    } catch (error) {
      logError("[vobiz] livekit connect failed", { message: error.message });
      await closeAll("livekit connect failed");
      return;
    }

    const { source } = await buildAudioTrack(room, LIVEKIT_SAMPLE_RATE);
    const inboundResampler = buildResampler(VOBIZ_SAMPLE_RATE, LIVEKIT_SAMPLE_RATE);

    let outboundResampler = null;

    room.on(RoomEvent.TrackSubscribed, async (track, publication, participant) => {
      if (participant.identity === identity) return;
      if (track.kind !== "audio") return;

      const stream = new AudioStream(track, {
        sampleRate: LIVEKIT_SAMPLE_RATE,
        numChannels: 1,
      });

      outboundResampler = buildResampler(LIVEKIT_SAMPLE_RATE, VOBIZ_SAMPLE_RATE);

      (async () => {
        for await (const frame of stream) {
          if (closed) break;
          const samples = frame.data;
          if (!samples?.length) continue;

          if (!outboundResampler) {
            const payload = encodeAudioChunk(samples);
            if (payload) {
              ws.send(JSON.stringify({ event: "media", media: { payload } }));
            }
            continue;
          }

          const inputFrame = new AudioFrame(samples, LIVEKIT_SAMPLE_RATE, 1, samples.length);
          const outputFrames = outboundResampler.push(inputFrame);

          for (const output of outputFrames) {
            const payload = encodeAudioChunk(output.data);
            if (payload) {
              ws.send(JSON.stringify({ event: "media", media: { payload } }));
            }
          }
        }
      })().catch((error) => {
        logError("[vobiz] outbound stream error", { message: error.message });
      });
    });

    ws.on("message", async (data) => {
      const message = parseJson(data);
      if (!message) {
        logWarn("[vobiz] ws non-json message ignored");
        return;
      }

      if (message.event === "start") {
        logInfo("[vobiz] ws start", { callId });
        return;
      }

      if (message.event === "stop") {
        logInfo("[vobiz] ws stop", { callId });
        await closeAll("remote stop");
        return;
      }

      if (message.event === "media") {
        const payload = message.media?.payload || "";
        if (!payload) return;

        const buffer = Buffer.from(payload, "base64");
        const encoding = String(message.media?.encoding || VOBIZ_AUDIO_ENCODING).toLowerCase();
        const pcm = decodePcm(buffer, encoding);
        await pushPcmToSource(source, inboundResampler, pcm, VOBIZ_SAMPLE_RATE);
      }
    });

    ws.on("close", async () => {
      await closeAll("ws closed");
    });

    ws.on("error", async () => {
      await closeAll("ws error");
    });
  });

  return wss;
};
