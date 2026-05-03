import express from "express";
import multer from "multer";
import { addPDFToKB, addTextToKB } from "../controllers/kb.controller.js";
import { addURLToKB, queryKB } from "../controllers/kb.controller.js";

const router = express.Router();
const upload = multer({ dest: "uploads/" });

router.post("/text", addTextToKB);
router.post("/pdf", upload.single("file"), addPDFToKB);
router.post("/url", addURLToKB);
router.post("/query", queryKB);

export default router;