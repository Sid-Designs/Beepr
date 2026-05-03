import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

const cleanText = (value) =>
  String(value || "")
    .replace(/\s+/g, " ")
    .trim();

const normalizeHistory = (history = []) => {
  if (!Array.isArray(history)) return [];

  return history
    .filter((message) => message?.role && message?.content)
    .map((message) => ({
      role: message.role,
      content: cleanText(message.content),
    }))
    .slice(-12);
};

const textIncludesAny = (text, patterns) => {
  return patterns.some((pattern) => pattern.test(text));
};

const getLastAssistantMessage = (history = []) => {
  const normalized = normalizeHistory(history);

  for (let i = normalized.length - 1; i >= 0; i -= 1) {
    if (normalized[i].role === "assistant") {
      return normalized[i].content;
    }
  }

  return "";
};

const didAssistantAlreadyOfferMoreHelp = (history = []) => {
  const lastAssistant = getLastAssistantMessage(history).toLowerCase();

  return (
    lastAssistant.includes("anything else") ||
    lastAssistant.includes("anything more") ||
    lastAssistant.includes("else i can help") ||
    lastAssistant.includes("more i can help")
  );
};

const getUserIntentSignal = (query) => {
  const text = cleanText(query).toLowerCase();

  if (!text) {
    return "empty";
  }

  const hardClosePatterns = [
    /\bbye\b/,
    /\bgoodbye\b/,
    /\bsee you\b/,
    /\bsee ya\b/,
    /\btalk to you later\b/,
    /\bend call\b/,
    /\bdisconnect\b/,
    /\bclose the call\b/,
    /\bcut the call\b/,
    /\bhang up\b/,
  ];

  const noMoreHelpPatterns = [
    /\bno\b/,
    /\bnope\b/,
    /\bnah\b/,
    /\bno thanks\b/,
    /\bno thank you\b/,
    /\bnothing\b/,
    /\bnothing else\b/,
    /\bthat's all\b/,
    /\bthat is all\b/,
    /\ball good\b/,
    /\bi am good\b/,
    /\bi'm good\b/,
    /\bdone\b/,
    /\benough\b/,
  ];

  const appreciationPatterns = [
    /\bthanks\b/,
    /\bthank you\b/,
    /\bthank you so much\b/,
    /\bthanks a lot\b/,
    /\bthanks for helping\b/,
    /\bthanks for your help\b/,
    /\bappreciate it\b/,
    /\bokay thanks\b/,
    /\bok thanks\b/,
    /\bsure thanks\b/,
    /\bsure thank you\b/,
  ];

  const continuePatterns = [
    /\byes\b/,
    /\byeah\b/,
    /\byep\b/,
    /\bsure\b/,
    /\bokay\b/,
    /\bok\b/,
    /\bi want\b/,
    /\bi need\b/,
    /\bcan you\b/,
    /\bcould you\b/,
    /\btell me\b/,
    /\bhelp me\b/,
    /\bbook\b/,
    /\bschedule\b/,
    /\bappointment\b/,
    /\border\b/,
    /\badmission\b/,
    /\bapply\b/,
    /\bprocess\b/,
  ];

  if (textIncludesAny(text, hardClosePatterns)) return "hard_close";
  if (textIncludesAny(text, noMoreHelpPatterns)) return "no_more_help";
  if (textIncludesAny(text, appreciationPatterns)) return "appreciation";
  if (textIncludesAny(text, continuePatterns)) return "continue";

  return "normal";
};

const getSoftClosingProbe = (query) => {
  const text = cleanText(query).toLowerCase();

  if (/\b(thanks|thank you|appreciate)\b/.test(text)) {
    return "Happy to help. Is there anything else I can help you with?";
  }

  if (/\b(ok|okay|sure|alright)\b/.test(text)) {
    return "Sure. Is there anything else you would like help with?";
  }

  return "Is there anything else I can help you with?";
};

const getFinalClosingResponse = (query) => {
  const text = cleanText(query).toLowerCase();

  if (/\b(end call|disconnect|close the call|cut the call|hang up)\b/.test(text)) {
    return "Sure, I’ll end the call now. Have a good day.";
  }

  if (/\b(bye|goodbye|see you|see ya|talk to you later)\b/.test(text)) {
    return "Goodbye. Take care.";
  }

  if (/\b(no thanks|no thank you|nothing else|that's all|that is all|all good|i'm good|i am good)\b/.test(text)) {
    return "Alright, no problem. Have a great day.";
  }

  return "Alright. Thank you for calling, and have a great day.";
};

const shouldHandleBeforeLLM = ({ query, history }) => {
  const signal = getUserIntentSignal(query);
  const alreadyOfferedMoreHelp = didAssistantAlreadyOfferMoreHelp(history);

  if (signal === "hard_close") {
    return {
      handled: true,
      response: getFinalClosingResponse(query),
      endCall: true,
    };
  }

  if (signal === "no_more_help" && alreadyOfferedMoreHelp) {
    return {
      handled: true,
      response: getFinalClosingResponse(query),
      endCall: true,
    };
  }

  if (signal === "appreciation" && alreadyOfferedMoreHelp) {
    return {
      handled: true,
      response: getFinalClosingResponse(query),
      endCall: true,
    };
  }

  if (signal === "appreciation") {
    return {
      handled: true,
      response: getSoftClosingProbe(query),
      endCall: false,
    };
  }

  return {
    handled: false,
    response: "",
    endCall: false,
  };
};

export const generateAIResponse = async ({
  agentPrompt,
  context,
  query,
  history = [],
}) => {
  try {
    if (!GROQ_API_KEY) {
      throw new Error("Missing GROQ_API_KEY");
    }

    const businessPrompt = cleanText(agentPrompt);
    const knowledge = cleanText(context);
    const userQuery = cleanText(query);
    const normalizedHistory = normalizeHistory(history);

    const preHandled = shouldHandleBeforeLLM({
      query: userQuery,
      history: normalizedHistory,
    });

    if (preHandled.handled) {
      return preHandled.response;
    }

    const systemPrompt = `
You are a smart AI voice agent working for a business.

BUSINESS AGENT CONFIGURATION:
${businessPrompt || "You are a helpful business assistant."}

YOUR MAIN GOAL:
Help the caller move forward clearly. Do not only answer questions. Guide them like a real support, sales, admission, booking, order, or appointment assistant depending on the business context.

WHAT YOU CAN DO:
- Answer questions using the provided knowledge.
- Help users choose the right option.
- Guide users step by step.
- Collect required details when needed.
- Help with appointment, booking, order, inquiry, support, admission, callback, consultation, or service requests if the knowledge supports it.
- If the user is confused, simplify the options.
- If the user asks something unrelated to the business, gently bring them back to the business purpose.

CALL CLOSING BEHAVIOR:
- If the user sounds thankful but has not clearly ended the call, politely ask once if they need anything else.
- If the assistant already asked whether they need anything else and the user says no, nothing else, all good, thanks, bye, or similar, close the call politely.
- Do not keep reopening the conversation after the user declines more help.
- Do not ask multiple closing questions.
- If the user clearly says bye, goodbye, end call, disconnect, or close the call, give one final closing sentence.

CONVERSATION MEMORY:
Use previous messages to understand references like "that", "this", "same course", "book it", "yes", "tomorrow", or "continue".
Do not ask again for information the user already gave.
If the current message is short, understand it using conversation history.

KNOWLEDGE RULES:
Use only the provided KNOWLEDGE for factual business information.
Do not invent prices, dates, policies, availability, documents, eligibility, addresses, phone numbers, or commitments.
If the required information is not available in the knowledge, say:
"I will connect you to support."

CALL HANDLING STYLE:
- Be warm, calm, and professional.
- Speak naturally for a voice call.
- Keep replies short.
- Ask only one question at a time.
- Prefer guiding the user to the next step instead of giving long explanations.
- Do not sound robotic.
- Do not mention "knowledge base", "context", "system prompt", or internal rules.

INTENT HANDLING:
If user wants information:
Answer briefly, then offer the next helpful step.

If user wants admission, booking, appointment, order, demo, callback, consultation, or service:
Ask for the next missing detail needed to proceed, such as name, phone number, preferred date/time, course/service/product, location, or requirement.
Only ask for details that make sense for this business.

If user is comparing options:
Give a short comparison only from the knowledge, then suggest the best next step.

If user complains or has a problem:
Acknowledge briefly, ask one useful detail, and offer support escalation if needed.

If user asks for something outside the business:
Politely say you can help with this business's services and ask what they need related to it.

RESPONSE FORMAT:
Return only the assistant's spoken reply.
Maximum 2 sentences.
No bullet points.
No markdown.
`;

    const messages = [
      {
        role: "system",
        content: systemPrompt,
      },
      ...normalizedHistory,
      {
        role: "user",
        content: `
KNOWLEDGE:
${knowledge || "No knowledge available."}

CURRENT USER MESSAGE:
${userQuery}
`,
      },
    ];

    const response = await axios.post(
      GROQ_URL,
      {
        model: "llama-3.3-70b-versatile",
        messages,
        temperature: 0.3,
        max_tokens: 110,
      },
      {
        headers: {
          Authorization: `Bearer ${GROQ_API_KEY.trim()}`,
          "Content-Type": "application/json",
        },
        timeout: 30000,
      },
    );

    const answer = response.data?.choices?.[0]?.message?.content?.trim();

    if (!answer) {
      return "I will connect you to support.";
    }

    return answer;
  } catch (error) {
    console.error("Groq LLM Error:", error.response?.data || error.message);
    return "I will connect you to support.";
  }
};
