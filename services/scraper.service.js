import axios from "axios";
import * as cheerio from "cheerio";

const cleanText = (text) => {
  return text
    // remove common UI noise
    .replace(/Read More|Apply Now|Login|Sign Up/gi, "")
    // collapse whitespace
    .replace(/\s+/g, " ")
    .trim();
};

const uniqueLines = (text) => {
  const seen = new Set();
  return text
    .split(". ")
    .filter((line) => {
      const key = line.trim().toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join(". ");
};

export const extractTextFromURL = async (url) => {
  try {
    const { data } = await axios.get(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
      timeout: 10000,
    });

    const $ = cheerio.load(data);

    // 1) Remove obvious noise
    $("script, style, noscript, iframe, header, footer, nav, svg").remove();

    // 2) Prefer main content containers
    let text =
      $("main").text() ||
      $("article").text() ||
      $(".content").text() ||
      $("body").text();

    // 3) Clean + dedupe
    text = cleanText(text);
    text = uniqueLines(text);

    return text;
  } catch (error) {
    console.error("Scraper Error:", error.message);
    throw new Error("Failed to scrape URL");
  }
};