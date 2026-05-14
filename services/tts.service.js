import fetch from "node-fetch";

const API_KEY = process.env.SARVAM_API_KEY;
const TTS_URL = "https://api.sarvam.ai/text-to-speech";

const resolveSpeechRate = (tone = "calm") => {
  if (tone === "executive") return 1.01;
  if (tone === "supportive" || tone === "educational") return 0.92;
  if (tone === "enthusiastic") return 1.05;
  if (tone === "urgent") return 1.08;
  return 1.0;
};

const resolveLanguageConfig = (language = "en") => {
  const key = String(language || "en").toLowerCase();
  if (key === "hi" || key === "hindi") {
    return { language: "hi-IN", voice: process.env.TTS_VOICE_HI || "anushka" };
  }
  if (key === "mr" || key === "marathi") {
    return { language: "mr-IN", voice: process.env.TTS_VOICE_MR || "anushka" };
  }
  return { language: "en-IN", voice: process.env.TTS_VOICE_EN || "anushka" };
};

export const generateSpeech = async (text, options = {}) => {
  if (!API_KEY) throw new Error("SARVAM_API_KEY missing");
  if (!text || typeof text !== "string") {
    throw new Error("Invalid text input");
  }

  const tone = String(options?.tone || "calm");
  const speechRate = resolveSpeechRate(tone);
  const languageInfo = resolveLanguageConfig(options?.language || "en");

  const response = await fetch(TTS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-subscription-key": API_KEY, 
    },
    body: JSON.stringify({
      text: text,              
      voice: languageInfo.voice,
      language: languageInfo.language,
      output_format: "wav",
      sample_rate: 16000,
      speech_rate: speechRate,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    console.error("TTS ERROR:", err);
    throw new Error(err);
  }

  const contentType = response.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    const payload = await response.json();

    const audioBase64 =
      payload?.audio ||
      payload?.audios?.[0] ||
      payload?.data?.audio ||
      payload?.result?.audio;

    if (!audioBase64) {
      console.error("Invalid payload:", payload);
      throw new Error("No audio returned");
    }

    return Buffer.from(audioBase64, "base64");
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  if (buffer.subarray(0, 4).toString("ascii") !== "RIFF") {
    console.warn("⚠️ Not a valid WAV header");
  }

  return buffer;
};