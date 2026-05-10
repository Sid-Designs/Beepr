const DEFAULT_CHUNK_TOKENS = 400;
const DEFAULT_OVERLAP_TOKENS = 80;
const DEFAULT_MIN_TOKENS = 80;

const tokenize = (text) => {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
};

const detokenize = (tokens) => tokens.join(" ").trim();

export const chunkSections = (
  sections,
  metadata = {},
  options = {},
) => {
  const chunkTokens =
    Number.parseInt(options.chunkTokens || DEFAULT_CHUNK_TOKENS, 10) ||
    DEFAULT_CHUNK_TOKENS;
  const overlapTokens =
    Number.parseInt(options.overlapTokens || DEFAULT_OVERLAP_TOKENS, 10) ||
    DEFAULT_OVERLAP_TOKENS;
  const minTokens =
    Number.parseInt(options.minTokens || DEFAULT_MIN_TOKENS, 10) ||
    DEFAULT_MIN_TOKENS;

  if (!Array.isArray(sections)) return [];

  const chunks = [];
  let chunkIndex = 0;

  for (const section of sections) {
    const heading = section?.heading || metadata.heading || "Document";
    const tokens = tokenize(section?.content || "");

    if (tokens.length === 0) continue;

    let start = 0;

    while (start < tokens.length) {
      const end = Math.min(start + chunkTokens, tokens.length);
      const windowTokens = tokens.slice(start, end);

      if (windowTokens.length >= minTokens || end === tokens.length) {
        const text = detokenize(windowTokens);

        chunks.push({
          text,
          metadata: {
            ...metadata,
            heading,
            chunkIndex,
          },
        });

        chunkIndex += 1;
      }

      if (end >= tokens.length) break;
      start = Math.max(0, end - overlapTokens);
    }
  }

  return chunks;
};
