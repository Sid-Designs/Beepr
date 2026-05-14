const normalizeText = (value) =>
  String(value || "")
    .replace(/\s+/g, " ")
    .trim();

const DEVANAGARI_RE = /[\u0900-\u097F]/;

const HINDI_TOKENS = [
  "aap",
  "kya",
  "kaise",
  "hai",
  "nahi",
  "haan",
  "kripya",
  "samjha",
  "samjhao",
];

const MARATHI_TOKENS = [
  "mala",
  "tumhala",
  "kay",
  "kasa",
  "nahi",
  "aahe",
  "sanga",
  "mahiti",
  "admission",
];

const LANGUAGE_CODE_TO_KEY = Object.freeze({
  en: "en",
  english: "en",
  hi: "hi",
  hindi: "hi",
  mr: "mr",
  marathi: "mr",
});

const toLanguageKey = (value, fallback = "en") =>
  LANGUAGE_CODE_TO_KEY[String(value || "").toLowerCase()] || fallback;

const countMatches = (textLower, list = []) =>
  list.reduce((count, token) => (textLower.includes(token) ? count + 1 : count), 0);

export const resolveLanguageConfig = (callConfig = {}) => {
  const langConfig = callConfig?.languageConfig && typeof callConfig.languageConfig === "object"
    ? callConfig.languageConfig
    : {};
  const allowed = Array.isArray(langConfig.allowedLanguages) && langConfig.allowedLanguages.length
    ? langConfig.allowedLanguages.map((item) => toLanguageKey(item)).filter(Boolean)
    : ["en", "hi", "mr"];
  const allowedSet = new Set(allowed);
  const startLanguage = allowedSet.has(toLanguageKey(langConfig.startLanguage, "en"))
    ? toLanguageKey(langConfig.startLanguage, "en")
    : allowed[0] || "en";

  return {
    startLanguage,
    allowedLanguages: [...allowedSet],
    allowCodeMix: langConfig.allowCodeMix !== false,
    style: String(langConfig.style || "mirror_user"),
  };
};

export const getInitialLanguageState = (languageConfig) => ({
  startLanguage: languageConfig.startLanguage,
  dominantLanguage: languageConfig.startLanguage,
  mixLevel: "low",
  userLanguageByTurn: [],
});

export const detectLanguageProfile = ({
  query = "",
  previousState = {},
  languageConfig,
} = {}) => {
  const text = normalizeText(query);
  const lower = text.toLowerCase();
  const allowed = languageConfig?.allowedLanguages || ["en", "hi", "mr"];
  const allowedSet = new Set(allowed);

  const hindiHits = countMatches(lower, HINDI_TOKENS);
  const marathiHits = countMatches(lower, MARATHI_TOKENS);
  const hasDevanagari = DEVANAGARI_RE.test(text);
  const englishWords = lower.split(" ").filter((w) => /^[a-z]+$/.test(w)).length;
  const totalWords = Math.max(lower.split(" ").filter(Boolean).length, 1);

  let dominant = previousState?.dominantLanguage || languageConfig?.startLanguage || "en";

  if (hasDevanagari || hindiHits > 0 || marathiHits > 0) {
    dominant = marathiHits > hindiHits ? "mr" : "hi";
  } else if (englishWords / totalWords > 0.7) {
    dominant = "en";
  }

  if (!allowedSet.has(dominant)) {
    dominant = languageConfig?.startLanguage || "en";
  }

  const nonDominantHits =
    dominant === "en" ? hindiHits + marathiHits : englishWords > 0 ? 1 : 0;
  const ratio = nonDominantHits / Math.max(totalWords, 1);
  const mixLevel = ratio > 0.35 ? "high" : ratio > 0.15 ? "medium" : "low";

  const nextState = {
    ...(previousState && typeof previousState === "object" ? previousState : {}),
    startLanguage: previousState?.startLanguage || languageConfig?.startLanguage || "en",
    dominantLanguage: dominant,
    mixLevel,
    userLanguageByTurn: [...(previousState?.userLanguageByTurn || []), dominant].slice(-12),
  };

  return nextState;
};

export const getLanguageInstruction = ({
  languageState = {},
  languageConfig = {},
  conversationState = {},
} = {}) => {
  const dominant = languageState?.dominantLanguage || languageConfig?.startLanguage || "en";
  const mixLevel = languageState?.mixLevel || "low";
  const allowMix = languageConfig?.allowCodeMix !== false;
  const userEmotion = String(conversationState?.userEmotion || "neutral");

  return {
    responseLanguage: dominant,
    promptBlock: `
LANGUAGE STYLE POLICY:
- Start language: ${languageConfig?.startLanguage || "en"}
- Dominant user language this turn: ${dominant}
- Mix level: ${mixLevel}
- Allowed languages: ${(languageConfig?.allowedLanguages || ["en", "hi", "mr"]).join(", ")}
- Mirror user style naturally. Avoid textbook-pure language.
- Use natural spoken code-mix when appropriate.
- If user emotion is frustrated/urgent, keep wording clearer and less mixed.
- Never switch language abruptly unless user clearly shifts language.
`,
    shouldCodeMix: allowMix && mixLevel !== "low" && userEmotion !== "urgent",
  };
};
