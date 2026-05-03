import { generateLiveKitToken } from "../utils/livekit.util.js";
import { sendResponse } from "../utils/response.utils.js";
import { startLiveKitWorker } from "../services/livekit.worker.js";

export const getLiveKitToken = async (req, res) => {
  try {
    const { roomName, identity } = req.query;

    if (!roomName || !identity) {
      return res.status(400).json({
        success: false,
        message: "roomName and identity are required",
      });
    }

    const token = await generateLiveKitToken(roomName, identity);

    return sendResponse(res, 200, "LiveKit token generated", {
      token,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

export const startWorker = async (req, res) => {
  try {
    const { roomName, tenantId, agentId } = req.body;

    if (!roomName || !tenantId || !agentId) {
      return res.status(400).json({
        success: false,
        message: "roomName, tenantId, and agentId are required",
      });
    }

    await startLiveKitWorker(roomName, { tenantId, agentId });

    return sendResponse(res, 200, "LiveKit worker started", {
      roomName,
      tenantId,
      agentId,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};
