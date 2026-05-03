import KnowledgeBase from "../models/knowledgeBase.model.js";
import { generateEmbedding } from "./embedding.service.js";

const cosineSimilarity = (a, b) => {
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
  return text
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
    const key = item.content.trim();
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

export const getRelevantContext = async (
  query,
  tenantId,
  agentId,
  options = {},
) => {
  const {
    topK = 5,
    minScore = 0.15,
    semanticWeight = 0.65,
    keywordWeight = 0.35,
    maxCandidates = 500,
  } = options;

  const queryEmbedding = await generateEmbedding(query, "search_query");
  const queryTokens = tokenize(query);

  const kbData = await KnowledgeBase.find({ tenantId, agentId })
    .select("content embedding sourceType sourceUrl sourceId")
    .limit(maxCandidates);

  const scored = kbData
    .filter((item) => !isNoisyContent(item.content))
    .map((item) => {
      const semantic = cosineSimilarity(queryEmbedding, item.embedding);
      const keyword = keywordScore(queryTokens, item.content);
      const score = semantic * semanticWeight + keyword * keywordWeight;

      return {
        id: item._id?.toString?.() || undefined,
        content: item.content,
        score,
        semanticScore: semantic,
        keywordScore: keyword,
        sourceType: item.sourceType,
        sourceUrl: item.sourceUrl,
        sourceId: item.sourceId,
      };
    })
    .filter((item) => item.score >= minScore)
    .sort((a, b) => b.score - a.score);

  return dedupeByContent(scored).slice(0, topK);
};