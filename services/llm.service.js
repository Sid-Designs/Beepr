import axios from "axios";

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

const positiveInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
const GROQ_TIMEOUT_MS = positiveInt(process.env.GROQ_TIMEOUT_MS, 22000);
const GROQ_MAX_TOKENS = positiveInt(process.env.GROQ_MAX_TOKENS, 140);

const inferPersonaRole = (policy = {}) => {
  const objective = cleanText(policy.objective, 80).toLowerCase();
  const industry = cleanText(policy.industry, 80).toLowerCase();

  if (objective.includes("support")) return "support specialist";
  if (objective.includes("appointment")) return "appointment guide";
  if (objective.includes("sales")) return "business growth advisor";
  if (industry.includes("education") || industry.includes("college")) return "customer advisor";
  return "business advisor";
};

const cleanText = (value, max = 5000) =>
  String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

const normalizeHistory = (history = []) => {
  if (!Array.isArray(history)) return [];

  return history
    .filter((message) => message?.role && message?.content)
    .map((message) => ({
      role: message.role,
      content: cleanText(message.content, 800),
    }))
    .slice(-10);
};

const extractJsonObject = (raw = "") => {
  const text = cleanText(raw, 12000);
  if (!text) return null;

  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");

  if (first < 0 || last < first) return null;

  const maybeJson = text.slice(first, last + 1);
  try {
    return JSON.parse(maybeJson);
  } catch {
    return null;
  }
};

const isHardCloseMessage = (query = "") => {
  const text = cleanText(query, 500).toLowerCase();
  return /\b(bye|goodbye|end call|disconnect|hang up|stop calling|do not call)\b/.test(text);
};

const isNotInterestedMessage = (query = "") => {
  const text = cleanText(query, 500).toLowerCase();
  return /\b(not interested|no thanks|no thank you|remove me|do not call)\b/.test(text);
};

const getImmediateCloseResponse = (query = "") => {
  const text = cleanText(query, 500).toLowerCase();

  if (/\b(end call|disconnect|hang up|close)\b/.test(text)) {
    return "Sure, I will close the call now. Thank you for your time.";
  }
  if (/\b(bye|goodbye|see you)\b/.test(text)) {
    return "Goodbye, and thank you for your time.";
  }
  return "Understood. Thank you for your time. I will close the call now.";
};

const toLeadStatus = (value = "", fallback = "unsure") => {
  const normalized = cleanText(value, 80).toLowerCase();
  const allowed = new Set([
    "new",
    "interested",
    "qualified",
    "unsure",
    "not_interested",
    "closed",
  ]);

  if (allowed.has(normalized)) return normalized;
  return fallback;
};

export const generateAIResponse = async ({
  agentPrompt,
  context,
  query,
  history = [],
  policy = {},
  callState = {},
  conversationState = {},
  analyticsSnapshot = {},
  languageInstruction = {},
  nextBestAction = {},
  objectionGuidance = "",
}) => {
  try {
    if (!GROQ_API_KEY) {
      throw new Error("Missing GROQ_API_KEY");
    }

    const userQuery = cleanText(query, 1000);
    const normalizedHistory = normalizeHistory(history);
    const knowledge = cleanText(context, 7000);
    const businessPrompt = cleanText(agentPrompt, 4000);
    const personaRole = inferPersonaRole(policy);

    if (isHardCloseMessage(userQuery) || isNotInterestedMessage(userQuery)) {
      return {
        answer: getImmediateCloseResponse(userQuery),
        endCall: true,
        endReason: isHardCloseMessage(userQuery)
          ? "user_requested_end"
          : "user_not_interested",
        leadStatus: isNotInterestedMessage(userQuery) ? "not_interested" : "closed",
        nextStage: "closing",
      };
    }

    const systemPrompt = `
You are a production-ready multi-tenant AI calling agent for ${cleanText(policy.orgName, 120) || "the business"}.
Your role in this call is: ${personaRole}.
Speak naturally, politely, and briefly like a thoughtful human caller with a premium polished tone.
Do not sound robotic. Do not fabricate facts or actions.
Never claim handoff or booking unless the business configuration allows it.

BUSINESS PROFILE:
- organization: ${cleanText(policy.orgName, 120) || "the business"}
- industry: ${cleanText(policy.industry, 80) || "general"}
- agent name: ${cleanText(policy.agentName, 80) || "assistant"}
- objective: ${cleanText(policy.objective, 80) || "custom"}
- reason for calling: ${cleanText(policy.reasonForCalling, 280) || "assist the caller"}
- primary goal: ${cleanText(policy.primaryGoal, 280) || "help the caller and move to next step"}
- tone: ${cleanText(policy.tone, 40) || "neutral"}
- qualification fields: ${(policy.qualificationFields || []).join(", ") || "name, need"}
- handoff enabled: ${policy.allowHandoff ? "yes" : "no"}
- appointment booking enabled: ${policy.allowAppointmentBooking ? "yes" : "no"}
- persona tone: ${cleanText(policy.personaConfig?.tone, 40) || "premium_polished"}
- persona proactiveness: ${cleanText(policy.personaConfig?.proactiveness, 40) || "high"}
- persona empathy level: ${cleanText(policy.personaConfig?.empathyLevel, 40) || "adaptive"}
- persona closing style: ${cleanText(policy.personaConfig?.closingStyle, 40) || "soft"}

BUSINESS CONTEXT:
${cleanText(policy.businessContext, 1200) || "No extra business context provided."}

AGENT STYLE NOTES:
${businessPrompt || "No extra agent style notes provided."}

CURRENT CALL STATE:
- stage: ${cleanText(callState.stage, 40) || "discovery"}
- lead status: ${cleanText(callState.leadStatus, 40) || "new"}
- turn count: ${Number(callState.turnCount || 0)}
- collected data: ${JSON.stringify(callState.collectedData || {})}
- slot state: ${JSON.stringify(callState.slotState || {})}

CONVERSATION STATE:
- user emotion: ${cleanText(conversationState.userEmotion, 40) || "neutral"}
- ai tone target: ${cleanText(conversationState.aiTone, 40) || "calm"}
- frustration level (0-100): ${Number(conversationState.frustrationLevel || 0)}
- engagement level (0-100): ${Number(conversationState.engagementLevel || 50)}
- interruptions so far: ${Number(analyticsSnapshot.interruptions || 0)}
- fallback count so far: ${Number(analyticsSnapshot.fallbackCount || 0)}

GUIDANCE ENGINE:
- next best action: ${cleanText(nextBestAction.action, 40) || "qualify"}
- objection type: ${cleanText(nextBestAction.objection, 40) || "none"}
- objection guidance: ${cleanText(objectionGuidance, 240) || "none"}

${cleanText(languageInstruction.promptBlock, 1800)}

BEHAVIOR RULES:
1) Keep responses short for voice calls. Use 1-2 short sentences.
2) Be highly proactive: guide the user step-by-step with one useful next-step question.
3) If user goes off-topic, acknowledge briefly and redirect to call goal.
4) If user is not interested, close politely.
5) If user asks unknown fact and knowledge does not contain it, say you do not have that detail and suggest next best step.
6) Keep the conversation tied to the business objective.
7) Sound warm, confident, and human; avoid robotic wording.
8) Avoid repeating the same phrases across turns.
9) If user sounds confused or hesitant, acknowledge briefly, then guide.
10) Use concrete next steps, not generic filler.
11) If stage is opening, introduce yourself and purpose before asking the next question.
12) Never claim you captured phone/email/name unless it exists in collected data and is confirmed.
13) Ask only one missing qualification detail at a time; do not re-ask details already captured.
14) Do not ask for or confirm phone numbers in this call flow.
15) If emotion is confused: explain in simple words and slow pacing.
16) If emotion is frustrated: acknowledge concern, stay calm, avoid repeated phrasing.
17) If emotion is interested: be enthusiastic and ask one follow-up question.
18) If emotion is urgent: keep it concise and action-focused.
19) Avoid robotic fallback like "I will connect you to support." Prefer graceful uncertainty and guidance.
20) Prefer one short follow-up question when the user intent is unclear.
21) Strictly avoid these phrases:
   - "I will connect you to support"
   - "As an AI model"
   - "I'm not sure" without a useful next-step suggestion
22) For frustrated users, acknowledge concern and quickly offer an alternative path or clearer route.
23) Keep closing soft: briefly summarize what you helped with and end politely.
24) Use hybrid tone policy:
   - Default: executive (crisp, confident, concise).
   - If user is confused/frustrated: switch to empathetic supportive phrasing.
   - After empathy, return to clear action-oriented guidance in the same turn.
25) Do not overuse empathy words; one short acknowledgment is enough.
26) Vary sentence openings across turns; avoid repeating the same lead-in phrase.
27) Follow LANGUAGE STYLE POLICY strictly for response language and code-mix behavior.

KNOWLEDGE RULE:
Use only provided knowledge for factual business details (fees, dates, policies, services, offers).
If missing, do not invent.

OUTPUT FORMAT:
Return ONLY valid JSON with keys:
{
  "reply": "string",
  "end_call": boolean,
  "end_reason": "string",
  "lead_status": "new|interested|qualified|unsure|not_interested|closed",
  "next_stage": "opening|discovery|qualification|objection|closing",
  "summary": "string"
}
`;

    const messages = [
      { role: "system", content: systemPrompt },
      ...normalizedHistory,
      {
        role: "user",
        content: `
KNOWLEDGE:
${knowledge || "No relevant business knowledge found for this query."}

USER MESSAGE:
${userQuery}
`,
      },
    ];

    const response = await axios.post(
      GROQ_URL,
      {
        model: GROQ_MODEL,
        messages,
        temperature: 0.3,
        max_tokens: GROQ_MAX_TOKENS,
      },
      {
        headers: {
          Authorization: `Bearer ${GROQ_API_KEY.trim()}`,
          "Content-Type": "application/json",
        },
        timeout: GROQ_TIMEOUT_MS,
      },
    );

    const raw = response.data?.choices?.[0]?.message?.content || "";
    const parsed = extractJsonObject(raw);

    if (!parsed) {
      return {
        answer:
          cleanText(raw, 300) ||
          "I may not have that exact detail yet, but I can still guide you clearly. Which part should we solve first?",
        endCall: false,
        endReason: "",
        leadStatus: toLeadStatus(callState?.leadStatus, "unsure"),
        nextStage: cleanText(callState?.stage, 40) || "discovery",
        summary: "",
      };
    }

    return {
      answer: cleanText(parsed.reply, 360),
      endCall: Boolean(parsed.end_call),
      endReason: cleanText(parsed.end_reason, 120),
      leadStatus: toLeadStatus(parsed.lead_status, callState?.leadStatus || "unsure"),
      nextStage: cleanText(parsed.next_stage, 40) || "discovery",
      summary: cleanText(parsed.summary, 300),
    };
  } catch (error) {
    console.error("Groq LLM Error:", error.response?.data || error.message);
    return {
      answer:
        "I may not have the exact detail right now, but I can still help with the next step. What would you like to clarify first?",
      endCall: false,
      endReason: "",
      leadStatus: "unsure",
      nextStage: "discovery",
      summary: "",
    };
  }
};
