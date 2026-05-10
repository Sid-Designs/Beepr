import { v4 as uuidv4 } from "uuid";
import KnowledgeBase from "../../models/knowledgeBase.model.js";
import {
  parsePdfDocument,
  parseTextDocument,
  parseUrlDocument,
} from "./parser.service.js";
import { chunkSections } from "./chunk.service.js";
import { embedChunks } from "./embedding.service.js";

const buildDocId = (prefix) => `${prefix}_${Date.now()}_${uuidv4()}`;

const storeChunks = async ({
  tenantId,
  agentId,
  docId,
  sourceType,
  sourceUrl,
  chunks,
}) => {
  if (!chunks.length) return { inserted: 0 };

  const embedded = await embedChunks(chunks);

  const documents = embedded.map((item) => ({
    tenantId,
    agentId,
    docId,
    text: item.text,
    content: item.text,
    embedding: item.vector,
    metadata: {
      heading: item.metadata.heading,
      chunkIndex: item.metadata.chunkIndex,
      sourceType,
      sourceUrl,
    },
    sourceType,
    sourceUrl,
    sourceId: docId,
  }));

  await KnowledgeBase.insertMany(documents);
  return { inserted: documents.length };
};

export const ingestText = async ({ tenantId, agentId, text }) => {
  const docId = buildDocId("text");
  const parsed = await parseTextDocument(text, "Text Document");

  const chunks = chunkSections(parsed.sections, {
    docId,
    sourceType: "text",
  });

  return storeChunks({
    tenantId,
    agentId,
    docId,
    sourceType: "text",
    chunks,
  });
};

export const ingestPdf = async ({
  tenantId,
  agentId,
  filePath,
  fileName,
}) => {
  const docId = buildDocId("pdf");
  const parsed = await parsePdfDocument(filePath, fileName || "PDF Document");

  const chunks = chunkSections(parsed.sections, {
    docId,
    sourceType: "pdf",
  });

  return storeChunks({
    tenantId,
    agentId,
    docId,
    sourceType: "pdf",
    chunks,
  });
};

export const ingestUrl = async ({ tenantId, agentId, url }) => {
  const docId = buildDocId("url");
  const parsed = await parseUrlDocument(url);

  const chunks = chunkSections(parsed.sections, {
    docId,
    sourceType: "url",
    sourceUrl: url,
  });

  return storeChunks({
    tenantId,
    agentId,
    docId,
    sourceType: "url",
    sourceUrl: url,
    chunks,
  });
};
