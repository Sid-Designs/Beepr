import KnowledgeBase from "../models/knowledgeBase.model.js";
import { splitTextIntoChunks } from "../utils/chunk.util.js";
import { generateEmbedding } from "../services/embedding.service.js";
import { v4 as uuidv4 } from "uuid";

import { extractTextFromPDF } from "../services/pdf.service.js";
import fs from "fs";

import { extractTextFromURL } from "../services/scraper.service.js";

import { getRelevantContext } from "../services/retrieval.service.js";

export const addTextToKB = async (req, res) => {
  try {
    const { tenantId, agentId, text } = req.body;

    // 1. Validate input
    if (!tenantId || !agentId || !text) {
      return res.status(400).json({
        success: false,
        message: "tenantId, agentId and text are required",
      });
    }

    // 2. Generate sourceId (grouping)
    const sourceId = `text_${uuidv4()}`;

    // 3. Chunk text
    const chunks = splitTextIntoChunks(text);

    if (chunks.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No valid content to process",
      });
    }

    // 4. Process each chunk
    const documents = [];

    for (const chunk of chunks) {
      const embedding = await generateEmbedding(chunk);

      documents.push({
        tenantId,
        agentId,
        content: chunk,
        embedding,
        sourceType: "text",
        sourceId,
      });
    }

    // 5. Insert into DB
    await KnowledgeBase.insertMany(documents);

    // 6. Response
    return res.status(200).json({
      success: true,
      message: "Text processed and stored successfully",
      totalChunks: documents.length,
    });
  } catch (error) {
    console.error("KB Text Error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Internal Server Error",
    });
  }
};

export const addPDFToKB = async (req, res) => {
  try {
    const { tenantId, agentId } = req.body;

    if (!tenantId || !agentId || !req.file) {
      return res.status(400).json({
        success: false,
        message: "tenantId, agentId and PDF file are required",
      });
    }

    // 1. Extract text
    const text = await extractTextFromPDF(req.file.path);

    // 2. Generate sourceId
    const sourceId = `pdf_${Date.now()}`;

    // 3. Chunk text
    const chunks = splitTextIntoChunks(text);

    const documents = [];

    for (const chunk of chunks) {
      const embedding = await generateEmbedding(chunk);

      documents.push({
        tenantId,
        agentId,
        content: chunk,
        embedding,
        sourceType: "pdf",
        sourceId,
      });
    }

    // 4. Save to DB
    await KnowledgeBase.insertMany(documents);

    // 5. Delete uploaded file (cleanup)
    fs.unlinkSync(req.file.path);

    return res.status(200).json({
      success: true,
      message: "PDF processed successfully",
      totalChunks: documents.length,
    });
  } catch (error) {
    console.error("PDF KB Error:", error.message);

    fs.unlinkSync(req.file.path); // Delete uploaded file (cleanup)

    return res.status(500).json({
      success: false,
      message: "Internal Server Error",
    });
  }
};

export const addURLToKB = async (req, res) => {
  try {
    const { tenantId, agentId, urls } = req.body;

    if (!tenantId || !agentId || !urls || urls.length === 0) {
      return res.status(400).json({
        success: false,
        message: "tenantId, agentId and urls are required",
      });
    }

    const allDocuments = [];

    for (const url of urls) {
      try {
        // 1. Scrape content
        const text = await extractTextFromURL(url);

        if (!text) continue;

        // 2. Chunk
        const chunks = splitTextIntoChunks(text);

        const sourceId = `url_${Date.now()}`;

        for (const chunk of chunks) {
          const embedding = await generateEmbedding(chunk);

          allDocuments.push({
            tenantId,
            agentId,
            content: chunk,
            embedding,
            sourceType: "url",
            sourceUrl: url,
            sourceId,
          });
        }
      } catch (err) {
        console.error(`Error processing URL: ${url}`, err.message);
        continue; // skip failed URL
      }
    }

    if (allDocuments.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No content could be extracted from URLs",
      });
    }

    // Save all chunks
    await KnowledgeBase.insertMany(allDocuments);

    return res.status(200).json({
      success: true,
      message: "URLs processed successfully",
      totalChunks: allDocuments.length,
    });
  } catch (error) {
    console.error("URL KB Error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Internal Server Error",
    });
  }
};

export const queryKB = async (req, res) => {
  try {
    const { tenantId, agentId, query } = req.body;

    // 1. Validation
    if (!tenantId || !agentId || !query) {
      return res.status(400).json({
        success: false,
        message: "tenantId, agentId and query are required",
      });
    }

    // 2. Get relevant context
    const context = await getRelevantContext(
      query,
      tenantId,
      agentId,
      3 // topK
    );

    return res.status(200).json({
      success: true,
      query,
      context,
    });
  } catch (error) {
    console.error("Query KB Error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Internal Server Error",
    });
  }
};