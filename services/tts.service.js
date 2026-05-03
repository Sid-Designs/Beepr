import fetch from "node-fetch";

const API_KEY = process.env.SARVAM_API_KEY;
const TTS_URL = "https://api.sarvam.ai/text-to-speech";

export const generateSpeech = async (text) => {
  if (!API_KEY) throw new Error("SARVAM_API_KEY missing");
  if (!text || typeof text !== "string") {
    throw new Error("Invalid text input");
  }

  const response = await fetch(TTS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-subscription-key": API_KEY, 
    },
    body: JSON.stringify({
      text: text,              
      voice: "anushka",
      language: "en-IN",
      output_format: "wav",
      sample_rate: 16000,
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