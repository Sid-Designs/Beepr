const normalizeText = (value) =>
  String(value || "")
    .replace(/\s+/g, " ")
    .trim();

const STARTER_RE = /^(sure|okay|alright|absolutely|of course|got it|understood)[,\s]+/i;

const EMPATHY_OPENERS = [
  "I understand your concern.",
  "That is a fair concern.",
  "I hear you.",
];

const EXECUTIVE_OPENERS = [
  "Here is the quickest way to handle this.",
  "Let us take the next best step.",
  "Here is what we can do now.",
];

const SOFT_CLOSERS = [
  "Thanks for your time.",
  "Glad I could help today.",
  "I appreciate your time.",
];

const pick = (list = [], seed = "") => {
  if (!list.length) return "";
  const key = String(seed || "");
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  }
  return list[hash % list.length];
};

export const applyConversationStyle = ({
  answer = "",
  userEmotion = "neutral",
  stage = "discovery",
  turnCount = 0,
} = {}) => {
  let text = normalizeText(answer);
  if (!text) return "";

  // Remove repetitive robotic starters if model keeps repeating.
  text = text.replace(STARTER_RE, "");

  const emotion = String(userEmotion || "neutral").toLowerCase();
  const openingSeed = `${turnCount}:${text}`;

  if ((emotion === "frustrated" || emotion === "confused") && !/^i (understand|hear you|get it)/i.test(text)) {
    text = `${pick(EMPATHY_OPENERS, openingSeed)} ${text}`;
  } else if (
    (emotion === "neutral" || emotion === "interested" || emotion === "urgent") &&
    turnCount > 1 &&
    !/^here is|^let us/i.test(text)
  ) {
    text = `${pick(EXECUTIVE_OPENERS, openingSeed)} ${text}`;
  }

  if (String(stage || "").toLowerCase() === "closing" && !/thank|appreciate|glad/i.test(text)) {
    text = `${text} ${pick(SOFT_CLOSERS, openingSeed)}`;
  }

  return normalizeText(text);
};
