import LeadOutcome from "../models/leadOutcome.model.js";

const cleanText = (value, max = 300) =>
  String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

export const upsertLeadOutcome = async ({
  tenantId,
  agentId,
  sessionId,
  roomName,
  objective,
  stage,
  leadStatus,
  collectedData,
  summary,
  endReason,
  isClosed,
  turnCount,
  lastUserMessage,
  lastAssistantMessage,
}) => {
  if (!tenantId || !agentId || !sessionId) return null;

  const update = {
    tenantId,
    agentId,
    roomName: cleanText(roomName, 120),
    objective: cleanText(objective, 80) || "custom",
    stage: cleanText(stage, 80) || "opening",
    leadStatus: cleanText(leadStatus, 80) || "new",
    collectedData: collectedData || {},
    summary: cleanText(summary, 500),
    endReason: cleanText(endReason, 200),
    isClosed: Boolean(isClosed),
    turnCount: Number.isFinite(turnCount) ? turnCount : 0,
    lastUserMessage: cleanText(lastUserMessage, 500),
    lastAssistantMessage: cleanText(lastAssistantMessage, 500),
  };

  return LeadOutcome.findOneAndUpdate(
    { sessionId },
    { $set: update, $setOnInsert: { sessionId } },
    {
      upsert: true,
      returnDocument: "after",
      runValidators: true,
      setDefaultsOnInsert: true,
    },
  );
};
