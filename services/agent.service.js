import mongoose from "mongoose";

import Agent from "../models/agent.model.js";
import Tenant from "../models/tenant.model.js";
import generateAgentPrompt from "./prompt.service.js";

const createAgent = async (data) => {
  const { tenantId, name, type, tone, script, faqs = [] } = data;

  // 1. Basic validation
  if (!tenantId || !name || !type) {
    throw new Error("tenantId, name, and type are required");
  }

  if (!mongoose.isValidObjectId(tenantId)) {
    throw new Error("Invalid tenantId format");
  }

  // 2. Validate tenant
  const tenant = await Tenant.findById(tenantId);

  if (!tenant) {
    throw new Error("Tenant not found");
  }

  if (!tenant.isActive) {
    throw new Error("Tenant is inactive");
  }

  // 3. Enforce agent limit (based on plan)
  const existingAgents = await Agent.countDocuments({ tenantId });

  if (existingAgents >= tenant.usageLimits.maxAgents) {
    throw new Error("Agent limit reached for current plan");
  }

  // 4. Generate prompt (IMPORTANT)
  const prompt = generateAgentPrompt(
    { name, type, tone, script, faqs },
    tenant,
  );

  // 5. Create agent
  const agent = new Agent({
    tenantId,
    name,
    type,
    tone,
    script,
    faqs,
    prompt,
  });

  await agent.save();

  return agent;
};

const getAgentsByTenant = async (tenantId) => {
  if (!tenantId) {
    throw new Error("tenantId is required");
  }

  const agents = await Agent.find({ tenantId })
    .sort({ createdAt: -1 });

  return agents;
};

const getAgentById = async (tenantId, agentId) => {
  if (!tenantId || !agentId) {
    throw new Error("tenantId and agentId are required");
  }

  if (!mongoose.isValidObjectId(tenantId)) {
    throw new Error("Invalid tenantId format");
  }

  if (!mongoose.isValidObjectId(agentId)) {
    throw new Error("Invalid agentId format");
  }

  const agent = await Agent.findOne({ _id: agentId, tenantId });

  if (!agent) {
    const agentById = await Agent.findById(agentId).select("tenantId");

    if (agentById) {
      throw new Error("Agent does not belong to the specified tenant");
    }

    throw new Error("Agent not found");
  }

  return agent;
};

export { createAgent, getAgentsByTenant, getAgentById };

export default { createAgent, getAgentsByTenant, getAgentById };