import express from "express";
import {
  checkRoomStatus,
  checkSipDiagnostic,
  getLiveKitToken,
  startWorker,
} from "../controllers/livekit.controller.js";
import { handleLiveKitSipWebhook } from "../controllers/sip.controller.js";

const router = express.Router();

router.get("/token", getLiveKitToken);
router.post("/token", getLiveKitToken);
router.post("/worker/start", startWorker);
router.post("/sip/webhook", handleLiveKitSipWebhook);
router.get("/sip/diagnostic", checkSipDiagnostic);
router.get("/room/status/:roomName", checkRoomStatus);

export default router;
