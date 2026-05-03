export const AGENT_DEFAULTS = Object.freeze({
  features: {
    toneVariants: true,
    languageSupport: ["en"],
  },
  limits: {
    maxFaqs: 10,
    maxScriptChars: 2000,
  },
  defaults: {
    tone: "neutral",
  },
  goals: {
    goal: "Provide helpful, accurate guidance and resolve user needs efficiently.",
    tasks: [
      "Understand the user request",
      "Provide a clear answer or next step",
      "Confirm if more help is needed",
    ],
    handoff: "If you cannot answer, say: I will connect you to support.",
  },
  validation: {
    toneWhitelist: ["neutral", "friendly", "formal", "empathetic"],
  },
  intents: [
    {
      id: "admission",
      stage: "consideration",
      patterns: ["admission", "apply", "enroll", "enrol", "application", "fee", "fees", "deadline"],
      prompt: "Sure. Are you looking for eligibility, fees, or the application steps?",
    },
    {
      id: "pricing",
      stage: "consideration",
      patterns: ["price", "pricing", "cost", "rate", "discount", "offer"],
      prompt: "Sure. What product or category are you interested in?",
    },
    {
      id: "returns",
      stage: "support",
      patterns: ["return", "refund", "exchange"],
      prompt: "Got it. Do you want the return window or the process?",
    },
    {
      id: "delivery",
      stage: "consideration",
      patterns: ["delivery", "shipping", "ship", "courier"],
      prompt: "Sure. Do you want delivery areas or timelines?",
    },
    {
      id: "products",
      stage: "consideration",
      patterns: ["product", "products", "catalog", "collection", "options", "show me"],
      prompt: "Sure. Which type are you looking for?",
    },
  ],
});

export const Agents = Object.freeze({
  support: {
    intents: [
      {
        id: "support_issue",
        stage: "support",
        patterns: ["problem", "issue", "help", "not working", "complaint"],
        prompt: "I can help with that. What seems to be the issue?",
      },
    ],
    goals: {
      goal: "Resolve customer questions quickly and politely.",
      tasks: [
        "Identify the issue",
        "Provide the exact policy or guidance",
        "Offer the next step",
      ],
      handoff: "If unsure, say: I will connect you to support.",
    },
    features: {
      toneVariants: true,
      languageSupport: ["en"],
    },
    limits: {
      maxFaqs: 15,
      maxScriptChars: 1500,
    },
    defaults: {
      tone: "friendly",
    },
    validation: {
      toneWhitelist: ["neutral", "friendly", "empathetic"],
    },
  },
  appointment: {
    intents: [
      {
        id: "book_appointment",
        stage: "decision",
        patterns: ["appointment", "book", "schedule", "reschedule", "cancel"],
        prompt: "Sure. What date and time work best for you?",
      },
    ],
    goals: {
      goal: "Help users schedule or manage appointments.",
      tasks: [
        "Collect date/time preferences",
        "Confirm availability",
        "Summarize the booking details",
      ],
      handoff: "If unsure, say: I will connect you to support.",
    },
    features: {
      toneVariants: true,
      languageSupport: ["en"],
    },
    limits: {
      maxFaqs: 12,
      maxScriptChars: 1800,
    },
    defaults: {
      tone: "formal",
    },
  },
  sales: {
    intents: [
      {
        id: "buy_product",
        stage: "consideration",
        patterns: ["buy", "purchase", "order", "price", "discount"],
        prompt: "Sure. What product are you looking for?",
      },
    ],
    goals: {
      goal: "Guide users to the right product and encourage a purchase decision.",
      tasks: [
        "Clarify preferences",
        "Suggest a suitable option",
        "Offer to share more choices",
      ],
      handoff: "If unsure, say: I will connect you to support.",
    },
    features: {
      toneVariants: true,
      languageSupport: ["en", "es"],
    },
    limits: {
      maxFaqs: 20,
      maxScriptChars: 2500,
    },
    defaults: {
      tone: "friendly",
    },
    validation: {
      toneWhitelist: ["neutral", "friendly", "formal", "persuasive"],
    },
  },
  custom: {
    intents: [],
    goals: {
      goal: "Follow the custom business workflow defined by the tenant.",
      tasks: [
        "Ask clarifying questions",
        "Provide concise guidance",
        "Confirm the next step",
      ],
      handoff: "If unsure, say: I will connect you to support.",
    },
    features: {
      toneVariants: true,
      languageSupport: null,
    },
    limits: {
      maxFaqs: 30,
      maxScriptChars: 4000,
    },
    defaults: {
      tone: "neutral",
    },
    validation: {
      toneWhitelist: null,
    },
  },
});

export const getAgentConfig = (type) => {
  const cfg = Agents[type];
  if (!cfg) return null;

  return {
    features: { ...AGENT_DEFAULTS.features, ...cfg.features },
    limits: { ...AGENT_DEFAULTS.limits, ...cfg.limits },
    defaults: { ...AGENT_DEFAULTS.defaults, ...cfg.defaults },
    validation: { ...AGENT_DEFAULTS.validation, ...cfg.validation },
    goals: { ...AGENT_DEFAULTS.goals, ...cfg.goals },
    intents: [...(AGENT_DEFAULTS.intents || []), ...(cfg.intents || [])],
  };
};
