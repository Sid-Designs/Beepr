import "../config/env.js";
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
import { AccessToken, RoomServiceClient } from "livekit-server-sdk";
import fs from "node:fs";
import { createSTTSession } from "./stt.service.js";
import { queryAI } from "./ai.service.js";
import { generateSpeech } from "./tts.service.js";
import { deriveConversationState, getInitialConversationState } from "./emotion.service.js";
import { getInitialLanguageState, resolveLanguageConfig } from "./language.service.js";
import {
  closeCallAnalytics,
  ensureCallAnalytics,
  getCallAnalyticsSnapshot,
  trackEmotion,
  trackFallback,
  trackInterruption,
  trackLatencyMetric,
  trackSuccessfulAnswer,
} from "./callAnalytics.service.js";

const LIVEKIT_URL = process.env.LIVEKIT_URL;
const API_KEY = process.env.LIVEKIT_API_KEY;
const API_SECRET = process.env.LIVEKIT_API_SECRET;

const BOT_IDENTITY = "ai-worker";
const STT_SAMPLE_RATE = 16000;
const TTS_OUTPUT_RATE = 48000;

const positiveInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const TTS_TARGET_CHUNK_CHARS = positiveInt(
  process.env.TTS_TARGET_CHUNK_CHARS || process.env.TTS_FIRST_CHUNK_CHARS,
  280,
);
const TTS_HARD_MAX_CHUNK_CHARS = positiveInt(process.env.TTS_HARD_MAX_CHUNK_CHARS, 420);
const TTS_MIN_TAIL_CHUNK_CHARS = positiveInt(process.env.TTS_MIN_TAIL_CHUNK_CHARS, 140);

const DUPLICATE_FINAL_DEBOUNCE_MS = positiveInt(
  process.env.DUPLICATE_FINAL_DEBOUNCE_MS,
  900,
);
const END_SPEECH_COMMIT_DELAY_MS = positiveInt(
  process.env.END_SPEECH_COMMIT_DELAY_MS,
  320,
);
const NEW_TURN_PAUSE_MS = positiveInt(process.env.NEW_TURN_PAUSE_MS, 180);
const ROOM_IDLE_DISCONNECT_MS = positiveInt(process.env.ROOM_IDLE_DISCONNECT_MS, 1500);
const CALL_ANSWER_TIMEOUT_MS = positiveInt(process.env.CALL_ANSWER_TIMEOUT_MS, 45000);
const INTERRUPTION_MIN_MS = positiveInt(process.env.INTERRUPTION_MIN_MS, 300);
const SILENCE_CHECK_MS = positiveInt(process.env.SILENCE_CHECK_MS, 9000);
const MAX_SILENCE_PROMPTS = positiveInt(process.env.MAX_SILENCE_PROMPTS, 1);
const ECHO_SIMILARITY_THRESHOLD = Number.parseFloat(
  String(process.env.ECHO_SIMILARITY_THRESHOLD || "0.62"),
);
const MIN_INTERRUPT_TRANSCRIPT_CHARS = positiveInt(process.env.MIN_INTERRUPT_TRANSCRIPT_CHARS, 8);
const MIN_INTERRUPT_TRANSCRIPT_WORDS = positiveInt(process.env.MIN_INTERRUPT_TRANSCRIPT_WORDS, 2);
const SHORT_USER_TURN_ALLOW_RE =
  /^(yes|yeah|yep|no|nope|ok|okay|sure|thanks|thank you|hello|hi|bye|goodbye)$/i;

const SESSION_STATE_ACTIVE = "active";
const SESSION_STATE_CLOSING = "closing";
const SESSION_STATE_ENDED = "ended";

const FILLERS_BY_STYLE = Object.freeze({
  calm: ["Sure,", "Okay,", "Alright,"],
  warm: ["Absolutely,", "Great question,", "Of course,"],
  closing: ["Understood,", "Thanks for sharing,", "Got it,"],
});

const SIP_CONNECTED_STATUSES = new Set([
  "active",
  "active_talking",
  "answered",
  "automation",
  "connected",
  "in-progress",
  "in_progress",
  "in-call",
  "in_call",
  "bridged",
]);

const SIP_TERMINAL_STATUSES = new Set([
  "busy",
  "cancelled",
  "canceled",
  "declined",
  "disconnected",
  "ended",
  "failed",
  "hangup",
  "hungup",
  "no-answer",
  "no_answer",
  "rejected",
  "unavailable",
]);

const getLiveKitHost = () =>
  String(LIVEKIT_URL || "")
    .replace(/^wss:\/\//i, "https://")
    .replace(/^ws:\/\//i, "http://");

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

const isSipParticipant = (participant) => {
  const kind = String(participant?.kind ?? "").toLowerCase();
  return kind === "sip" || kind === "3";
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

const getSipCallStatus = (participant) =>
  normalizeText(participant?.attributes?.["sip.callStatus"]).toLowerCase();

const isSipCallConnectedStatus = (status) => {
  const normalized = normalizeText(status).toLowerCase();
  if (!normalized) return false;
  if (SIP_CONNECTED_STATUSES.has(normalized)) return true;
  if (normalized.startsWith("active")) return true;
  return false;
};

const isSipCallTerminalStatus = (status) => {
  const normalized = normalizeText(status).toLowerCase();
  if (!normalized) return false;
  if (SIP_TERMINAL_STATUSES.has(normalized)) return true;
  if (
    normalized.includes("hangup") ||
    normalized.includes("disconnect") ||
    normalized.includes("declin") ||
    normalized.includes("cancel") ||
    normalized.includes("reject")
  ) {
    return true;
  }
  return false;
};

const splitIntoSentences = (text) => {
  const normalized = normalizeText(text);
  if (!normalized) return [];

  const sentences = normalized.match(/[^.!?]+[.!?]?/g) || [];
  return sentences
    .map((sentence) => normalizeText(sentence))
    .filter(Boolean);
};

const splitLongChunk = (chunk, maxChars = TTS_HARD_MAX_CHUNK_CHARS) => {
  const text = normalizeText(chunk);
  if (!text) return [];
  if (text.length <= maxChars) return [text];

  const words = text.split(" ").filter(Boolean);
  const parts = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }

    if (current) {
      parts.push(current);
      current = word;
      continue;
    }

    // Fallback for very long token without spaces.
    parts.push(word.slice(0, maxChars));
    current = word.slice(maxChars);
  }

  if (current) {
    parts.push(current);
  }

  return parts.filter(Boolean);
};

const splitAnswerForTts = (text) => {
  const normalized = normalizeText(text);
  if (!normalized) return [];
  if (normalized.length <= TTS_TARGET_CHUNK_CHARS) return [normalized];

  const sentences = splitIntoSentences(normalized);
  if (sentences.length <= 1) {
    return splitLongChunk(normalized);
  }

  const chunks = [];
  let current = "";

  for (const sentence of sentences) {
    const candidate = current ? `${current} ${sentence}` : sentence;
    if (candidate.length <= TTS_TARGET_CHUNK_CHARS) {
      current = candidate;
      continue;
    }

    if (current) {
      chunks.push(current);
      current = sentence;
      continue;
    }

    for (const part of splitLongChunk(sentence)) {
      chunks.push(part);
    }
    current = "";
  }

  if (current) {
    chunks.push(current);
  }

  if (chunks.length >= 2) {
    const tail = chunks[chunks.length - 1];
    const head = chunks[chunks.length - 2];
    if (
      tail.length < TTS_MIN_TAIL_CHUNK_CHARS &&
      head.length + 1 + tail.length <= TTS_HARD_MAX_CHUNK_CHARS
    ) {
      chunks[chunks.length - 2] = `${head} ${tail}`;
      chunks.pop();
    }
  }

  return chunks.filter(Boolean);
};

const inferSpeechStyle = ({ answer, stage = "", shouldEndCall = false, endReason = "" }) => {
  const text = normalizeText(answer).toLowerCase();
  const normalizedStage = normalizeText(stage).toLowerCase();
  const normalizedEndReason = normalizeText(endReason).toLowerCase();
  const hasClosingPhrase =
    /\b(not interested|goodbye|bye|close the call|thank you for your time)\b/.test(text);

  if (
    shouldEndCall ||
    hasClosingPhrase ||
    (normalizedStage === "closing" && (hasClosingPhrase || Boolean(normalizedEndReason)))
  ) {
    return "closing";
  }

  if (/\b(help|guide|steps?|process|details|admission|apply)\b/.test(text)) {
    return "warm";
  }

  return "calm";
};

const mapEmotionToSpeechStyle = (aiTone = "") => {
  const tone = normalizeText(aiTone).toLowerCase();
  if (tone === "executive") return "calm";
  if (tone === "enthusiastic") return "warm";
  if (tone === "urgent") return "calm";
  if (tone === "supportive") return "warm";
  return "calm";
};

const softenSpeechPunctuation = (text, style = "calm") => {
  const normalized = normalizeText(text);
  if (!normalized) return "";

  const sentences = splitIntoSentences(normalized);
  const spoken = sentences.map((sentence, index) => {
    const cleaned = normalizeText(sentence);
    if (!cleaned) return "";

    const isLast = index === sentences.length - 1;
    if (isLast) {
      if (/[.!?]$/.test(cleaned)) return cleaned;
      return `${cleaned}.`;
    }

    // Keep flow natural by softening hard sentence stops between chunks.
    return cleaned.replace(/[.!?]+$/, ",");
  });

  let value = spoken.filter(Boolean).join(" ");
  value = value.replace(/[;:]/g, ",");
  value = value.replace(/\s+,/g, ",");
  value = value.replace(/,+/g, ",");
  value = value.replace(/\s+/g, " ").trim();
  if (style === "warm") {
    value = value.replace(/\./g, ". ");
  }
  if (style === "closing") {
    value = value.replace(/,+/g, ",");
  }

  return value;
};

const shouldUseFiller = ({ spokenText, style, assistantTurns = 0 }) => {
  if (!spokenText) return false;
  if (style === "closing") return false;
  if (assistantTurns <= 0) return false;
  if (assistantTurns % 2 === 0) return false;
  if (spokenText.length < 50) return false;
  if (/^(sure|okay|alright|absolutely|of course|great question)/i.test(spokenText)) {
    return false;
  }
  return true;
};

const addSpeechFiller = ({
  spokenText,
  style,
  assistantTurns = 0,
  fillerState = null,
}) => {
  if (!shouldUseFiller({ spokenText, style, assistantTurns })) {
    return spokenText;
  }

  const list = FILLERS_BY_STYLE[style] || FILLERS_BY_STYLE.calm;
  if (!list?.length) return spokenText;

  const nextIndex =
    fillerState && Number.isFinite(fillerState.index)
      ? fillerState.index % list.length
      : 0;

  let filler = list[nextIndex];
  if (fillerState?.last === filler && list.length > 1) {
    filler = list[(nextIndex + 1) % list.length];
  }

  if (fillerState) {
    fillerState.index = nextIndex + 1;
    fillerState.last = filler;
  }

  return `${filler} ${spokenText}`;
};

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

const tokenizeForSimilarity = (text) =>
  normalizeText(text)
    .toLowerCase()
    .split(" ")
    .filter((token) => token && token.length > 2);

const jaccardSimilarity = (left, right) => {
  const a = new Set(tokenizeForSimilarity(left));
  const b = new Set(tokenizeForSimilarity(right));
  if (!a.size || !b.size) return 0;
  let overlap = 0;
  for (const token of a) {
    if (b.has(token)) overlap += 1;
  }
  const union = new Set([...a, ...b]).size || 1;
  return overlap / union;
};

const resolveSttLanguageCode = (language = "en") => {
  const key = normalizeText(language).toLowerCase();
  if (key === "hi" || key === "hindi") return "hi-IN";
  if (key === "mr" || key === "marathi") return "mr-IN";
  return "en-IN";
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
  const { tenantId, agentId, callObjective = "", callConfig = null } = options;
  const languageConfig = resolveLanguageConfig(callConfig || {});

  const debugStt = String(process.env.DEBUG_STT || "").toLowerCase() === "true";
  const debugTtsWav =
    String(process.env.DEBUG_TTS_WAV || "").toLowerCase() === "true";
  const debugLatency =
    String(process.env.DEBUG_LATENCY || "").toLowerCase() === "true";

  const token = await generateToken(roomName);
  const room = new Room();
  console.log("[livekit] worker auth ready", {
    roomName,
    wsUrl: LIVEKIT_URL,
    tokenLength: token?.length || 0,
  });

  const state = {
    activeParticipantSid: null,
    activeParticipantIdentity: null,
    activeSTT: null,
    activeAudioTrack: null,
    activeAudioPublication: null,
    sttStarting: false,
    sttWaitingForAnswer: false,
    sttWaitLogged: false,
    callAnswerTimer: null,

    playback: null,
    aiSpeaking: false,
    aiSpeechStartedAt: 0,
    recentAiResponses: [],

    aiRunning: false,
    pendingUserText: null,

    turnId: 0,

    currentUtteranceText: "",
    currentSpeechText: "",
    finalizeTimer: null,
    lastSpeechEndedAt: 0,

    lastFinalText: "",
    lastFinalAt: 0,
    lastQueuedUserText: "",

    turnMetrics: new Map(),

    userSpeaking: false,
    userSpeechStartedAt: 0,

    sessionId: null,
    analyticsKey: `${roomName}:${tenantId || "unknown"}:${agentId || "unknown"}`,
    conversationHistory: [],
    conversationState: getInitialConversationState(),
    languageState: getInitialLanguageState(languageConfig),
    silenceTimer: null,
    silencePromptCount: 0,
    lastUserActivityAt: Date.now(),

    callObjective: String(callObjective || ""),
    callConfig: callConfig && typeof callConfig === "object" ? callConfig : null,
    initialGreetingSent: false,
    greetingWaitLogged: false,
    sessionState: SESSION_STATE_ACTIVE,
    closingReason: "",
    roomIdleTimer: null,
    assistantTurns: 0,
    fillerState: { index: 0, last: "" },
  };

  const isSessionActive = () => state.sessionState === SESSION_STATE_ACTIVE;
  const isSessionClosing = () => state.sessionState === SESSION_STATE_CLOSING;
  const isSessionEnded = () => state.sessionState === SESSION_STATE_ENDED;
  ensureCallAnalytics(state.analyticsKey);

  const markSessionClosing = (reason = "conversation_closing") => {
    if (isSessionEnded()) return false;
    if (isSessionClosing()) return true;

    state.sessionState = SESSION_STATE_CLOSING;
    state.closingReason = normalizeText(reason) || "conversation_closing";
    state.pendingUserText = null;
    return true;
  };

  const markSessionActive = () => {
    if (isSessionEnded()) return false;
    state.sessionState = SESSION_STATE_ACTIVE;
    state.closingReason = "";
    return true;
  };

  const markSessionEnded = (reason = "conversation_closed") => {
    if (isSessionEnded()) return false;
    state.sessionState = SESSION_STATE_ENDED;
    state.closingReason = normalizeText(reason) || state.closingReason || "conversation_closed";
    state.pendingUserText = null;
    return true;
  };

  const hasRemoteParticipants = () => {
    if (!room.remoteParticipants || room.remoteParticipants.size === 0) return false;

    for (const [, participant] of room.remoteParticipants) {
      if (participant?.identity !== BOT_IDENTITY) {
        return true;
      }
    }

    return false;
  };

  const clearRoomIdleTimer = () => {
    if (!state.roomIdleTimer) return;
    clearTimeout(state.roomIdleTimer);
    state.roomIdleTimer = null;
  };

  const clearCallAnswerTimer = () => {
    if (!state.callAnswerTimer) return;
    clearTimeout(state.callAnswerTimer);
    state.callAnswerTimer = null;
  };

  const clearSilenceTimer = () => {
    if (!state.silenceTimer) return;
    clearTimeout(state.silenceTimer);
    state.silenceTimer = null;
  };

  const bumpUserActivity = () => {
    state.lastUserActivityAt = Date.now();
    clearSilenceTimer();
    if (!isSessionActive() || isSessionEnded()) return;
    state.silenceTimer = setTimeout(async () => {
      if (!isSessionActive() || isSessionEnded()) return;
      if (state.userSpeaking || state.aiSpeaking || state.aiRunning) {
        bumpUserActivity();
        return;
      }

      if (state.silencePromptCount < MAX_SILENCE_PROMPTS) {
        state.silencePromptCount += 1;
        await playAnswer("Are you still there?", state.turnId, { stage: "discovery" });
        bumpUserActivity();
        return;
      }

      await endSessionNow("silence_timeout");
    }, SILENCE_CHECK_MS);
  };

  const rememberAiResponse = (text) => {
    const normalized = normalizeText(text);
    if (!normalized) return;
    state.recentAiResponses.push(normalized);
    state.recentAiResponses = state.recentAiResponses.slice(-6);
  };

  const shouldSuppressEchoTranscript = (text) => {
    const transcript = normalizeText(text);
    if (!transcript) return true;
    if (!state.aiSpeaking) return false;

    const similarity = state.recentAiResponses.reduce(
      (max, item) => Math.max(max, jaccardSimilarity(item, transcript)),
      0,
    );

    if (similarity >= ECHO_SIMILARITY_THRESHOLD) {
      console.log("[stt] suppressed probable TTS echo", { similarity: similarity.toFixed(2) });
      return true;
    }

    return false;
  };

  const resolveActiveParticipant = () => {
    if (!state.activeParticipantSid || !room.remoteParticipants) return null;

    for (const [, participant] of room.remoteParticipants) {
      if (
        participant.sid === state.activeParticipantSid &&
        participant.identity === state.activeParticipantIdentity
      ) {
        return participant;
      }
    }

    return null;
  };

  const canStartSttForParticipant = (participant) => {
    if (!participant) return false;
    if (!isSipParticipant(participant)) return true;

    const status = getSipCallStatus(participant);
    return isSipCallConnectedStatus(status);
  };

  const scheduleRoomIdleDisconnect = (reason = "all_participants_left", options = {}) => {
    const { force = false } = options;
    clearRoomIdleTimer();
    if (isSessionEnded()) return;

    state.roomIdleTimer = setTimeout(async () => {
      state.roomIdleTimer = null;

      if (isSessionEnded()) return;
      if (!force && hasRemoteParticipants()) return;

      markSessionEnded(reason);
      resetUtterance();
      await closeActiveSTT();
      await stopPlayback("room idle cleanup");
      await safeClose(() => room.disconnect());
      console.log("[call] room disconnected after hangup", { reason });
    }, ROOM_IDLE_DISCONNECT_MS);
  };

  const disconnectActiveCaller = async (reason = "call_closed") => {
    if (!state.activeParticipantIdentity) return;

    try {
      const roomService = new RoomServiceClient(
        getLiveKitHost(),
        API_KEY,
        API_SECRET,
      );
      await roomService.removeParticipant(roomName, state.activeParticipantIdentity);
      console.log("[call] disconnected participant", {
        roomName,
        identity: state.activeParticipantIdentity,
        reason,
      });
    } catch (error) {
      console.warn("[call] failed to disconnect participant:", error?.message || error);
    }
  };

  const endSessionNow = async (reason = "conversation_closed") => {
    if (isSessionEnded()) return;

    clearCallAnswerTimer();
    clearRoomIdleTimer();
    clearSilenceTimer();

    markSessionEnded(reason);
    state.turnId += 1;
    state.userSpeaking = false;
    state.sttWaitingForAnswer = false;
    state.sttWaitLogged = false;
    state.lastQueuedUserText = "";
    state.activeAudioTrack = null;
    state.activeAudioPublication = null;
    resetUtterance();
    await closeActiveSTT();
    await stopPlayback(reason);

    await disconnectActiveCaller(reason);
    await safeClose(() => room.disconnect());
    const analytics = closeCallAnalytics(state.analyticsKey);
    console.log("[analytics] call summary", analytics);
  };

  const handleSipTerminalStatus = async (status, source = "sip_status") => {
    const normalizedStatus = normalizeText(status).toLowerCase();
    if (!isSipCallTerminalStatus(normalizedStatus)) return false;

    console.log("[call] SIP terminal status received", {
      status: normalizedStatus || "unknown",
      source,
    });

    await endSessionNow(`sip_${normalizedStatus || "ended"}`);
    return true;
  };

  const ensureCallAnswerTimer = (participant, source = "status") => {
    if (!participant || !isSipParticipant(participant)) {
      clearCallAnswerTimer();
      state.sttWaitingForAnswer = false;
      return;
    }

    const status = getSipCallStatus(participant);

    if (isSipCallConnectedStatus(status) || isSipCallTerminalStatus(status)) {
      clearCallAnswerTimer();
      state.sttWaitingForAnswer = false;
      return;
    }

    state.sttWaitingForAnswer = true;
    if (state.callAnswerTimer) return;

    state.callAnswerTimer = setTimeout(async () => {
      state.callAnswerTimer = null;

      if (isSessionEnded()) return;

      const activeParticipant = resolveActiveParticipant();
      const activeStatus = getSipCallStatus(activeParticipant);
      if (isSipCallConnectedStatus(activeStatus) || isSipCallTerminalStatus(activeStatus)) {
        return;
      }

      console.log("[call] answer timeout reached", {
        timeoutMs: CALL_ANSWER_TIMEOUT_MS,
        source,
        status: activeStatus || "unknown",
      });

      await endSessionNow("no_answer_timeout");
    }, CALL_ANSWER_TIMEOUT_MS);
  };

  const logLatency = (turnId, label, extra = "") => {
    if (!debugLatency) return;
    const suffix = extra ? ` ${extra}` : "";
    console.log(`[latency][turn ${turnId}] ${label}${suffix}`);
  };

  const ensureMetrics = (turnId) => {
    if (!state.turnMetrics.has(turnId)) {
      state.turnMetrics.set(turnId, {});
    }
    return state.turnMetrics.get(turnId);
  };

  const logTurnBreakdown = (turnId) => {
    if (!debugLatency) return;
    const metrics = ensureMetrics(turnId);
    if (!metrics.finalAt) return;
    const sttFinalMs =
      metrics.sttStartAt && metrics.finalAt ? metrics.finalAt - metrics.sttStartAt : null;
    const retrievalMs =
      metrics.aiRequestContext?.retrievalMs || metrics.retrievalMs || null;
    const llmMs = metrics.aiStartAt && metrics.aiEndAt ? metrics.aiEndAt - metrics.aiStartAt : null;
    const ttsMs =
      metrics.ttsStartAt && metrics.ttsEndAt ? metrics.ttsEndAt - metrics.ttsStartAt : null;
    const playbackMs =
      metrics.ttsEndAt && metrics.playbackStartAt ? metrics.playbackStartAt - metrics.ttsEndAt : null;
    const totalMs = Date.now() - metrics.finalAt;
    console.log("[latency]");
    if (sttFinalMs != null) console.log(`STT final: ${sttFinalMs}ms`);
    if (retrievalMs != null) console.log(`Retrieval: ${retrievalMs}ms`);
    if (llmMs != null) console.log(`LLM: ${llmMs}ms`);
    if (ttsMs != null) console.log(`TTS: ${ttsMs}ms`);
    if (playbackMs != null) console.log(`Playback: ${playbackMs}ms`);
    console.log(`Total: ${totalMs}ms`);
  };

  const clearFinalizeTimer = () => {
    if (!state.finalizeTimer) return;

    clearTimeout(state.finalizeTimer);
    state.finalizeTimer = null;
  };

  const resetUtterance = () => {
    clearFinalizeTimer();
    state.currentUtteranceText = "";
    state.currentSpeechText = "";
    state.lastSpeechEndedAt = 0;
  };

  const stopPlayback = async (reason) => {
    if (!state.playback) return;

    const playback = state.playback;
    state.playback = null;

    console.log(`[call] stopping TTS: ${reason}`);
    await playback.stop();
    state.aiSpeaking = false;
    state.aiSpeechStartedAt = 0;
  };

  const interruptForUserSpeech = async (force = false) => {
    if (!state.playback) return;
    if (!force && state.userSpeechStartedAt) {
      const activeMs = Date.now() - state.userSpeechStartedAt;
      if (activeMs < INTERRUPTION_MIN_MS) {
        console.log("[barge-in] ignored, speech too short", { activeMs, minMs: INTERRUPTION_MIN_MS });
        return;
      }
    }
    await stopPlayback("user started speaking");
  };

  const rememberTranscript = (text) => {
    const transcript = normalizeText(text);
    if (!transcript) return;

    state.currentSpeechText = mergeTranscript(state.currentSpeechText, transcript);
  };

  const commitSpeechSegment = () => {
    const speechText = normalizeText(state.currentSpeechText);
    state.currentSpeechText = "";

    if (!speechText) return;

    state.currentUtteranceText = mergeTranscript(state.currentUtteranceText, speechText);
  };

  const queueUserText = (text) => {
    const finalText = normalizeText(text);
    if (!finalText) return;
    if (!isSessionActive()) {
      console.log(`[stt] ignoring final transcript while session is ${state.sessionState}`);
      return;
    }

    const finalLower = finalText.toLowerCase();
    const wordCount = finalLower.split(" ").filter(Boolean).length;
    const previousLower = normalizeText(state.lastQueuedUserText).toLowerCase();

    if (
      wordCount <= 2 &&
      !SHORT_USER_TURN_ALLOW_RE.test(finalText) &&
      previousLower &&
      previousLower.includes(finalLower)
    ) {
      console.log("[stt] short fragment ignored");
      return;
    }

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
    state.lastQueuedUserText = finalText;
    state.silencePromptCount = 0;
    bumpUserActivity();

    state.turnId += 1;
    const metrics = ensureMetrics(state.turnId);
    metrics.finalAt = now;
    if (state.userSpeechStartedAt > 0) {
      trackLatencyMetric(state.analyticsKey, "sttFinalMs", now - state.userSpeechStartedAt);
    }
    logLatency(state.turnId, "final transcript committed");
    state.conversationHistory.push({ role: "user", content: finalText });
    state.conversationHistory = state.conversationHistory.slice(-10);
    state.conversationState = deriveConversationState({
      query: finalText,
      previousState: state.conversationState,
      interruptionCount: getCallAnalyticsSnapshot(state.analyticsKey).interruptions,
      silencePromptCount: state.silencePromptCount,
    });
    trackEmotion(state.analyticsKey, state.conversationState);
    state.pendingUserText = finalText;

    runAI().catch((error) => {
      console.error("[ai] loop failed:", error?.message || error);
    });
  };

  const commitCurrentUtteranceNow = (reason) => {
    clearFinalizeTimer();
    commitSpeechSegment();

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
      commitSpeechSegment();

      const finalText = normalizeText(state.currentUtteranceText);
      state.currentUtteranceText = "";

      if (!finalText) return;

      console.log(`[stt] final after silence: ${finalText}`);
      queueUserText(finalText);
    }, END_SPEECH_COMMIT_DELAY_MS);
  };

  const handleSpeechStart = async () => {
    if (!isSessionActive()) return;

    state.userSpeaking = true;
    state.userSpeechStartedAt = Date.now();
    const metrics = ensureMetrics(state.turnId + 1);
    metrics.sttStartAt = state.userSpeechStartedAt;
    state.currentSpeechText = "";
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

    await interruptForUserSpeech(false);
  };

  const playAnswer = async (answer, answerTurnId, options = {}) => {
    if (!answer) return;
    if (isSessionEnded()) return;

    if (answerTurnId !== state.turnId) {
      console.log("[ai] stale response ignored");
      return;
    }

    const speechStyle = inferSpeechStyle({
      answer,
      stage: options.stage,
      shouldEndCall: options.shouldEndCall,
      endReason: options.endReason,
    });
    const emotionStyle = mapEmotionToSpeechStyle(state.conversationState?.aiTone);
    const finalStyle = speechStyle === "closing" ? "closing" : emotionStyle || speechStyle;
    const softenedText = softenSpeechPunctuation(answer, finalStyle);
    const spokenText = addSpeechFiller({
      spokenText: softenedText,
      style: finalStyle,
      assistantTurns: state.assistantTurns,
      fillerState: state.fillerState,
    });
    const parts = splitAnswerForTts(spokenText);
    console.log(`[tts] style=${finalStyle} tone=${state.conversationState?.aiTone || "calm"} chunks=${parts.length}`);
    state.assistantTurns += 1;
    rememberAiResponse(spokenText);
    state.conversationHistory.push({ role: "assistant", content: spokenText });
    state.conversationHistory = state.conversationHistory.slice(-10);
    trackEmotion(state.analyticsKey, state.conversationState);

    for (let i = 0; i < parts.length; i += 1) {
      if (answerTurnId !== state.turnId || isSessionEnded()) {
        console.log("[tts] stale speech ignored");
        return;
      }

      if (state.userSpeaking) {
        console.log("[tts] user speaking, skip remaining chunks");
        return;
      }

      const chunk = parts[i];
      if (!chunk) continue;

      const metrics = ensureMetrics(answerTurnId);
      metrics.ttsStartAt = Date.now();
      logLatency(answerTurnId, "tts request start");

      const wavBuffer = await generateSpeech(chunk, {
        tone: state.conversationState.aiTone,
        language: options.responseLanguage || state.languageState?.dominantLanguage || languageConfig.startLanguage,
      });

      metrics.ttsEndAt = Date.now();
      if (metrics.finalAt) {
        const ttsMs = metrics.ttsEndAt - metrics.ttsStartAt;
        const sinceFinal = metrics.ttsEndAt - metrics.finalAt;
        trackLatencyMetric(state.analyticsKey, "ttsMs", ttsMs);
        logLatency(
          answerTurnId,
          "tts ready",
          `ttsMs=${ttsMs} totalSinceFinalMs=${sinceFinal}`,
        );
      }

      if (answerTurnId !== state.turnId || isSessionEnded()) {
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
      metrics.playbackStartAt = Date.now();
      state.aiSpeaking = true;
      state.aiSpeechStartedAt = metrics.playbackStartAt;
      if (metrics.finalAt) {
        trackLatencyMetric(
          state.analyticsKey,
          "playbackMs",
          metrics.playbackStartAt - metrics.ttsEndAt,
        );
        logLatency(
          answerTurnId,
          "playback started",
          `totalSinceFinalMs=${metrics.playbackStartAt - metrics.finalAt}`,
        );
      }
      state.playback = playback;

      try {
        await playback.done;
      } catch (error) {
        console.error("[tts] playback failed:", error?.message || error);
      } finally {
        state.aiSpeaking = false;
        state.aiSpeechStartedAt = 0;
        bumpUserActivity();
        if (state.playback === playback) {
          state.playback = null;
        }
      }
    }
  };

  const runAI = async () => {
    if (state.aiRunning) return;

    state.aiRunning = true;

    try {
      while (state.pendingUserText && !isSessionEnded()) {
        if (isSessionClosing()) {
          state.pendingUserText = null;
          break;
        }

        const userText = state.pendingUserText;
        state.pendingUserText = null;

        const myTurnId = state.turnId;
        const metrics = ensureMetrics(myTurnId);

        console.log(`[user] ${userText}`);

        let result;

        try {
          metrics.aiStartAt = Date.now();
          if (metrics.finalAt) {
            logLatency(myTurnId, "ai request start", `sinceFinalMs=${metrics.aiStartAt - metrics.finalAt}`);
          }
          result = await queryAI({
            tenantId,
            agentId,
            query: userText,
            sessionId: state.sessionId || undefined,
            roomName,
            callObjective: state.callObjective || undefined,
            callConfig: state.callConfig || undefined,
            conversationHistory: state.conversationHistory.slice(-10),
            conversationState: state.conversationState,
            analyticsSnapshot: getCallAnalyticsSnapshot(state.analyticsKey),
            debug: debugLatency,
            languageState: state.languageState,
          });
          if (result?.languageState && typeof result.languageState === "object") {
            state.languageState = result.languageState;
          }
          if (result?.sessionId) {
            state.sessionId = result.sessionId;
          }
          metrics.aiEndAt = Date.now();
          metrics.retrievalMs = Number(result?.debug?.latencyMs?.retrievalMs || 0);
          if (metrics.retrievalMs > 0) {
            trackLatencyMetric(state.analyticsKey, "retrievalMs", metrics.retrievalMs);
          }
          if (metrics.finalAt) {
            const aiMs = metrics.aiEndAt - metrics.aiStartAt;
            trackLatencyMetric(state.analyticsKey, "llmMs", aiMs);
            logLatency(
              myTurnId,
              "ai response received",
              `aiMs=${aiMs} totalSinceFinalMs=${metrics.aiEndAt - metrics.finalAt}`,
            );
          }
          logTurnBreakdown(myTurnId);
        } catch (error) {
          console.error("[ai] query failed:", error?.message || error);
          continue;
        }

        if (myTurnId !== state.turnId) {
          console.log("[ai] stale response ignored");
          continue;
        }

        const answer = normalizeText(result?.answer || result?.response || "");
        const shouldEndCall = Boolean(result?.endCall);
        const endReasonRaw = normalizeText(result?.endReason || "");
        const endReason = endReasonRaw || (shouldEndCall ? "conversation_closed" : "");
        const stage = normalizeText(result?.stage || "");
        const responseLanguage = normalizeText(result?.responseLanguage || "");

        if (!answer) {
          console.warn("[ai] empty answer");
          trackFallback(state.analyticsKey);
          continue;
        }

        console.log(`[ai] ${answer}`);
        trackSuccessfulAnswer(state.analyticsKey);

        if (shouldEndCall) {
          markSessionClosing(endReason || "conversation_closed");
        }

        try {
          await playAnswer(answer, myTurnId, {
            shouldEndCall,
            endReason,
            stage,
            responseLanguage,
          });
          if (metrics.finalAt) {
            trackLatencyMetric(state.analyticsKey, "totalMs", Date.now() - metrics.finalAt);
          }
        } catch (error) {
          console.error("[tts] failed:", error?.message || error);
        }

        if (shouldEndCall && myTurnId === state.turnId && !isSessionEnded()) {
          const finalReason = endReason || "conversation_closed";
          await endSessionNow(finalReason);
          console.log("[call] ended by conversation policy", { reason: finalReason });
          break;
        }
      }
    } finally {
      state.aiRunning = false;

      if (state.pendingUserText && !isSessionEnded()) {
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

  const startSttForActiveTrack = async (source = "track_subscribed", participantHint = null) => {
    if (!isSessionActive()) return false;
    if (state.activeSTT || state.sttStarting) return false;

    const participant = participantHint || resolveActiveParticipant();
    if (!participant) return false;
    if (
      participant.sid !== state.activeParticipantSid ||
      participant.identity !== state.activeParticipantIdentity
    ) {
      return false;
    }

    if (!canStartSttForParticipant(participant)) {
      ensureCallAnswerTimer(participant, source);
      if (!state.sttWaitLogged) {
        state.sttWaitLogged = true;
        const callStatus = getSipCallStatus(participant) || "unknown";
        console.log(`[stt] waiting for answered state (sip.callStatus=${callStatus})`);
      }
      return false;
    }

    clearCallAnswerTimer();
    state.sttWaitingForAnswer = false;
    state.sttWaitLogged = false;

    const track = state.activeAudioTrack;
    if (!track) return false;

    if (state.activeSTT) {
      console.log("[call] closing previous STT session");
      await closeActiveSTT();
    }

    state.sttStarting = true;
    console.log("[stt] creating session...");
    let sttSession = null;

    try {
      const { send, close, events } = await createSTTSession({
        languageCode: resolveSttLanguageCode(
          state.languageState?.dominantLanguage || languageConfig.startLanguage,
        ),
        sampleRate: STT_SAMPLE_RATE,
        inputAudioCodec: "pcm_s16le",
        encoding: "audio/wav",
        vadSignals: "true",
      });

      sttSession = {
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
        if (!isSessionActive()) return;

        const type = message.type;
        const data = message.data;

        if (type === "data") {
          const transcript = normalizeText(data?.transcript);

          if (transcript) {
            if (shouldSuppressEchoTranscript(transcript)) return;
            if (transcript.length < 3) return;
            lastTranscript = transcript;
            rememberTranscript(transcript);
            bumpUserActivity();

            console.log(`[stt] partial: ${transcript}`);
            const forceInterrupt =
              transcript.split(" ").length >= MIN_INTERRUPT_TRANSCRIPT_WORDS ||
              transcript.length >= MIN_INTERRUPT_TRANSCRIPT_CHARS;
            const hadPlayback = Boolean(state.playback);
            await interruptForUserSpeech(forceInterrupt);
            if (hadPlayback && !state.playback) {
              trackInterruption(state.analyticsKey);
            }
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
            state.userSpeaking = false;
            state.lastSpeechEndedAt = Date.now();
            state.userSpeechStartedAt = 0;

            if (lastTranscript) {
              rememberTranscript(lastTranscript);
            }
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

      console.log("[stt] audio stream created");

      const bytesPerSecond = STT_SAMPLE_RATE * 2;
      const targetBytes = Math.floor(bytesPerSecond / 20);

      let buffer = Buffer.alloc(0);
      let loggedFrames = false;
      let sentChunks = 0;
      let sentBytes = 0;
      let levelPeak = 0;
      let levelSince = Date.now();

      console.log("[stt] starting audio frame loop...");
      for await (const frame of lkAudio) {
        if (sttSession.closed || state.activeSTT !== sttSession) {
          console.log("[stt] session closed or replaced, exiting frame loop");
          break;
        }

        if (!loggedFrames) {
          loggedFrames = true;
          console.log("[livekit] audio frames incoming");
        }

        const view = frame.data;
        if (!view || !view.length) {
          console.warn("[livekit] empty frame received");
          continue;
        }

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
      console.log("[stt] audio frame loop ended");
      return true;
    } catch (error) {
      console.error("[livekit] audio loop error:", error?.message || error);
      return false;
    } finally {
      state.sttStarting = false;
      if (sttSession && state.activeSTT === sttSession) {
        resetUtterance();
        await closeActiveSTT();
      }
    }
  };

  const subscribeToParticipantAudio = (participant) => {
    if (!participant || participant.identity === BOT_IDENTITY) return;

    const publications = participant.trackPublications || new Map();

    for (const [, publication] of publications) {
      if (!publication) continue;
      if (!isAudioKind(publication.kind)) continue;

      if (
        state.activeParticipantSid &&
        state.activeParticipantSid !== participant.sid
      ) {
        console.log(
          `[call] ignoring ${participant.identity}; active caller is ${state.activeParticipantIdentity}`,
        );
        publication.setSubscribed?.(false);
        continue;
      }

      if (publication.subscribed) continue;

      console.log(`[livekit] subscribing to existing ${participant.identity} audio track`);
      publication.setSubscribed?.(true);
    }
  };

  const subscribeToExistingAudio = () => {
    if (!room.remoteParticipants || room.remoteParticipants.size === 0) return;

    for (const [, participant] of room.remoteParticipants) {
      subscribeToParticipantAudio(participant);
    }
  };

  const resolveParticipantForGreeting = (participantHint = null) => {
    if (
      participantHint &&
      participantHint.sid === state.activeParticipantSid &&
      participantHint.identity === state.activeParticipantIdentity
    ) {
      return participantHint;
    }

    if (!state.activeParticipantSid || !room.remoteParticipants) return null;

    for (const [, participant] of room.remoteParticipants) {
      if (participant.sid === state.activeParticipantSid) {
        return participant;
      }
    }

    return null;
  };

  const canStartInitialGreeting = (participant) => {
    if (!participant) return false;
    if (participant.identity === BOT_IDENTITY) return false;

    if (
      participant.sid !== state.activeParticipantSid ||
      participant.identity !== state.activeParticipantIdentity
    ) {
      return false;
    }

    if (!isSipParticipant(participant)) return true;

    const callStatus = getSipCallStatus(participant);
    if (!callStatus) return false;

    return isSipCallConnectedStatus(callStatus);
  };

  const triggerInitialGreeting = async (source, participantHint = null) => {
    if (state.initialGreetingSent || !isSessionActive()) return false;

    const participant = resolveParticipantForGreeting(participantHint);
    if (!participant) return false;

    if (!canStartInitialGreeting(participant)) return false;

    state.initialGreetingSent = true;
    state.greetingWaitLogged = false;

    try {
      const result = await queryAI({
        tenantId,
        agentId,
        query: "",
        sessionId: state.sessionId || undefined,
        roomName,
        callObjective: state.callObjective || undefined,
        callConfig: state.callConfig || undefined,
        eventType: "call_connected",
        languageState: state.languageState,
      });
      if (result?.languageState && typeof result.languageState === "object") {
        state.languageState = result.languageState;
      }

      if (result?.sessionId) {
        state.sessionId = result.sessionId;
      }

      const greetingText = normalizeText(result?.answer || "");
      if (!greetingText) return true;

      console.log(`[call] initial greeting (${source})`);
      console.log(`[ai] ${greetingText}`);
      await playAnswer(greetingText, state.turnId, {
        stage: "opening",
        responseLanguage: normalizeText(result?.responseLanguage || languageConfig.startLanguage),
      });

      if (result?.endCall && !isSessionEnded()) {
        await endSessionNow(result?.endReason || "conversation_closed");
        console.log("[call] ended during greeting");
      }

      return true;
    } catch (error) {
      state.initialGreetingSent = false;
      console.warn("[call] initial greeting failed:", error?.message || error);
      return false;
    }
  };

  console.log("[livekit] connecting...");
  await room.connect(LIVEKIT_URL, token, { autoSubscribe: true });
  console.log(`[livekit] connected to room: ${roomName}`);
  bumpUserActivity();

  // Log all participants already in room (if any)
  if (room.remoteParticipants && room.remoteParticipants.size > 0) {
    console.log(`[livekit] participants in room: ${room.remoteParticipants.size}`);
    for (const [, participant] of room.remoteParticipants) {
      const audioTrackCount = [...participant.trackPublications.values()].filter((publication) =>
        isAudioKind(publication.kind),
      ).length;
      console.log(
        `  - ${participant.identity} (${participant.kind}) with ${audioTrackCount} audio tracks`,
      );
    }
  } else {
    console.log("[livekit] no participants in room yet");
  }

  subscribeToExistingAudio();

  let catchupAttempts = 0;
  const catchupTimer = setInterval(() => {
    if (isSessionEnded()) {
      clearInterval(catchupTimer);
      return;
    }

    catchupAttempts += 1;
    subscribeToExistingAudio();

    if (state.activeSTT || catchupAttempts >= 40) {
      clearInterval(catchupTimer);
    }
  }, 500);

  room.on(RoomEvent.ParticipantConnected, (participant) => {
    bumpUserActivity();
    clearRoomIdleTimer();
    if (isSessionClosing()) {
      markSessionActive();
    }

    console.log(
      `[livekit] participant joined: ${participant.identity} (kind=${participant.kind})`,
    );
    const audioTrackCount = [...participant.trackPublications.values()].filter((publication) =>
      isAudioKind(publication.kind),
    ).length;
    console.log(
      `  - audio tracks: ${audioTrackCount}`,
    );

    subscribeToParticipantAudio(participant);
  });

  room.on(RoomEvent.ParticipantDisconnected, async (participant) => {
    console.log(`[livekit] participant left: ${participant.identity}`);

    if (participant.sid === state.activeParticipantSid) {
      clearCallAnswerTimer();
      state.turnId += 1;
      state.userSpeaking = false;
      resetUtterance();
      await closeActiveSTT();
      await stopPlayback("active participant disconnected");

      state.activeParticipantSid = null;
      state.activeParticipantIdentity = null;
      state.activeAudioTrack = null;
      state.activeAudioPublication = null;
      state.pendingUserText = null;
      state.sessionId = null;
      state.lastQueuedUserText = "";
      state.initialGreetingSent = false;
      state.greetingWaitLogged = false;
      state.sttWaitingForAnswer = false;
      state.sttWaitLogged = false;
      markSessionClosing("participant_left");
      scheduleRoomIdleDisconnect("active_participant_left", { force: true });
      return;
    }

    scheduleRoomIdleDisconnect("participant_left");
  });

  room.on(RoomEvent.ParticipantAttributesChanged, (changedAttributes, participant) => {
    if (!isSessionActive()) return;
    if (!participant || participant.identity === BOT_IDENTITY) return;
    if (participant.sid !== state.activeParticipantSid) return;

    const changedStatus = normalizeText(changedAttributes?.["sip.callStatus"]).toLowerCase();
    if (changedStatus) {
      console.log(`[livekit] sip.callStatus changed: ${changedStatus}`);
    }

    if (isSipCallTerminalStatus(changedStatus)) {
      handleSipTerminalStatus(changedStatus, "participant_attributes_changed").catch((error) => {
        console.warn("[call] terminal status cleanup failed:", error?.message || error);
      });
      return;
    }

    ensureCallAnswerTimer(participant, "participant_attributes_changed");

    startSttForActiveTrack("participant_attributes_changed", participant).catch((error) => {
      console.warn("[stt] deferred start failed:", error?.message || error);
    });

    triggerInitialGreeting("participant_attributes_changed", participant).catch((error) => {
      console.warn("[call] initial greeting failed:", error?.message || error);
    });
  });

  room.on(RoomEvent.Disconnected, async () => {
    markSessionEnded("room_disconnected");
    clearRoomIdleTimer();
    clearCallAnswerTimer();
    clearSilenceTimer();
    clearInterval(catchupTimer);

    state.activeAudioTrack = null;
    state.activeAudioPublication = null;
    resetUtterance();
    await closeActiveSTT();
    await stopPlayback("room disconnected");
  });

  room.on(RoomEvent.TrackPublished, (publication, participant) => {
    console.log(
      `[livekit] track published: ${String(publication.kind)} by ${participant.identity}`,
    );

    if (!isAudioKind(publication.kind)) {
      console.log(`[livekit] ignoring non-audio track`);
      return;
    }
    if (participant.identity === BOT_IDENTITY) {
      console.log(`[livekit] ignoring own bot track`);
      return;
    }

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

    console.log(`[livekit] subscribing to ${participant.identity} audio track`);
    publication.setSubscribed(true);
  });

  room.on(RoomEvent.TrackSubscribed, async (track, publication, participant) => {
    bumpUserActivity();
    if (isSessionEnded()) {
      console.log("[call] room closed, ignoring track subscription");
      return;
    }
    if (isSessionClosing()) {
      markSessionActive();
      clearRoomIdleTimer();
    }
    if (!isAudioKind(track.kind)) {
      console.log("[call] ignoring non-audio track subscription");
      return;
    }
    if (participant.identity === BOT_IDENTITY) {
      console.log("[call] ignoring own bot track subscription");
      return;
    }

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

    state.activeParticipantSid = participant.sid;
    state.activeParticipantIdentity = participant.identity;
    state.activeAudioTrack = track;
    state.activeAudioPublication = publication;
    state.sessionId = null;
    state.initialGreetingSent = false;
    state.greetingWaitLogged = false;
    state.sttWaitLogged = false;

    console.log(`[call] active caller: ${participant.identity}`);
    console.log(`[call] track details - kind: ${track.kind}, source: ${publication.source}`);

    const initialSipStatus = getSipCallStatus(participant);
    if (isSipCallTerminalStatus(initialSipStatus)) {
      await handleSipTerminalStatus(initialSipStatus, "track_subscribed");
      return;
    }

    triggerInitialGreeting("track_subscribed", participant)
      .then((greeted) => {
        if (greeted) return;
        if (state.initialGreetingSent || !isSessionActive()) return;
        if (!isSipParticipant(participant)) return;
        if (state.greetingWaitLogged) return;

        state.greetingWaitLogged = true;
        const callStatus = getSipCallStatus(participant) || "unknown";
        console.log(
          `[call] greeting waiting for answered state (sip.callStatus=${callStatus})`,
        );
      })
      .catch((error) => {
        console.warn("[call] initial greeting failed:", error?.message || error);
      });

    ensureCallAnswerTimer(participant, "track_subscribed");

    startSttForActiveTrack("track_subscribed", participant).catch((error) => {
      console.warn("[stt] deferred start failed:", error?.message || error);
    });
  });

  return room;
};
