import express from "express";
import {
  handleAnswerWebhook,
  handleHangupWebhook,
  triggerOutboundCall,
  createSipCallSession,
  initiateSipCall,
  startSipCall,
  debugXmlFormats,
} from "../controllers/call.controller.js";

const router = express.Router();

// ===== UNIFIED ONE-CLICK API =====
router.post("/sip/start", startSipCall);

// ===== SIP Session Management =====
router.post("/sip/session", createSipCallSession);
router.post("/sip/initiate", initiateSipCall);

// ===== Debug Endpoints =====
router.get("/debug/xml-formats", debugXmlFormats);

// ===== VoIPBIZ Webhooks =====
router.post("/answer", handleAnswerWebhook);
router.post("/hangup", handleHangupWebhook);
router.post("/trigger", triggerOutboundCall);

export default router;
