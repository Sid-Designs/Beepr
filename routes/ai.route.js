import express from "express";
import { handleQuery } from "../controllers/ai.controller.js";

const router = express.Router();

router.post("/query", handleQuery);

export default router;