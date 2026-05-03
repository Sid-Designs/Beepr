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
import { AccessToken } from "livekit-server-sdk";
import dotenv from "dotenv";
import fs from "node:fs";
import { createSTTSession } from "./stt.service.js";
import { queryAI } from "./ai.service.js";
import { generateSpeech } from "./tts.service.js";

dotenv.config();

const LIVEKIT_URL = process.env.LIVEKIT_URL;
const API_KEY = process.env.LIVEKIT_API_KEY;
const API_SECRET = process.env.LIVEKIT_API_SECRET;

const BOT_IDENTITY = "ai-worker";
const STT_SAMPLE_RATE = 16000;
const TTS_OUTPUT_RATE = 48000;

const DUPLICATE_FINAL_DEBOUNCE_MS = 1200;
const END_SPEECH_COMMIT_DELAY_MS = 1600;
const NEW_TURN_PAUSE_MS = 650;

const generateToken = async (roomName, identity = BOT_IDENTITY) => {
  const at = new AccessToken(API_KEY, API_SECRET, { identity });

  at.addGrant({
    roomJoin: true,
    room: roomName,
    canSubscribe: true,
    canPublish: true,
  });

  return at.toJwt();
};

const isAudioKind = (kind) => {
  const value = String(kind).toLowerCase();
  return value === "audio" || value === "1";
};

const safeClose = async (fn) => {
  try {
    await fn?.();
  } catch {}
};

const normalizeText = (text) =>
  String(text || "")
    .replace(/\s+/g, " ")
    .trim();

const looksLikeCompleteThought = (text) => {
  const value = normalizeText(text);
  if (!value) return false;

  const words = value.split(" ").filter(Boolean);

  if (/[?.!]$/.test(value)) return true;
  if (words.length >= 5) return true;

  return /^(who|what|when|where|why|how|can|could|would|should|is|are|do|does|did|tell|explain|help)\b/i.test(
    value,
  );
};

const mergeTranscript = (previous, next) => {
  const oldText = normalizeText(previous);
  const newText = normalizeText(next);

  if (!newText) return oldText;
  if (!oldText) return newText;

  const oldLower = oldText.toLowerCase();
  const newLower = newText.toLowerCase();

  if (newLower.startsWith(oldLower)) {
    return newText;
  }

  if (oldLower.includes(newLower)) {
    return oldText;
  }

  return `${oldText} ${newText}`;
};

const parseWavBuffer = (wavBuffer) => {
  if (!Buffer.isBuffer(wavBuffer) || wavBuffer.length < 44) {
    throw new Error("Invalid WAV buffer");
  }

  if (
    wavBuffer.toString("ascii", 0, 4) !== "RIFF" ||
    wavBuffer.toString("ascii", 8, 12) !== "WAVE"
  ) {
    throw new Error("Unsupported TTS audio format. Expected WAV.");
  }

  let offset = 12;
  let sampleRate = 16000;
  let numChannels = 1;
  let bitsPerSample = 16;
  let dataStart = -1;
  let dataSize = 0;

  while (offset + 8 <= wavBuffer.length) {
    const chunkId = wavBuffer.toString("ascii", offset, offset + 4);
    const chunkSize = wavBuffer.readUInt32LE(offset + 4);
    const chunkDataStart = offset + 8;

    if (chunkId === "fmt ") {
      const audioFormat = wavBuffer.readUInt16LE(chunkDataStart);
      numChannels = wavBuffer.readUInt16LE(chunkDataStart + 2);
      sampleRate = wavBuffer.readUInt32LE(chunkDataStart + 4);
      bitsPerSample = wavBuffer.readUInt16LE(chunkDataStart + 14);

      if (audioFormat !== 1) {
        throw new Error("Only PCM WAV is supported");
      }
    }

    if (chunkId === "data") {
      dataStart = chunkDataStart;
      dataSize = chunkSize;
      break;
    }

    offset = chunkDataStart + chunkSize + (chunkSize % 2);
  }

  if (dataStart < 0) {
    throw new Error("WAV data chunk not found");
  }

  return {
    sampleRate,
    numChannels,
    bitsPerSample,
    pcm: wavBuffer.subarray(dataStart, dataStart + dataSize),
  };
};

const convertToMono = (pcm, numChannels) => {
  const pcm16 = new Int16Array(
    pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength),
  );

  if (numChannels === 1) return pcm16;

  const mono = new Int16Array(Math.floor(pcm16.length / numChannels));

  for (let i = 0; i < mono.length; i += 1) {
    let sum = 0;

    for (let ch = 0; ch < numChannels; ch += 1) {
      sum += pcm16[i * numChannels + ch] || 0;
    }

    mono[i] = Math.max(
      -32768,
      Math.min(32767, Math.round(sum / numChannels)),
    );
  }

  return mono;
};

const createTTSPlayback = async (room, wavBuffer) => {
  let stopped = false;
  let closed = false;

  const { sampleRate, numChannels, bitsPerSample, pcm } =
    parseWavBuffer(wavBuffer);

  if (bitsPerSample !== 16) {
    throw new Error(`Unsupported WAV bit depth: ${bitsPerSample}`);
  }

  const source = new AudioSource(TTS_OUTPUT_RATE, 1);
  const resampler = new AudioResampler(
    sampleRate,
    TTS_OUTPUT_RATE,
    1,
    AudioResamplerQuality.HIGH,
  );

  const track = LocalAudioTrack.createAudioTrack("ai-voice", source);

  const options = new TrackPublishOptions();
  options.source = TrackSource.SOURCE_MICROPHONE;

  const close = async () => {
    if (closed) return;
    closed = true;

    await safeClose(() => track.close(false));
    await safeClose(() => source.close());
    await safeClose(() => resampler.close());
  };

  const stop = async () => {
    if (stopped) return;
    stopped = true;

    await close();
    console.log("[tts] interrupted");
  };

  const done = (async () => {
    try {
      await room.localParticipant.publishTrack(track, options);

      const samples = convertToMono(pcm, numChannels);
      const frameSize = Math.max(1, Math.floor(sampleRate / 50));

      console.log("[tts] playing");

      for (let i = 0; i + frameSize <= samples.length; i += frameSize) {
        if (stopped) break;

        const frameSamples = new Int16Array(samples.slice(i, i + frameSize));

        const inputFrame = new AudioFrame(
          frameSamples,
          sampleRate,
          1,
          frameSamples.length,
        );

        const outputFrames = resampler.push(inputFrame);

        for (const outputFrame of outputFrames) {
          if (stopped) break;
          await source.captureFrame(outputFrame);
        }
      }

      if (!stopped) {
        for (const outputFrame of resampler.flush()) {
          if (stopped) break;
          await source.captureFrame(outputFrame);
        }

        await source.waitForPlayout();
        console.log("[tts] finished");
      }
    } finally {
      await close();
    }
  })();

  return {
    stop,
    done,
  };
};

export const startLiveKitWorker = async (roomName, options = {}) => {
  const { tenantId, agentId } = options;

  const debugStt = String(process.env.DEBUG_STT || "").toLowerCase() === "true";
  const debugTtsWav =
    String(process.env.DEBUG_TTS_WAV || "").toLowerCase() === "true";

  const token = await generateToken(roomName);
  const room = new Room();

  const state = {
    activeParticipantSid: null,
    activeParticipantIdentity: null,
    activeSTT: null,

    playback: null,

    aiRunning: false,
    pendingUserText: null,

    turnId: 0,

    currentUtteranceText: "",
    finalizeTimer: null,
    lastSpeechEndedAt: 0,

    lastFinalText: "",
    lastFinalAt: 0,

    closed: false,
  };

  const clearFinalizeTimer = () => {
    if (!state.finalizeTimer) return;

    clearTimeout(state.finalizeTimer);
    state.finalizeTimer = null;
  };

  const resetUtterance = () => {
    clearFinalizeTimer();
    state.currentUtteranceText = "";
    state.lastSpeechEndedAt = 0;
  };

  const stopPlayback = async (reason) => {
    if (!state.playback) return;

    const playback = state.playback;
    state.playback = null;

    console.log(`[call] stopping TTS: ${reason}`);
    await playback.stop();
  };

  const interruptForUserSpeech = async () => {
    await stopPlayback("user started speaking");
  };

  const rememberTranscript = (text) => {
    const transcript = normalizeText(text);
    if (!transcript) return;

    state.currentUtteranceText = mergeTranscript(
      state.currentUtteranceText,
      transcript,
    );
  };

  const queueUserText = (text) => {
    const finalText = normalizeText(text);
    if (!finalText) return;

    const now = Date.now();

    if (
      finalText === state.lastFinalText &&
      now - state.lastFinalAt < DUPLICATE_FINAL_DEBOUNCE_MS
    ) {
      console.log("[stt] duplicate final ignored");
      return;
    }

    state.lastFinalText = finalText;
    state.lastFinalAt = now;

    state.turnId += 1;
    state.pendingUserText = finalText;

    runAI().catch((error) => {
      console.error("[ai] loop failed:", error?.message || error);
    });
  };

  const commitCurrentUtteranceNow = (reason) => {
    clearFinalizeTimer();

    const finalText = normalizeText(state.currentUtteranceText);
    state.currentUtteranceText = "";

    if (!finalText) return;

    console.log(`[stt] final ${reason}: ${finalText}`);
    queueUserText(finalText);
  };

  const scheduleUtteranceCommit = () => {
    clearFinalizeTimer();

    state.finalizeTimer = setTimeout(() => {
      state.finalizeTimer = null;

      const finalText = normalizeText(state.currentUtteranceText);
      state.currentUtteranceText = "";

      if (!finalText) return;

      console.log(`[stt] final after silence: ${finalText}`);
      queueUserText(finalText);
    }, END_SPEECH_COMMIT_DELAY_MS);
  };

  const handleSpeechStart = async () => {
    const gapAfterEnd = Date.now() - state.lastSpeechEndedAt;

    if (
      state.finalizeTimer &&
      state.currentUtteranceText &&
      gapAfterEnd >= NEW_TURN_PAUSE_MS &&
      looksLikeCompleteThought(state.currentUtteranceText)
    ) {
      commitCurrentUtteranceNow("before new speech");
    } else {
      clearFinalizeTimer();
    }

    await interruptForUserSpeech();
  };

  const playAnswer = async (answer, answerTurnId) => {
    if (!answer) return;
    if (state.closed) return;

    if (answerTurnId !== state.turnId) {
      console.log("[ai] stale response ignored");
      return;
    }

    const wavBuffer = await generateSpeech(answer);

    if (answerTurnId !== state.turnId || state.closed) {
      console.log("[tts] stale speech ignored");
      return;
    }

    if (!wavBuffer || wavBuffer.length < 1000) {
      console.warn("[tts] empty or invalid audio");
      return;
    }

    if (debugTtsWav) {
      fs.writeFileSync("debug.wav", wavBuffer);
    }

    await stopPlayback("new answer");

    const playback = await createTTSPlayback(room, wavBuffer);
    state.playback = playback;

    playback.done
      .catch((error) => {
        console.error("[tts] playback failed:", error?.message || error);
      })
      .finally(() => {
        if (state.playback === playback) {
          state.playback = null;
        }
      });
  };

  const runAI = async () => {
    if (state.aiRunning) return;

    state.aiRunning = true;

    try {
      while (state.pendingUserText && !state.closed) {
        const userText = state.pendingUserText;
        state.pendingUserText = null;

        const myTurnId = state.turnId;

        console.log(`[user] ${userText}`);

        let result;

        try {
          result = await queryAI({
            tenantId,
            agentId,
            query: userText,
          });
        } catch (error) {
          console.error("[ai] query failed:", error?.message || error);
          continue;
        }

        if (myTurnId !== state.turnId) {
          console.log("[ai] stale response ignored");
          continue;
        }

        const answer = normalizeText(result?.answer || result?.response || "");

        if (!answer) {
          console.warn("[ai] empty answer");
          continue;
        }

        console.log(`[ai] ${answer}`);

        try {
          await playAnswer(answer, myTurnId);
        } catch (error) {
          console.error("[tts] failed:", error?.message || error);
        }
      }
    } finally {
      state.aiRunning = false;

      if (state.pendingUserText && !state.closed) {
        runAI().catch((error) => {
          console.error("[ai] loop failed:", error?.message || error);
        });
      }
    }
  };

  const closeActiveSTT = async () => {
    const activeSTT = state.activeSTT;
    state.activeSTT = null;

    if (activeSTT) {
      activeSTT.closed = true;
      await safeClose(() => activeSTT.close?.());
    }
  };

  console.log("[livekit] connecting...");
  await room.connect(LIVEKIT_URL, token, { autoSubscribe: true });
  console.log(`[livekit] connected to room: ${roomName}`);

  room.on(RoomEvent.ParticipantConnected, (participant) => {
    console.log(`[livekit] participant joined: ${participant.identity}`);
  });

  room.on(RoomEvent.ParticipantDisconnected, async (participant) => {
    console.log(`[livekit] participant left: ${participant.identity}`);

    if (participant.sid === state.activeParticipantSid) {
      resetUtterance();
      await closeActiveSTT();
      await stopPlayback("active participant disconnected");

      state.activeParticipantSid = null;
      state.activeParticipantIdentity = null;
      state.pendingUserText = null;
    }
  });

  room.on(RoomEvent.Disconnected, async () => {
    state.closed = true;

    resetUtterance();
    await closeActiveSTT();
    await stopPlayback("room disconnected");
  });

  room.on(RoomEvent.TrackPublished, (publication, participant) => {
    console.log(
      `[livekit] track published: ${String(publication.kind)} by ${participant.identity}`,
    );

    if (!isAudioKind(publication.kind)) return;
    if (participant.identity === BOT_IDENTITY) return;

    if (
      state.activeParticipantSid &&
      state.activeParticipantSid !== participant.sid
    ) {
      console.log(
        `[call] ignoring ${participant.identity}; active caller is ${state.activeParticipantIdentity}`,
      );
      publication.setSubscribed(false);
      return;
    }

    publication.setSubscribed(true);
  });

  room.on(RoomEvent.TrackSubscribed, async (track, publication, participant) => {
    if (state.closed) return;
    if (!isAudioKind(track.kind)) return;
    if (participant.identity === BOT_IDENTITY) return;

    if (
      state.activeParticipantSid &&
      state.activeParticipantSid !== participant.sid
    ) {
      publication.setSubscribed(false);
      return;
    }

    if (state.activeSTT) {
      await closeActiveSTT();
    }

    state.activeParticipantSid = participant.sid;
    state.activeParticipantIdentity = participant.identity;

    console.log(`[call] active caller: ${participant.identity}`);
    console.log("[stt] creating session...");

    const { send, close, events } = await createSTTSession({
      languageCode: "en-IN",
      sampleRate: STT_SAMPLE_RATE,
      inputAudioCodec: "pcm_s16le",
      encoding: "audio/wav",
      vadSignals: "true",
    });

    const sttSession = {
      closed: false,
      close,
    };

    state.activeSTT = sttSession;

    let lastTranscript = "";

    events.on("open", () => {
      console.log("[stt] socket open");
    });

    events.on("message", async (message) => {
      if (sttSession.closed || state.activeSTT !== sttSession) return;
      if (!message || typeof message !== "object") return;

      const type = message.type;
      const data = message.data;

      if (type === "data") {
        const transcript = normalizeText(data?.transcript);

        if (transcript) {
          lastTranscript = transcript;
          rememberTranscript(transcript);

          console.log(`[stt] partial: ${transcript}`);
          await interruptForUserSpeech();
        }

        return;
      }

      if (type === "events") {
        const eventType = data?.event_type || data?.signal_type;

        if (eventType) {
          console.log(`[stt] event: ${eventType}`);
        }

        if (eventType === "START_SPEECH") {
          await handleSpeechStart();
          return;
        }

        if (eventType === "END_SPEECH") {
          state.lastSpeechEndedAt = Date.now();

          rememberTranscript(lastTranscript);
          lastTranscript = "";
          scheduleUtteranceCommit();
        }

        return;
      }

      if (type === "error") {
        console.error("[stt] provider error:", data?.message || data);
      }
    });

    events.on("error", (error) => {
      console.error("[stt] stream error:", error?.message || error);
    });

    events.on("close", (event) => {
      const code = event?.code;
      const reasonRaw = event?.reason;
      const reason =
        typeof reasonRaw === "string"
          ? reasonRaw
          : Buffer.isBuffer(reasonRaw)
            ? reasonRaw.toString("utf8")
            : reasonRaw;

      console.log(
        "[stt] stream closed",
        code ? `code=${code}` : "",
        reason ? `reason=${reason}` : "",
      );

      sttSession.closed = true;
    });

    const lkAudio = new AudioStream(track, {
      sampleRate: STT_SAMPLE_RATE,
      numChannels: 1,
    });

    const bytesPerSecond = STT_SAMPLE_RATE * 2;
    const targetBytes = Math.floor(bytesPerSecond / 10);

    let buffer = Buffer.alloc(0);
    let loggedFrames = false;
    let sentChunks = 0;
    let sentBytes = 0;
    let levelPeak = 0;
    let levelSince = Date.now();

    try {
      for await (const frame of lkAudio) {
        if (sttSession.closed || state.activeSTT !== sttSession) {
          break;
        }

        if (!loggedFrames) {
          loggedFrames = true;
          console.log("[livekit] audio frames incoming");
        }

        const view = frame.data;
        if (!view || !view.length) continue;

        if (debugStt) {
          let localPeak = 0;

          for (let i = 0; i < view.length; i += 1) {
            const value = Math.abs(view[i]);
            if (value > localPeak) localPeak = value;
          }

          if (localPeak > levelPeak) levelPeak = localPeak;

          const now = Date.now();

          if (now - levelSince >= 1000) {
            console.log(`[stt] audio peak 1s: ${levelPeak}`);
            levelPeak = 0;
            levelSince = now;
          }
        }

        const chunk = Buffer.from(view.buffer, view.byteOffset, view.byteLength);
        buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);

        if (buffer.length >= targetBytes) {
          send(buffer);

          sentChunks += 1;
          sentBytes += buffer.length;

          if (debugStt && (sentChunks === 1 || sentChunks % 50 === 0)) {
            console.log(`[stt] sent chunks=${sentChunks}, bytes=${sentBytes}`);
          }

          buffer = Buffer.alloc(0);
        }
      }
    } catch (error) {
      console.error("[livekit] audio loop error:", error?.message || error);
    } finally {
      if (state.activeSTT === sttSession) {
        resetUtterance();
        await closeActiveSTT();
      }
    }
  });

  return room;
};
