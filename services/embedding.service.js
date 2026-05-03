// import OpenAI from "openai";

// const openai = new OpenAI({
//   apiKey: process.env.OPENAI_API_KEY,
// });

// export const generateEmbedding = async (text) => {
//   if (!text || typeof text !== "string" || !text.trim()) {
//     throw new Error("Invalid text input for embedding");
//   }

//   try {
//     const response = await openai.embeddings.create({
//       model: "text-embedding-3-small",
//       input: text,
//     });

//     return response.data[0].embedding;
//   } catch (error) {
//     console.error("Embedding Error:", error?.message);
//     throw new Error("Embedding generation failed");
//   }
// };

import { CohereClient } from "cohere-ai";

let cohereClient;
let cohereToken;

const getCohereClient = () => {
  const token = process.env.COHERE_API_KEY || process.env.CO_API_KEY;

  if (!token) {
    throw new Error(
      "Missing Cohere API key. Set COHERE_API_KEY or CO_API_KEY.",
    );
  }

  if (!cohereClient || cohereToken !== token) {
    cohereClient = new CohereClient({ token });
    cohereToken = token;
  }

  return cohereClient;
};

/**
 * Generate embedding using Cohere
 */
export const generateEmbedding = async (
  text,
  inputType = "search_document",
) => {
  if (!text || typeof text !== "string" || !text.trim()) {
    throw new Error("Invalid text input for embedding");
  }

  try {
    const response = await getCohereClient().embed({
      texts: [text],
      model: "embed-english-v3.0",
      inputType,
    });

    return response.embeddings[0];
  } catch (error) {
    console.error("Cohere Embedding Error:", error.message);
    throw new Error("Embedding generation failed");
  }
};