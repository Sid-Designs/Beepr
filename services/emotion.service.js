const normalizeText = (value) =>
  String(value || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const hasAny = (text, list = []) => list.some((item) => text.includes(item));

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export const getInitialConversationState = () => ({
  userEmotion: "neutral",
  aiTone: "calm",
  frustrationLevel: 0,
  engagementLevel: 50,
});

export const deriveConversationState = ({
  query = "",
  previousState = {},
  interruptionCount = 0,
  silencePromptCount = 0,
} = {}) => {
  const text = normalizeText(query);
  const state = {
    ...getInitialConversationState(),
    ...(previousState && typeof previousState === "object" ? previousState : {}),
  };

  const confused = hasAny(text, [
    "what do you mean",
    "did not understand",
    "dont understand",
    "confused",
    "not clear",
    "explain",
  ]);
  const frustrated = hasAny(text, [
    "frustrated",
    "not working",
    "useless",
    "waste",
    "again",
    "you keep repeating",
    "this is annoying",
  ]);
  const happy = hasAny(text, ["great", "awesome", "perfect", "thank you so much", "thats helpful"]);
  const interested = hasAny(text, [
    "tell me more",
    "interested",
    "sounds good",
    "how to apply",
    "next step",
    "what are the fees",
  ]);
  const urgent = hasAny(text, ["urgent", "quickly", "right now", "asap", "immediately"]);

  if (frustrated) state.userEmotion = "frustrated";
  else if (confused) state.userEmotion = "confused";
  else if (urgent) state.userEmotion = "urgent";
  else if (happy) state.userEmotion = "happy";
  else if (interested) state.userEmotion = "interested";
  else state.userEmotion = "neutral";

  const frustrationDelta =
    (frustrated ? 20 : 0) + (confused ? 8 : 0) + (interruptionCount > 2 ? 5 : 0) - (happy ? 10 : 0);
  state.frustrationLevel = clamp(Number(state.frustrationLevel || 0) + frustrationDelta, 0, 100);

  const engagementDelta =
    (interested ? 15 : 0) + (happy ? 10 : 0) - (silencePromptCount > 0 ? 10 : 0) - (frustrated ? 8 : 0);
  state.engagementLevel = clamp(Number(state.engagementLevel || 50) + engagementDelta, 0, 100);

  if (state.userEmotion === "frustrated") state.aiTone = "supportive";
  else if (state.userEmotion === "confused") state.aiTone = "supportive";
  else if (state.userEmotion === "interested") state.aiTone = "enthusiastic";
  else if (state.userEmotion === "urgent") state.aiTone = "urgent";
  else state.aiTone = "executive";

  return state;
};
