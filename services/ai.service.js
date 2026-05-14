import axios from "axios";

const AI_QUERY_URL = process.env.AI_QUERY_URL || "http://localhost:5000/api/ai/query";

export const queryAI = async ({
  tenantId,
  agentId,
  query,
  sessionId,
  roomName,
  callObjective,
  callConfig,
  eventType,
  conversationHistory,
  conversationState,
  analyticsSnapshot,
  debug = false,
  languageState,
}) => {
  const payload = {
    tenantId,
    agentId,
    query: query || "",
  };

  if (sessionId) {
    payload.sessionId = sessionId;
  }

  if (roomName) {
    payload.roomName = roomName;
  }

  if (callObjective) {
    payload.callObjective = callObjective;
  }

  if (callConfig && typeof callConfig === "object") {
    payload.callConfig = callConfig;
  }

  if (eventType) {
    payload.eventType = eventType;
  }

  if (Array.isArray(conversationHistory) && conversationHistory.length) {
    payload.conversationHistory = conversationHistory;
  }

  if (conversationState && typeof conversationState === "object") {
    payload.conversationState = conversationState;
  }

  if (analyticsSnapshot && typeof analyticsSnapshot === "object") {
    payload.analyticsSnapshot = analyticsSnapshot;
  }

  if (debug) {
    payload.debug = true;
  }

  if (languageState && typeof languageState === "object") {
    payload.languageState = languageState;
  }

  const response = await axios.post(AI_QUERY_URL, payload, {
    headers: {
      "Content-Type": "application/json",
    },
  });

  return response.data;
};
