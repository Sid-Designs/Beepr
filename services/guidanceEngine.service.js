const normalizeText = (value) =>
  String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

const hasAny = (text, items = []) => items.some((item) => text.includes(item));

export const detectObjectionType = (query = "") => {
  const text = normalizeText(query);
  if (!text) return "";
  if (hasAny(text, ["not interested", "no thanks", "do not call"])) return "not_interested";
  if (hasAny(text, ["call later", "later", "busy now"])) return "call_later";
  if (hasAny(text, ["expensive", "too costly", "high fees", "price high"])) return "price";
  if (hasAny(text, ["send details", "whatsapp", "message me"])) return "send_details";
  return "";
};

export const getNextBestAction = ({ query = "", state = {}, conversationState = {} } = {}) => {
  const objection = detectObjectionType(query);
  if (objection) return { action: "handle_objection", objection };
  if (conversationState?.userEmotion === "confused") return { action: "clarify", objection: "" };
  if (conversationState?.userEmotion === "frustrated") return { action: "reassure", objection: "" };
  if (!state?.greeted) return { action: "open", objection: "" };
  if (state?.leadStatus === "qualified") return { action: "close_or_confirm", objection: "" };
  return { action: "qualify", objection: "" };
};

export const getObjectionGuidance = (objection = "", language = "en") => {
  const isHi = language === "hi";
  const isMr = language === "mr";

  if (objection === "call_later") {
    if (isMr) return "त्यांना short acknowledge करून convenient वेळ विचार.";
    if (isHi) return "संक्षेप में acknowledge करके convenient समय पूछो.";
    return "Acknowledge briefly and ask for a convenient follow-up time.";
  }
  if (objection === "price") {
    if (isMr) return "Value + options समजावून next practical step विचारा.";
    if (isHi) return "Value और options समझाकर practical next step पूछो.";
    return "Address value clearly, then ask one practical next-step question.";
  }
  if (objection === "send_details") {
    if (isMr) return "Details देण्याचा मार्ग confirm करा आणि एक qualifying question विचारा.";
    if (isHi) return "Details भेजने का तरीका confirm करो और एक qualifying question पूछो.";
    return "Confirm how to share details and ask one qualifying question.";
  }
  if (objection === "not_interested") {
    if (isMr) return "Graceful close करा; दबाव आणू नका.";
    if (isHi) return "Graceful close करो; push मत करो.";
    return "Close gracefully without pressure.";
  }
  return "";
};
