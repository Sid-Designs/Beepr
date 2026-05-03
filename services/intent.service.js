import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

const extractJson = (text) => {
  if (!text) return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;

  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
};

export const detectIntentFromContext = async ({
  agentPrompt,
  context,
  query,
  history = [],
}) => {
  if (!query || !context) return null;

  const systemPrompt = `You are an intent classifier for a call agent.\n\nUse the conversation history and knowledge context to infer the user intent and stage.\nReturn JSON only with these keys: intent, stage, nextQuestion.\n- intent: short lowercase id (e.g. admission, pricing, delivery, returns, product_inquiry, booking) or "none"\n- stage: awareness | consideration | decision | support | none\n- nextQuestion: a short, friendly follow-up question to move the call forward, or empty string if not needed\n\nRules:\n- Use ONLY the provided knowledge context and conversation history.\n- If no clear intent, set intent to "none" and stage to "none".\n- Keep nextQuestion under 120 characters.\n- Output JSON only.`;

  const messages = [
    { role: "system", content: `${systemPrompt}\n\nAgent prompt:\n${agentPrompt}` },
    ...(history || []),
    {
      role: "user",
      content: `KNOWLEDGE:\n${context}\n\nCURRENT QUERY:\n${query}`,
    },
  ];

  try {
    const response = await axios.post(
      GROQ_URL,
      {
        model: "llama-3.3-70b-versatile",
        messages,
        temperature: 0.2,
        max_tokens: 120,
      },
      {
        headers: {
          Authorization: `Bearer ${GROQ_API_KEY.trim()}`,
          "Content-Type": "application/json",
        },
      },
    );

    const raw = response.data?.choices?.[0]?.message?.content?.trim();
    const parsed = extractJson(raw);

    if (!parsed || typeof parsed.intent !== "string") return null;

    return {
      intent: parsed.intent,
      stage: parsed.stage || "none",
      nextQuestion: parsed.nextQuestion || "",
    };
  } catch (error) {
    console.error("Intent Detection Error:", error.response?.data || error.message);
    return null;
  }
};
