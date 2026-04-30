import { sendResponse } from "../utils/response.utils.js";

export const getHealthStatus = (req, res) => {
  return sendResponse(res, 200, "API is healthy", {
    timestamp: new Date(),
  });
};