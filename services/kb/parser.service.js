import fs from "node:fs";
import { createRequire } from "node:module";
import axios from "axios";
import * as cheerio from "cheerio";

const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse");

const cleanText = (text) => {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
};

const buildSectionsFromHtml = ($, title) => {
  const sections = [];
  let current = {
    heading: title || "Document",
    content: "",
  };

  const nodes = $("h1, h2, h3, p, li").toArray();

  for (const node of nodes) {
    const $node = $(node);
    const tag = node.tagName?.toLowerCase();
    const text = cleanText($node.text());

    if (!text) continue;

    if (tag === "h1" || tag === "h2" || tag === "h3") {
      if (current.content.trim()) {
        sections.push({
          heading: current.heading,
          content: current.content.trim(),
        });
      }
      current = {
        heading: text,
        content: "",
      };
      continue;
    }

    if (current.content) {
      current.content += `\n${text}`;
    } else {
      current.content = text;
    }
  }

  if (current.content.trim()) {
    sections.push({
      heading: current.heading,
      content: current.content.trim(),
    });
  }

  if (sections.length === 0) {
    const fallback = cleanText($("body").text());
    if (fallback) {
      sections.push({ heading: title || "Document", content: fallback });
    }
  }

  return sections;
};

export const parsePdfDocument = async (filePath, titleOverride = "") => {
  const buffer = fs.readFileSync(filePath);
  const result = await pdfParse(buffer);
  const text = cleanText(result.text);

  return {
    title: titleOverride || "PDF Document",
    sections: text
      ? [{ heading: titleOverride || "PDF Document", content: text }]
      : [],
  };
};

export const parseUrlDocument = async (url) => {
  const response = await axios.get(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    },
    timeout: 15000,
  });

  const $ = cheerio.load(response.data);
  $("script, style, noscript, iframe, header, footer, nav, svg").remove();

  const title = cleanText($("title").text());
  const sections = buildSectionsFromHtml($, title || url);

  return { title: title || url, sections };
};

export const parseTextDocument = async (text, titleOverride = "Document") => {
  const cleaned = cleanText(text);
  return {
    title: titleOverride,
    sections: cleaned ? [{ heading: titleOverride, content: cleaned }] : [],
  };
};
