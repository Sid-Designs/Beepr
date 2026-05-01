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
  validation: {
    toneWhitelist: ["neutral", "friendly", "formal", "empathetic"],
  },
});

export const Agents = Object.freeze({
  support: {
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
  };
};
