import express from "express";
import tenantController from "../controllers/tenant.controller.js";

const router = express.Router();

router.post("/register", tenantController.registerTenant);

export default router;
