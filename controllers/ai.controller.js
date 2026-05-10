import { generateAIResponse } from "../services/llm.service.js";
import { getAgentById } from "../services/agent.service.js";
import { retrieveContext } from "../services/kb/retrieval.service.js";
import {
  addMessageToSession,
  getSessionMessages,
  getSessionContext,
  setSessionContext,
} from "../services/memory.service.js";
import { v4 as uuidv4 } from "uuid";

const buildContext = (chunks, maxChars = 2200) => {
  if (!chunks || chunks.length === 0) return "";

  let used = 0;
  const lines = [];

  for (let i = 0; i < chunks.length; i += 1) {
    const item = chunks[i];
    const line = item.content;

    if (used + line.length > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }

  return lines.join("\n");
};

const isAcknowledgement = (text) => {
  const value = text.toLowerCase().trim();
  return [
    "yes",
    "yep",
    "yeah",
    "ok",
    "okay",
    "thanks",
    "thank you",
    "thx",
    "cool",
    "nice",
    "great",
    "awesome",
    "fine",
    "good",
    "really",
    "alright",
  ].includes(value);
};

const isGreeting = (text) => {
  const value = text.toLowerCase().trim();
  return ["hi", "hello", "hey", "hii", "hiya"].includes(value);
};

const isClosing = (text) => {
  const value = text.toLowerCase().trim();
  return [
    "bye",
    "goodbye",
    "thanks",
    "thank you",
    "thx",
    "see you",
    "no thanks",
    "not needed",
  ].includes(value);
};

const trimAnswer = (text, maxChars = 190) => {
  if (!text) return "";
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;

  const sentences = normalized.split(/(?<=[.!?])\s+/);
  const shortText = sentences.slice(0, 2).join(" ").trim();
  return shortText.length > maxChars
    ? shortText.slice(0, maxChars - 1).trim() + "…"
    : shortText;
};


export const handleQuery = async (req, res) => {
  try {
    const {
      tenantId,
      agentId,
      query,
      sessionId: incomingSessionId,
      debug,
    } = req.body;

    const debugLatency =
      String(process.env.DEBUG_LATENCY || "").toLowerCase() === "true";
    const requestStartedAt = Date.now();

    if (!tenantId || !agentId || !query) {
      return res.status(400).json({
        success: false,
        message: "tenantId, agentId, and query are required",
      });
    }

    const sessionId = incomingSessionId || uuidv4();

    if (isGreeting(query)) {
      const reply = "Hi! How can I help you today?";
      addMessageToSession(sessionId, "user", query);
      addMessageToSession(sessionId, "assistant", reply);

      return res.status(200).json({
        success: true,
        sessionId,
        answer: reply,
        agent: agentId,
        contextUsed: "",
      });
    }

    if (isClosing(query)) {
      const reply = "Glad I could help. Have a great day!";
      addMessageToSession(sessionId, "user", query);
      addMessageToSession(sessionId, "assistant", reply);

      return res.status(200).json({
        success: true,
        sessionId,
        answer: reply,
        agent: agentId,
        contextUsed: "",
      });
    }

    // 🔹 Step 4: Agent
    const agent = await getAgentById(tenantId, agentId);
    const agentPrompt = agent.prompt || "You are a helpful assistant.";

    const history = getSessionMessages(sessionId);

    // 🔹 Step 5: KB Retrieval
    const retrievalStartedAt = Date.now();
    const chunks = await retrieveContext(query, tenantId, agentId, {
      topK: 3,
      minScore: 0.2,
      semanticWeight: 0.65,
      keywordWeight: 0.35,
      maxCandidates: 200,
    });
    const retrievalEndedAt = Date.now();

    let context = buildContext(
      chunks.map((chunk) => ({ content: chunk.text || chunk.content || "" })),
      3500,
    );

    if (!context) {
      const lastContext = getSessionContext(sessionId);
      if (lastContext) {
        context = lastContext;
      }
    }

    if (!context) {
      const fallback = "I will connect you to support.";
      addMessageToSession(sessionId, "user", query);
      addMessageToSession(sessionId, "assistant", fallback);

      return res.status(200).json({
        success: true,
        sessionId,
        answer: fallback,
        agent: agent._id,
        contextUsed: "",
      });
    }

    // 🔹 Step 6: LLM
    const llmStartedAt = Date.now();
    const answer = await generateAIResponse({
      agentPrompt,
      context,
      query,
      history,
    });
    const llmEndedAt = Date.now();

    const finalAnswer = trimAnswer(answer);

    addMessageToSession(sessionId, "user", query);
    addMessageToSession(sessionId, "assistant", finalAnswer);
    setSessionContext(sessionId, context);

    const response = {
      success: true,
      sessionId,
      answer: finalAnswer,
      agent: agent._id,
      contextUsed: context,
    };

    const latencyInfo = {
      totalMs: Date.now() - requestStartedAt,
      retrievalMs: retrievalEndedAt - retrievalStartedAt,
      llmMs: llmEndedAt - llmStartedAt,
    };

    if (debug || debugLatency) {
      response.debug = {
        ...(response.debug || {}),
        chunkCount: chunks.length,
        latencyMs: latencyInfo,
      };
    }

    if (debugLatency) {
      console.log(
        `[latency][api] totalMs=${latencyInfo.totalMs} retrievalMs=${latencyInfo.retrievalMs} llmMs=${latencyInfo.llmMs}`,
      );
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

