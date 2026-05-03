import express from "express";
import { getLiveKitToken, startWorker } from "../controllers/livekit.controller.js";

const router = express.Router();

router.get("/token", getLiveKitToken);
router.post("/worker/start", startWorker);

export default router;
