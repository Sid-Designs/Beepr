import { v4 as uuidv4 } from "uuid";
import Tenant from "../models/tenant.model.js";
import { generateAIResponse } from "../services/llm.service.js";
import { getAgentById } from "../services/agent.service.js";
import { retrieveContext } from "../services/kb/retrieval.service.js";
import {
  addMessageToSession,
  getSessionMessages,
  getSessionContext,
  setSessionContext,
  getSessionCallState,
  setSessionCallState,
} from "../services/memory.service.js";
import {
  buildCallPolicy,
  buildOpeningMessage,
  computeLeadStatus,
  detectConversationSignals,
  extractLeadDataFromQuery,
  getEndCallDecision,
  getInitialConversationState,
  mergeCollectedData,
} from "../services/callPolicy.service.js";
import { upsertLeadOutcome } from "../services/leadOutcome.service.js";
import { applyConversationStyle } from "../services/conversationStyle.service.js";
import {
  detectLanguageProfile,
  getInitialLanguageState,
  getLanguageInstruction,
  resolveLanguageConfig,
} from "../services/language.service.js";
import {
  getNextBestAction,
  getObjectionGuidance,
} from "../services/guidanceEngine.service.js";
import { scoreConversationQuality } from "../services/qualityScore.service.js";

const LOW_INTENT_QUERY_RE =
  /^(hi|hello|hey|ok|okay|yes|yeah|no|nope|thanks|thank you|hmm|uh|huh)$/i;

const positiveInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const KB_TOP_K = positiveInt(process.env.KB_TOP_K, 3);
const KB_MAX_CANDIDATES = positiveInt(process.env.KB_MAX_CANDIDATES, 180);
const CALL_MAX_ANSWER_CHARS = positiveInt(process.env.CALL_MAX_ANSWER_CHARS, 220);
const PHONE_INTENT_RE =
  /\b(phone|number|contact|call me|reach me|mobile|whatsapp)\b/i;
const ASK_COURSE_RE =
  /\b(what(?:'s| is)? your (?:name and )?which course|which course are you interested|what course are you interested|which program are you interested|what program are you interested)\b/i;
const ASK_PHONE_RE =
  /\b(phone number|contact number|your number|share your number|confirm your number)\b/i;
const CLAIMED_PHONE_CAPTURE_RE =
  /\b(taken note|saved|captured|recorded|noted).*(phone|number)\b/i;

const buildContext = (chunks, maxChars = 2800) => {
  if (!chunks || chunks.length === 0) return "";

  let used = 0;
  const lines = [];

  for (let i = 0; i < chunks.length; i += 1) {
    const item = chunks[i];
    const line = String(item.content || item.text || "").trim();
    if (!line) continue;
    if (used + line.length > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }

  return lines.join("\n");
};

const trimAnswer = (text, maxChars = CALL_MAX_ANSWER_CHARS) => {
  const normalized = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "";
  if (normalized.length <= maxChars) return normalized;

  const sentences = normalized.split(/(?<=[.!?])\s+/).filter(Boolean);
  const shortText = sentences.slice(0, 2).join(" ").trim();
  if (shortText.length <= maxChars) return shortText;

  return `${shortText.slice(0, maxChars - 1).trim()}...`;
};

const ensureValidStage = (state, signals) => {
  if (signals.hardClose || signals.notInterested) return "closing";

  if (state.stage === "opening") {
    return state.greeted ? "discovery" : "opening";
  }
  if (state.stage === "closing") return "closing";
  if (state.leadStatus === "qualified") return "qualification";

  return state.stage || "discovery";
};

const shouldSkipRetrieval = (query = "") => {
  const text = String(query || "").replace(/\s+/g, " ").trim();
  if (!text) return true;

  if (text.length <= 20 && LOW_INTENT_QUERY_RE.test(text)) return true;
  if (
    text.length <= 90 &&
    /\b(my name is|i am|interested in|phone number|call me|next year|this year|yes|yeah|ok|okay)\b/i.test(
      text,
    )
  ) {
    return true;
  }
  return false;
};

const buildFallbackResponse = (policy, state) => {
  if (!state.greeted) return buildOpeningMessage(policy);
  if (state.stage === "closing") return "Thank you for your time. I will close this call now.";
  const objective = String(policy?.objective || "").toLowerCase();

  if (objective === "appointment") {
    return "I may not have that exact detail yet, but I can still guide you through available slots and booking steps. Would you like to proceed with scheduling?";
  }
  if (policy.objective === "sales") {
    return "I may not have that exact detail yet, but I can still guide you on options, pricing, and the best next step. What should we focus on first?";
  }
  if (objective === "support") {
    return "I may not have that exact detail yet, but I can still help you resolve this quickly with the right steps. What issue should we handle first?";
  }
  return "I may not have that exact detail yet, but I can still guide you with the most relevant next steps. What would you like to solve first?";
};

const normalizeUserQuery = (text = "") => {
  const normalized = String(text || "")
    .replace(/[.,;:!?]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "";

  const parts = normalized.split(" ");
  if (parts.length >= 4) {
    const first = parts[0].toLowerCase();
    const fillers = new Set(["ok", "okay", "yeah", "yes", "hello", "hi"]);
    if (fillers.has(first)) {
      return parts.slice(1).join(" ").trim() || normalized;
    }
  }

  return normalized;
};

const getSlotState = (state = {}) => {
  const slotState = state.slotState && typeof state.slotState === "object"
    ? state.slotState
    : {};

  return {
    lastAskedSlot: String(slotState.lastAskedSlot || ""),
  };
};

const resolveMissingLeadField = (state = {}) => {
  const data = state.collectedData || {};
  const hasName = Boolean(String(data.name || "").trim());
  const hasCourse = Boolean(String(data.course || data.interest || "").trim());
  const hasTimeline = Boolean(String(data.timeline || data.preferred_date || "").trim());

  if (!hasCourse) return "course";
  if (!hasTimeline) return "timeline";
  if (!hasName) return "name";
  return "";
};

const buildNextQuestionForField = (field) => {
  if (field === "course") {
    return "Which course are you interested in?";
  }
  if (field === "timeline") {
    return "When are you planning to start?";
  }
  if (field === "name") {
    return "Could you share your name, please?";
  }
  return "Could you share one more detail so I can help you better?";
};

const enforceNonRepetitiveAnswer = (answer, state = {}) => {
  const text = String(answer || "").trim();
  if (!text) return text;

  const data = state.collectedData || {};
  const hasCourse = Boolean(String(data.course || data.interest || "").trim());

  if (ASK_COURSE_RE.test(text) && hasCourse) {
    const missing = resolveMissingLeadField(state);
    if (missing && missing !== "course") {
      return buildNextQuestionForField(missing);
    }
  }

  if (CLAIMED_PHONE_CAPTURE_RE.test(text) || ASK_PHONE_RE.test(text)) {
    const missing = resolveMissingLeadField(state);
    return missing
      ? buildNextQuestionForField(missing)
      : "Great, I already have your contact from this call. Would you like details on eligibility, fees, or admission steps?";
  }

  return text;
};

export const handleQuery = async (req, res) => {
  try {
    const {
      tenantId,
      agentId,
      query,
      sessionId: incomingSessionId,
      debug,
      roomName = "",
      callObjective = "",
      callConfig = {},
      eventType = "",
      conversationHistory = [],
      conversationState = {},
      analyticsSnapshot = {},
      languageState: incomingLanguageState = {},
    } = req.body;

    const debugLatency =
      String(process.env.DEBUG_LATENCY || "").toLowerCase() === "true";
    const requestStartedAt = Date.now();

    const normalizedQuery = normalizeUserQuery(query || "");
    const isCallConnectedEvent =
      String(eventType || "").toLowerCase() === "call_connected";

    if (!tenantId || !agentId || (!normalizedQuery && !isCallConnectedEvent)) {
      return res.status(400).json({
        success: false,
        message: "tenantId, agentId, and query are required",
      });
    }

    const sessionId = incomingSessionId || uuidv4();
    const tenant = await Tenant.findById(tenantId).lean();
    if (!tenant) {
      return res.status(404).json({
        success: false,
        message: "Tenant not found",
      });
    }

    const agent = await getAgentById(tenantId, agentId);
    const agentPrompt = agent.prompt || "You are a helpful assistant.";
    const history = getSessionMessages(sessionId);
    const policy = buildCallPolicy({
      tenant,
      agent,
      roomName,
      callObjective,
      callConfig,
    });
    const languageConfig = resolveLanguageConfig(callConfig || {});
    const baseLanguageState =
      incomingLanguageState && typeof incomingLanguageState === "object" && Object.keys(incomingLanguageState).length
        ? incomingLanguageState
        : getInitialLanguageState(languageConfig);

    let state = getSessionCallState(sessionId) || getInitialConversationState(policy);
    const baseCollectedData =
      state.collectedData && typeof state.collectedData === "object"
        ? state.collectedData
        : {};
    state = {
      ...state,
      collectedData: { ...baseCollectedData },
      slotState: getSlotState(state),
    };

    // Opening is controlled by policy and triggered proactively on call connect.
    if (!state.greeted && isCallConnectedEvent) {
      const opening = buildOpeningMessage(policy);
      const openingAnswer = trimAnswer(opening, 320);

      state = {
        ...state,
        greeted: true,
        stage: "discovery",
        turnCount: (state.turnCount || 0) + 1,
      };

      addMessageToSession(sessionId, "assistant", openingAnswer);
      setSessionCallState(sessionId, state);

      try {
        await upsertLeadOutcome({
          tenantId,
          agentId,
          sessionId,
          roomName: policy.roomName,
          objective: policy.objective,
          stage: state.stage,
          leadStatus: state.leadStatus,
          collectedData: state.collectedData,
          summary: `${policy.objective} call started`,
          endReason: "",
          isClosed: false,
          turnCount: state.turnCount,
          lastUserMessage: "",
          lastAssistantMessage: openingAnswer,
        });
      } catch (error) {
        console.warn("[lead] outcome upsert failed:", error.message);
      }

      return res.status(200).json({
        success: true,
        sessionId,
        answer: openingAnswer,
        responseLanguage: languageConfig.startLanguage,
        languageState: baseLanguageState,
        endCall: false,
        leadStatus: state.leadStatus,
        stage: state.stage,
        objective: policy.objective,
        contextUsed: "",
        agent: agent._id,
      });
    }

    if (isCallConnectedEvent) {
      return res.status(200).json({
        success: true,
        sessionId,
        answer: "",
        responseLanguage: languageConfig.startLanguage,
        languageState: baseLanguageState,
        endCall: false,
        leadStatus: state.leadStatus,
        stage: state.stage,
        objective: policy.objective,
        contextUsed: "",
        agent: agent._id,
      });
    }

    const needsFirstTurnGreeting = !state.greeted;

    if (needsFirstTurnGreeting) {
      state = {
        ...state,
        stage: "opening",
      };
    }

    const saveTurnAndRespond = async ({
      answer,
      nextState,
      endCall = false,
      endReason = "",
      contextUsed = "",
      stage = "",
      languageState = baseLanguageState,
    }) => {
      const safeState = nextState || state;
      const styledAnswer = applyConversationStyle({
        answer: enforceNonRepetitiveAnswer(answer, safeState),
        userEmotion: conversationState?.userEmotion || "neutral",
        stage: stage || safeState.stage || "discovery",
        turnCount: safeState.turnCount || 0,
      });
      const finalAnswer = trimAnswer(styledAnswer);
      const resolvedStage = stage || safeState.stage || "discovery";
      const qualityScore = scoreConversationQuality({
        answer: finalAnswer,
        conversationState,
        analyticsSnapshot,
      });

      addMessageToSession(sessionId, "user", normalizedQuery);
      addMessageToSession(sessionId, "assistant", finalAnswer);
      setSessionContext(sessionId, contextUsed || "");
      setSessionCallState(sessionId, safeState);

      try {
        await upsertLeadOutcome({
          tenantId,
          agentId,
          sessionId,
          roomName: policy.roomName,
          objective: policy.objective,
          stage: resolvedStage,
          leadStatus: safeState.leadStatus,
          collectedData: safeState.collectedData,
          summary: `${policy.objective} stage=${resolvedStage}`,
          endReason: endReason || safeState.endReason || "",
          isClosed: endCall,
          turnCount: safeState.turnCount,
          lastUserMessage: normalizedQuery,
          lastAssistantMessage: finalAnswer,
        });
      } catch (error) {
        console.warn("[lead] outcome upsert failed:", error.message);
      }

      return res.status(200).json({
        success: true,
        sessionId,
        answer: finalAnswer,
        responseLanguage: languageState?.dominantLanguage || languageConfig.startLanguage,
        languageState,
        endCall,
        endReason: endReason || safeState.endReason || "",
        leadStatus: safeState.leadStatus,
        stage: resolvedStage,
        objective: policy.objective,
        contextUsed: contextUsed || "",
        agent: agent._id,
        qualityScore,
      });
    };

    const signals = detectConversationSignals(normalizedQuery);
    const turnLanguageState = detectLanguageProfile({
      query: normalizedQuery,
      previousState: baseLanguageState,
      languageConfig,
    });
    const languageInstruction = getLanguageInstruction({
      languageState: turnLanguageState,
      languageConfig,
      conversationState,
    });
    const nextBestAction = getNextBestAction({
      query: normalizedQuery,
      state,
      conversationState,
    });
    const objectionGuidance = getObjectionGuidance(
      nextBestAction.objection,
      languageInstruction.responseLanguage,
    );
    const extractedData = extractLeadDataFromQuery(normalizedQuery);

    const hasPhoneIntent = PHONE_INTENT_RE.test(normalizedQuery);
    const slotState = getSlotState(state);

    if (
      LOW_INTENT_QUERY_RE.test(normalizedQuery) &&
      !signals.hardClose &&
      !signals.notInterested &&
      !hasPhoneIntent
    ) {
      const missingField = resolveMissingLeadField(state);
      if (missingField) {
        const nextState = {
          ...state,
          turnCount: (state.turnCount || 0) + 1,
          slotState: {
            ...slotState,
            lastAskedSlot: missingField,
          },
        };

        return saveTurnAndRespond({
          answer: buildNextQuestionForField(missingField),
          nextState,
          stage: "discovery",
          contextUsed: getSessionContext(sessionId) || "",
          languageState: turnLanguageState,
        });
      }
    }

    if (hasPhoneIntent) {
      const nextState = {
        ...state,
        turnCount: (state.turnCount || 0) + 1,
      };

      const missingField = resolveMissingLeadField(nextState);
      const answer = missingField
        ? `I already have your contact from this call. ${buildNextQuestionForField(missingField)}`
        : "I already have your contact from this call. Would you like details on eligibility, fees, or admission steps?";

      return saveTurnAndRespond({
        answer,
        nextState,
        stage: "discovery",
        contextUsed: getSessionContext(sessionId) || "",
        languageState: turnLanguageState,
      });
    }

    const mergedData = mergeCollectedData(state.collectedData, extractedData);
    const leadStatus = computeLeadStatus({
      currentStatus: state.leadStatus,
      signals,
      collectedData: mergedData,
      objective: policy.objective,
    });

    state = {
      ...state,
      turnCount: (state.turnCount || 0) + 1,
      collectedData: mergedData,
      leadStatus,
    };

    const retrievalStartedAt = Date.now();
    let chunks = [];

    if (!shouldSkipRetrieval(normalizedQuery)) {
      chunks = await retrieveContext(normalizedQuery, tenantId, agentId, {
        topK: KB_TOP_K,
        minScore: 0.18,
        semanticWeight: 0.7,
        keywordWeight: 0.3,
        maxCandidates: KB_MAX_CANDIDATES,
      });
    }

    const retrievalEndedAt = Date.now();

    let context = buildContext(chunks, 3800);
    if (!context) {
      context = getSessionContext(sessionId);
    }

    state.stage = ensureValidStage(state, signals);

    const llmStartedAt = Date.now();
    const llmResult = await generateAIResponse({
      agentPrompt,
      context,
      query: normalizedQuery,
      history: Array.isArray(conversationHistory) && conversationHistory.length
        ? conversationHistory
        : history,
      policy,
      callState: state,
      conversationState,
      analyticsSnapshot,
      languageInstruction,
      nextBestAction,
      objectionGuidance,
    });
    const llmEndedAt = Date.now();

    const rawAnswer =
      typeof llmResult === "string" ? llmResult : llmResult?.answer || "";
    const llmLeadStatus =
      typeof llmResult === "object" ? String(llmResult?.leadStatus || "") : "";
    const llmNextStage =
      typeof llmResult === "object" ? String(llmResult?.nextStage || "") : "";
    const fallback = buildFallbackResponse(policy, state);
    const stabilizedAnswer = enforceNonRepetitiveAnswer(rawAnswer || fallback, state);
    const styledAnswer = applyConversationStyle({
      answer: stabilizedAnswer,
      userEmotion: conversationState?.userEmotion || "neutral",
      stage: state.stage || llmNextStage || "discovery",
      turnCount: state.turnCount || 0,
    });
    const finalAnswer = trimAnswer(styledAnswer);
    const qualityScore = scoreConversationQuality({
      answer: finalAnswer,
      conversationState,
      analyticsSnapshot,
    });

    const llmEndCall = typeof llmResult === "object" && Boolean(llmResult?.endCall);
    const llmEndReason =
      typeof llmResult === "object" ? String(llmResult?.endReason || "") : "";
    const decision = getEndCallDecision({
      signals,
      leadStatus: state.leadStatus,
      stage: state.stage,
    });

    const endCall = llmEndCall || decision.endCall;
    const endReason = llmEndReason || decision.reason || "";

    if (llmLeadStatus) {
      state.leadStatus = llmLeadStatus;
    }

    if (needsFirstTurnGreeting) {
      state.greeted = true;
    }

    if (endCall) {
      state.stage = "closing";
      state.endCall = true;
      state.endReason = endReason || "conversation_closed";
      state.leadStatus = state.leadStatus === "new" ? "closed" : state.leadStatus;
    } else if (state.leadStatus === "qualified") {
      state.stage = "qualification";
    } else {
      state.stage = llmNextStage || "discovery";
    }

    addMessageToSession(sessionId, "user", normalizedQuery);
    addMessageToSession(sessionId, "assistant", finalAnswer);
    setSessionContext(sessionId, context || "");
    setSessionCallState(sessionId, state);

    try {
      await upsertLeadOutcome({
        tenantId,
        agentId,
        sessionId,
        roomName: policy.roomName,
        objective: policy.objective,
        stage: state.stage,
        leadStatus: state.leadStatus,
        collectedData: state.collectedData,
        summary: `${policy.objective} stage=${state.stage}`,
        endReason: state.endReason || "",
        isClosed: endCall,
        turnCount: state.turnCount,
        lastUserMessage: normalizedQuery,
        lastAssistantMessage: finalAnswer,
      });
    } catch (error) {
      console.warn("[lead] outcome upsert failed:", error.message);
    }

    const response = {
      success: true,
      sessionId,
      answer: finalAnswer,
      responseLanguage: languageInstruction.responseLanguage,
      languageState: turnLanguageState,
      endCall,
      endReason: state.endReason || "",
      leadStatus: state.leadStatus,
      stage: state.stage,
      objective: policy.objective,
      contextUsed: context || "",
      agent: agent._id,
      qualityScore,
      nextBestAction: nextBestAction.action,
    };

    const latencyInfo = {
      totalMs: Date.now() - requestStartedAt,
      retrievalMs: retrievalEndedAt - retrievalStartedAt,
      llmMs: llmEndedAt - llmStartedAt,
    };

    if (debug || debugLatency) {
      response.debug = {
        chunkCount: chunks.length,
        latencyMs: latencyInfo,
        language: {
          startLanguage: languageConfig.startLanguage,
          dominantLanguage: turnLanguageState?.dominantLanguage,
          mixLevel: turnLanguageState?.mixLevel,
        },
        guidance: {
          nextBestAction: nextBestAction.action,
          objection: nextBestAction.objection,
        },
      };
    }

    if (debugLatency) {
      console.log(
        `[latency][api] totalMs=${latencyInfo.totalMs} retrievalMs=${latencyInfo.retrievalMs} llmMs=${latencyInfo.llmMs}`,
      );
    }

    const debugRetrieval =
      String(process.env.DEBUG_RETRIEVAL || "").toLowerCase() === "true";
    if (debugRetrieval && chunks.length) {
      const trace = chunks.map((item) => ({
        text: String(item.text || "").slice(0, 140),
        score: Number(item.score || 0).toFixed(3),
        keywordScore: Number(item.keywordScore || 0).toFixed(3),
      }));
      console.log("[retrieval]", trace);
    }

    return res.status(200).json(response);
  } catch (error) {
    console.error("AI Controller Error:", error.message);
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};
