const sessions = new Map();

const now = () => Date.now();

const createDefault = () => ({
  startedAt: now(),
  endedAt: 0,
  interruptions: 0,
  fallbackCount: 0,
  successfulAnswers: 0,
  latency: {
    sttFinalMs: [],
    retrievalMs: [],
    llmMs: [],
    ttsMs: [],
    playbackMs: [],
    totalMs: [],
  },
  emotionTrends: [],
  engagementLevel: 50,
});

const average = (list = []) =>
  list.length ? Math.round(list.reduce((sum, n) => sum + Number(n || 0), 0) / list.length) : 0;

export const ensureCallAnalytics = (sessionKey) => {
  if (!sessionKey) return createDefault();
  if (!sessions.has(sessionKey)) sessions.set(sessionKey, createDefault());
  return sessions.get(sessionKey);
};

export const trackInterruption = (sessionKey) => {
  const analytics = ensureCallAnalytics(sessionKey);
  analytics.interruptions += 1;
};

export const trackFallback = (sessionKey) => {
  const analytics = ensureCallAnalytics(sessionKey);
  analytics.fallbackCount += 1;
};

export const trackSuccessfulAnswer = (sessionKey) => {
  const analytics = ensureCallAnalytics(sessionKey);
  analytics.successfulAnswers += 1;
};

export const trackEmotion = (sessionKey, conversationState = {}) => {
  const analytics = ensureCallAnalytics(sessionKey);
  if (conversationState.userEmotion) {
    analytics.emotionTrends.push({
      at: now(),
      userEmotion: conversationState.userEmotion,
      aiTone: conversationState.aiTone || "calm",
    });
    analytics.emotionTrends = analytics.emotionTrends.slice(-20);
  }
  analytics.engagementLevel = Number(conversationState.engagementLevel || analytics.engagementLevel);
};

export const trackLatencyMetric = (sessionKey, key, ms) => {
  const analytics = ensureCallAnalytics(sessionKey);
  if (!analytics.latency[key]) return;
  if (!Number.isFinite(ms) || ms < 0) return;
  analytics.latency[key].push(ms);
  analytics.latency[key] = analytics.latency[key].slice(-30);
};

export const getCallAnalyticsSnapshot = (sessionKey) => {
  const analytics = ensureCallAnalytics(sessionKey);
  const durationMs = (analytics.endedAt || now()) - analytics.startedAt;
  return {
    callDurationMs: durationMs,
    interruptions: analytics.interruptions,
    fallbackCount: analytics.fallbackCount,
    successfulAnswers: analytics.successfulAnswers,
    engagementLevel: analytics.engagementLevel,
    emotionTrends: analytics.emotionTrends,
    latencyAvgMs: {
      sttFinal: average(analytics.latency.sttFinalMs),
      retrieval: average(analytics.latency.retrievalMs),
      llm: average(analytics.latency.llmMs),
      tts: average(analytics.latency.ttsMs),
      playback: average(analytics.latency.playbackMs),
      total: average(analytics.latency.totalMs),
    },
  };
};

export const closeCallAnalytics = (sessionKey) => {
  const analytics = ensureCallAnalytics(sessionKey);
  if (!analytics.endedAt) analytics.endedAt = now();
  return getCallAnalyticsSnapshot(sessionKey);
};
