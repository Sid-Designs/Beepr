import agentController from "../controllers/agent.controller.js";
import express from "express";

const router = express.Router();

router.post("/create", agentController.createAgent);
router.get("/list/:tenantId", agentController.getAgents);
router.get("/:tenantId/:agentId", agentController.getAgentById);

export default router;
