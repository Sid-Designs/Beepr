import KnowledgeBase from "../../models/knowledgeBase.model.js";
import { embedQuery } from "./embedding.service.js";

const cosineSimilarity = (a, b) => {
  if (!Array.isArray(a) || !Array.isArray(b)) return 0;
  const dot = a.reduce((sum, v, i) => sum + v * b[i], 0);
  const magA = Math.sqrt(a.reduce((s, v) => s + v * v, 0));
  const magB = Math.sqrt(b.reduce((s, v) => s + v * v, 0));
  if (!magA || !magB) return 0;
  return dot / (magA * magB);
};

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "to",
  "of",
  "in",
  "for",
  "on",
  "with",
  "is",
  "are",
  "was",
  "were",
  "be",
  "by",
  "as",
  "at",
  "from",
  "that",
  "this",
  "it",
  "you",
  "your",
]);

const tokenize = (text) => {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token && !STOPWORDS.has(token));
};

const keywordScore = (queryTokens, content) => {
  if (queryTokens.length === 0) return 0;
  const contentTokens = new Set(tokenize(content));
  let matches = 0;

  for (const token of queryTokens) {
    if (contentTokens.has(token)) matches += 1;
  }

  return matches / queryTokens.length;
};

const dedupeByContent = (items) => {
  const seen = new Set();
  const result = [];

  for (const item of items) {
    const key = item.text.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }

  return result;
};

const isNoisyContent = (content) => {
  const text = content.toLowerCase();
  const noisyPhrases = [
    "add to cart",
    "add to wishlist",
    "quick view",
    "sort by",
    "columns",
    "read more",
    "continue reading",
    "follow us",
  ];

  if (content.length < 40) return true;
  if (noisyPhrases.some((phrase) => text.includes(phrase))) return true;

  const alphaRatio = (content.match(/[a-z]/gi)?.length || 0) / content.length;
  return alphaRatio < 0.4;
};

export const retrieveContext = async (
  query,
  tenantId,
  agentId,
  options = {},
) => {
  const {
    topK = 5,
    minScore = 0.18,
    semanticWeight = 0.7,
    keywordWeight = 0.3,
    maxCandidates = 400,
  } = options;

  const queryEmbedding = await embedQuery(query);
  const queryTokens = tokenize(query);

  const kbData = await KnowledgeBase.find({ tenantId, agentId })
    .select("text content embedding metadata sourceType sourceUrl docId")
    .limit(maxCandidates)
    .lean();

  const scored = kbData
    .map((item) => {
      const text = item.text || item.content || "";
      return {
        id: item._id?.toString?.() || undefined,
        text,
        metadata: item.metadata,
        sourceType: item.sourceType,
        sourceUrl: item.sourceUrl,
        docId: item.docId,
        score: cosineSimilarity(queryEmbedding, item.embedding),
      };
    })
    .filter((item) => item.text && !isNoisyContent(item.text))
    .map((item) => {
      const keyword = keywordScore(queryTokens, item.text);
      const score = item.score * semanticWeight + keyword * keywordWeight;
      return { ...item, score, keywordScore: keyword };
    })
    .filter((item) => item.score >= minScore)
    .sort((a, b) => b.score - a.score);

  return dedupeByContent(scored).slice(0, topK);
};
