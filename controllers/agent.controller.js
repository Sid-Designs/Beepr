import agentService from "../services/agent.service.js";

const createAgent = async (req, res, next) => {
  try {
    const agent = await agentService.createAgent(req.body);

    res.status(201).json({
      success: true,
      data: agent,
    });
  } catch (error) {
    next(error);
  }
};

const getAgents = async (req, res, next) => {
  try {
    const tenantId = req.query.tenantId || req.params.tenantId;

    if (!tenantId) {
      const error = new Error("tenantId is required");
      error.status = 400;
      throw error;
    }

    const agents = await agentService.getAgentsByTenant(tenantId);

    res.status(200).json({
      success: true,
      count: agents.length,
      data: agents,
    });
  } catch (error) {
    next(error);
  }
};

const getAgentById = async (req, res, next) => {
  try {
    const { tenantId, agentId } = req.params;

    const agent = await agentService.getAgentById(tenantId, agentId);

    res.status(200).json({
      success: true,
      data: agent,
    });
  } catch (error) {
    next(error);
  }
};

export default { createAgent, getAgents, getAgentById };