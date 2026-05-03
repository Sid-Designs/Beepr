export const splitTextIntoChunks = (text, maxWords = 400) => {
  if (!text || typeof text !== "string") return [];

  // 1. Clean text
  const cleanedText = text
    .replace(/\s+/g, " ")
    .replace(/\n+/g, " ")
    .trim();

  // 2. Split into sentences
  const sentences = cleanedText.split(/(?<=[.?!])\s+/);

  const chunks = [];
  let currentChunk = [];
  let wordCount = 0;

  for (const sentence of sentences) {
    const words = sentence.split(" ").length;

    // If adding sentence exceeds limit → push chunk
    if (wordCount + words > maxWords) {
      if (currentChunk.length > 0) {
        chunks.push(currentChunk.join(" ").trim());
      }
      currentChunk = [sentence];
      wordCount = words;
    } else {
      currentChunk.push(sentence);
      wordCount += words;
    }
  }

  // Push last chunk
  if (currentChunk.length > 0) {
    chunks.push(currentChunk.join(" ").trim());
  }

  return chunks;
};