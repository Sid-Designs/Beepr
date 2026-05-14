const DEFAULT_OBJECTIVE_BY_TYPE = Object.freeze({
  appointment: "appointment_booking",
  sales: "lead_generation",
  support: "support_inquiry",
  custom: "custom",
});

const DEFAULT_REASON_BY_OBJECTIVE = Object.freeze({
  lead_generation: "follow up on your interest and understand your requirements",
  appointment_booking: "help you schedule an appointment",
  qualification: "understand your needs and qualify the request",
  support_inquiry: "help resolve your query",
  custom: "help you with your request",
});

const DEFAULT_QUALIFICATION_FIELDS = Object.freeze({
  lead_generation: ["name", "interest", "timeline"],
  appointment_booking: ["name", "preferred_date", "preferred_time"],
  qualification: ["name", "need", "timeline"],
  support_inquiry: ["name", "issue"],
  custom: ["name", "need"],
});

const ALLOWED_OBJECTIVES = new Set([
  "lead_generation",
  "appointment_booking",
  "qualification",
  "support_inquiry",
  "custom",
]);

const cleanText = (value, max = 400) =>
  String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

const uniqueStrings = (values = []) => {
  if (!Array.isArray(values)) return [];
  const seen = new Set();
  const result = [];

  for (const item of values) {
    const value = cleanText(item, 80).toLowerCase();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }

  return result;
};

const normalizeLanguageKey = (value = "") => {
  const v = cleanText(value, 20).toLowerCase();
  if (v === "hindi" || v === "hi") return "hi";
  if (v === "marathi" || v === "mr") return "mr";
  return "en";
};

const resolveObjective = ({ requestedObjective, agent, tenant }) => {
  const objective =
    cleanText(requestedObjective, 80).toLowerCase() ||
    cleanText(agent?.callConfig?.objective, 80).toLowerCase() ||
    cleanText(tenant?.metadata?.calling?.objective, 80).toLowerCase() ||
    DEFAULT_OBJECTIVE_BY_TYPE[agent?.type] ||
    "custom";

  if (!ALLOWED_OBJECTIVES.has(objective)) return "custom";
  return objective;
};

export const buildCallPolicy = ({
  tenant,
  agent,
  roomName = "",
  callObjective = "",
  callConfig = {},
}) => {
  const tenantCalling = tenant?.metadata?.calling || {};
  const mergedCallConfig = {
    ...(tenantCalling || {}),
    ...(agent?.callConfig || {}),
    ...(callConfig || {}),
  };

  const objective = resolveObjective({
    requestedObjective: callObjective || mergedCallConfig.objective,
    agent,
    tenant,
  });

  const reasonForCalling =
    cleanText(
      mergedCallConfig.reasonForCalling,
      280,
    ) || DEFAULT_REASON_BY_OBJECTIVE[objective];

  const primaryGoal =
    cleanText(
      mergedCallConfig.primaryGoal,
      280,
    ) || `Move this call toward ${objective.replace(/_/g, " ")} and confirm the next step.`;

  const openingScript = cleanText(mergedCallConfig.openingScript, 350);
  const businessContext =
    cleanText(mergedCallConfig.businessContext, 1200) ||
    cleanText(agent?.script, 1200);

  const qualificationFields = uniqueStrings(
    mergedCallConfig.qualificationFields?.length
      ? mergedCallConfig.qualificationFields
      : DEFAULT_QUALIFICATION_FIELDS[objective] || DEFAULT_QUALIFICATION_FIELDS.custom,
  );

  const rawLangConfig =
    mergedCallConfig.languageConfig && typeof mergedCallConfig.languageConfig === "object"
      ? mergedCallConfig.languageConfig
      : {};
  const allowedLanguages = Array.isArray(rawLangConfig.allowedLanguages) && rawLangConfig.allowedLanguages.length
    ? [...new Set(rawLangConfig.allowedLanguages.map((item) => normalizeLanguageKey(item)))]
    : ["en", "hi", "mr"];
  const startLanguage = allowedLanguages.includes(normalizeLanguageKey(rawLangConfig.startLanguage))
    ? normalizeLanguageKey(rawLangConfig.startLanguage)
    : allowedLanguages[0] || "en";

  const personaConfig =
    mergedCallConfig.personaConfig && typeof mergedCallConfig.personaConfig === "object"
      ? mergedCallConfig.personaConfig
      : {};

  return {
    tenantId: tenant?._id?.toString?.() || "",
    agentId: agent?._id?.toString?.() || "",
    roomName: cleanText(roomName, 120),
    orgName: cleanText(tenant?.orgName, 100),
    industry: cleanText(tenant?.industry, 80),
    agentName: cleanText(agent?.name, 100),
    agentType: cleanText(agent?.type, 60),
    tone: cleanText(agent?.tone, 40) || "neutral",
    objective,
    reasonForCalling,
    primaryGoal,
    openingScript,
    businessContext,
    qualificationFields,
    allowHandoff: Boolean(mergedCallConfig.allowHandoff),
    allowAppointmentBooking: Boolean(mergedCallConfig.allowAppointmentBooking),
    languageConfig: {
      startLanguage,
      allowedLanguages,
      allowCodeMix: rawLangConfig.allowCodeMix !== false,
      style: cleanText(rawLangConfig.style, 40) || "mirror_user",
    },
    personaConfig: {
      tone: cleanText(personaConfig.tone, 40) || "premium_polished",
      proactiveness: cleanText(personaConfig.proactiveness, 40) || "high",
      empathyLevel: cleanText(personaConfig.empathyLevel, 40) || "adaptive",
      closingStyle: cleanText(personaConfig.closingStyle, 40) || "soft",
    },
  };
};

export const getInitialConversationState = (policy = {}) => ({
  stage: "opening",
  objective: policy.objective || "custom",
  greeted: false,
  offTopicCount: 0,
  turnCount: 0,
  leadStatus: "new",
  collectedData: {},
  endCall: false,
  endReason: "",
});

export const buildOpeningMessage = (policy = {}) => {
  if (policy.openingScript) return policy.openingScript;

  const agentName = policy.agentName || "the assistant";
  const orgName = policy.orgName || "our team";
  const reason = policy.reasonForCalling || "help you";
  const objective = cleanText(policy.objective, 80).toLowerCase();
  const startLanguage = cleanText(policy.languageConfig?.startLanguage, 10).toLowerCase() || "en";

  if (startLanguage === "hi") {
    return `Namaste, main ${agentName} bol raha hoon ${orgName} se. ${reason} mein help karne ke liye call kiya hai. Kya abhi baat kar sakte hain?`;
  }
  if (startLanguage === "mr") {
    return `Namaskar, mi ${agentName} बोलतोय ${orgName} कडून. ${reason} साठी कॉल केला आहे. आत्ता बोलायला वेळ आहे का?`;
  }

  if (objective === "appointment_booking") {
    return `Hi, this is ${agentName} from ${orgName}. I am calling to ${reason}. I can help schedule this quickly. Is now a good time?`;
  }

  if (objective === "lead_generation" || objective === "qualification") {
    return `Hi, this is ${agentName} from ${orgName}. I am calling to ${reason}. It will just take a minute, is now a good time?`;
  }

  if (objective === "support_inquiry") {
    return `Hi, this is ${agentName} from ${orgName}. I am calling to ${reason}. I can help resolve this step by step. Is now a good time?`;
  }

  return `Hi, this is ${agentName} from ${orgName}. I am calling to ${reason}. Is this a good time for a quick discussion?`;
};

export const detectConversationSignals = (query = "") => {
  const text = cleanText(query, 500).toLowerCase();

  const hardClose =
    /\b(bye|goodbye|end call|disconnect|hang up|stop calling|do not call)\b/.test(text);
  const notInterested =
    /\b(not interested|no thanks|no thank you|not now|don't call|do not call|remove me)\b/.test(text);
  const uncertain =
    /\b(not sure|maybe|later|let me think|i will check)\b/.test(text);
  const interest =
    /\b(yes|interested|tell me more|book|schedule|admission|apply|price|fees|details|want to)\b/.test(text);

  return { hardClose, notInterested, uncertain, interest };
};

export const extractLeadDataFromQuery = (query = "") => {
  const text = cleanText(query, 600);
  const lower = text.toLowerCase();
  const collected = {};

  const nameMatch = text.match(/\b(?:my name is|this is|i am)\s+([a-z][a-z\s]{1,40})/i);
  if (nameMatch?.[1]) {
    collected.name = cleanText(nameMatch[1], 60);
  }

  const emailMatch = text.match(/\b([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})\b/i);
  if (emailMatch?.[1]) {
    collected.email = cleanText(emailMatch[1], 120).toLowerCase();
  }

  const timelineMatch = lower.match(
    /\b(today|tomorrow|this week|next week|this month|next month|asap|soon)\b/,
  );
  if (timelineMatch?.[1]) {
    collected.timeline = timelineMatch[1];
  }

  const dateMatch = lower.match(
    /\b(\d{1,2}[\/-]\d{1,2}(?:[\/-]\d{2,4})?|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/,
  );
  if (dateMatch?.[1]) {
    collected.preferred_date = dateMatch[1];
  }

  const timeMatch = lower.match(/\b(\d{1,2}(?::\d{2})?\s?(?:am|pm)|morning|afternoon|evening)\b/);
  if (timeMatch?.[1]) {
    collected.preferred_time = timeMatch[1];
  }

  const interestMatch = lower.match(
    /\b(admission|appointment|booking|consultation|demo|course|service|support|pricing|fees)\b/,
  );
  if (interestMatch?.[1]) {
    collected.interest = interestMatch[1];
  }

  const courseMatch = lower.match(
    /\b(bca|bba|mba|mca|btech|mtech|b\.?com|bcom|b\.?sc|bsc|be|b\.?e\.?)\b/,
  );
  if (courseMatch?.[1]) {
    collected.course = courseMatch[1].replace(/\./g, "").toUpperCase();
  } else {
    const longCourseMatch = text.match(
      /\b(bachelor(?:'s)?\s+in\s+[a-z\s]{2,40}|master(?:'s)?\s+in\s+[a-z\s]{2,40})\b/i,
    );
    if (longCourseMatch?.[1]) {
      collected.course = cleanText(longCourseMatch[1], 60);
    }
  }

  return collected;
};

export const mergeCollectedData = (current = {}, incoming = {}) => {
  return {
    ...(current || {}),
    ...(incoming || {}),
  };
};

export const computeLeadStatus = ({
  currentStatus = "new",
  signals = {},
  collectedData = {},
  objective = "custom",
}) => {
  if (signals.hardClose || signals.notInterested) return "not_interested";

  const hasIdentity = Boolean(collectedData.name || collectedData.email);
  const hasNeed = Boolean(
    collectedData.interest ||
      collectedData.course ||
      collectedData.timeline ||
      collectedData.preferred_date,
  );

  if (objective === "appointment_booking") {
    if (hasIdentity && (collectedData.preferred_date || collectedData.preferred_time)) {
      return "qualified";
    }
  }

  if (hasIdentity && hasNeed) return "qualified";
  if (signals.interest || hasNeed) return "interested";
  if (signals.uncertain) return "unsure";

  return currentStatus || "new";
};

export const getEndCallDecision = ({ signals = {}, leadStatus = "", stage = "" }) => {
  if (signals.hardClose) {
    return { endCall: true, reason: "user_requested_end" };
  }

  if (signals.notInterested) {
    return { endCall: true, reason: "user_not_interested" };
  }

  if (stage === "closing" && (leadStatus === "qualified" || leadStatus === "closed")) {
    return { endCall: true, reason: "goal_completed" };
  }

  return { endCall: false, reason: "" };
};
