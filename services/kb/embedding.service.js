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

const BATCH_SIZE = 64;

export const embedChunks = async (chunks, inputType = "search_document") => {
  if (!Array.isArray(chunks) || chunks.length === 0) return [];

  const client = getCohereClient();
  const results = [];

  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    const texts = batch.map((chunk) => chunk.text);

    const response = await client.embed({
      texts,
      model: "embed-english-v3.0",
      inputType,
    });

    const embeddings = response.embeddings || [];

    for (let j = 0; j < batch.length; j += 1) {
      results.push({
        vector: embeddings[j],
        text: batch[j].text,
        metadata: batch[j].metadata,
      });
    }
  }

  return results;
};

export const embedQuery = async (query) => {
  const client = getCohereClient();
  const response = await client.embed({
    texts: [query],
    model: "embed-english-v3.0",
    inputType: "search_query",
  });

  return response.embeddings?.[0];
};
