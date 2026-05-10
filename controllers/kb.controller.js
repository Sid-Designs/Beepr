import fs from "fs";
import {
  ingestPdf,
  ingestText,
  ingestUrl,
} from "../services/kb/ingest.service.js";
import { retrieveContext } from "../services/kb/retrieval.service.js";

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

    const result = await ingestText({ tenantId, agentId, text });

    if (!result.inserted) {
      return res.status(400).json({
        success: false,
        message: "No valid content to process",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Text processed and stored successfully",
      totalChunks: result.inserted,
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

    const result = await ingestPdf({
      tenantId,
      agentId,
      filePath: req.file.path,
      fileName: req.file.originalname,
    });

    fs.unlinkSync(req.file.path);

    return res.status(200).json({
      success: true,
      message: "PDF processed successfully",
      totalChunks: result.inserted,
    });
  } catch (error) {
    console.error("PDF KB Error:", error.message);

    if (req.file?.path) {
      fs.unlinkSync(req.file.path);
    }

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

    let totalChunks = 0;

    for (const url of urls) {
      try {
        const result = await ingestUrl({ tenantId, agentId, url });
        totalChunks += result.inserted || 0;
      } catch (err) {
        console.error(`Error processing URL: ${url}`, err.message);
        continue; // skip failed URL
      }
    }

    if (!totalChunks) {
      return res.status(400).json({
        success: false,
        message: "No content could be extracted from URLs",
      });
    }

    return res.status(200).json({
      success: true,
      message: "URLs processed successfully",
      totalChunks,
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
    const context = await retrieveContext(query, tenantId, agentId, {
      topK: 5,
    });

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