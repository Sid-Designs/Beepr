import axios from "axios";

const AI_QUERY_URL = "http://localhost:5000/api/ai/query";

export const queryAI = async ({ tenantId, agentId, query }) => {
  const payload = {
    tenantId,
    agentId,
    query,
  };

  const response = await axios.post(AI_QUERY_URL, payload, {
    headers: {
      "Content-Type": "application/json",
    },
  });

  return response.data;
};
