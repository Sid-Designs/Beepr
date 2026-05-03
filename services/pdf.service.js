import fs from "fs";
import { PDFParse } from "pdf-parse";

export const extractTextFromPDF = async (filePath) => {
  try {
    const buffer = fs.readFileSync(filePath);
    const parser = new PDFParse({ data: buffer });
    const result = await parser.getText();

    await parser.destroy();

    return result.text;
  } catch (error) {
    console.error("PDF Extract Error:", error.message);
    throw new Error("Failed to extract PDF text");
  }
};