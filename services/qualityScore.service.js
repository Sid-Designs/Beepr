const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export const scoreConversationQuality = ({
  answer = "",
  conversationState = {},
  analyticsSnapshot = {},
} = {}) => {
  const length = String(answer || "").length;
  const interruptions = Number(analyticsSnapshot?.interruptions || 0);
  const fallbackCount = Number(analyticsSnapshot?.fallbackCount || 0);
  const emotion = String(conversationState?.userEmotion || "neutral");

  let naturalness = 80;
  if (length > 260) naturalness -= 10;
  if (fallbackCount > 2) naturalness -= 12;
  if (emotion === "frustrated" && fallbackCount > 0) naturalness -= 8;

  let guidance = 78;
  if (/\?/.test(answer)) guidance += 5;
  if (fallbackCount > 1) guidance -= 6;

  let repetitionRisk = 20 + fallbackCount * 12;
  repetitionRisk = clamp(repetitionRisk, 0, 100);

  const interactionFlow = clamp(82 - Math.max(0, interruptions - 3) * 6, 45, 95);
  const overall = Math.round((naturalness + guidance + (100 - repetitionRisk) + interactionFlow) / 4);

  return {
    naturalness: clamp(Math.round(naturalness), 0, 100),
    guidance: clamp(Math.round(guidance), 0, 100),
    repetitionRisk,
    interactionFlow,
    overall,
  };
};
