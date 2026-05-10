import { generateLiveKitToken } from "../utils/livekit.util.js";
import { sendResponse } from "../utils/response.utils.js";
import { startLiveKitWorker } from "../services/livekit.worker.js";
import { AccessToken, WebhookReceiver } from "livekit-server-sdk";
import axios from "axios";

export const getLiveKitToken = async (req, res) => {
  try {
    const roomName = req.query?.roomName || req.body?.roomName;
    const identity = req.query?.identity || req.body?.identity;
    const wsUrl = process.env.LIVEKIT_URL || "";

    if (!roomName || !identity) {
      return res.status(400).json({
        success: false,
        message: "roomName and identity are required",
      });
    }

    const token = await generateLiveKitToken(roomName, identity);

    return sendResponse(res, 200, "LiveKit token generated", {
      token,
      wsUrl,
      roomName,
      identity,
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

    const room = await startLiveKitWorker(roomName, { tenantId, agentId });

    return sendResponse(res, 200, "LiveKit worker started", {
      roomName,
      tenantId,
      agentId,
      connected: Boolean(room),
      wsUrl: process.env.LIVEKIT_URL || "",
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

/**
 * Diagnostic endpoint to check LiveKit SIP configuration
 * GET /api/livekit/sip/diagnostic
 */
export const checkSipDiagnostic = async (req, res) => {
  try {
    const lkUrl = process.env.LIVEKIT_URL || "";
    const apiKey = process.env.LIVEKIT_API_KEY || "";
    const apiSecret = process.env.LIVEKIT_API_SECRET || "";
    const sipAddress = process.env.LIVEKIT_SIP_ADDRESS || "";
    const sipDomain = process.env.LIVEKIT_SIP_DOMAIN || "";
    const configuredCodecs = String(process.env.SIP_ALLOWED_CODECS || "PCMU,PCMA,opus")
      .split(",")
      .map((codec) => codec.trim().toUpperCase())
      .filter(Boolean);

    console.log("[diagnostic] checking LiveKit SIP configuration...");

    const diagnostic = {
      timestamp: new Date().toISOString(),
      configuration: {
        liveKitUrl: lkUrl ? "✅ Set" : "❌ Missing",
        apiKey: apiKey ? "✅ Set" : "❌ Missing",
        apiSecret: apiSecret ? "✅ Set" : "❌ Missing",
        sipAddress: sipAddress ? `✅ ${sipAddress}` : "❌ Missing",
        sipDomain: sipDomain ? `✅ ${sipDomain}` : "⚠️ Optional (fallback to sipAddress)",
      },
      checks: {},
    };

    // Test 1: Can reach LiveKit server
    try {
      const checkUrl = lkUrl.replace("wss://", "https://").replace("ws://", "http://");
      const response = await axios.get(`${checkUrl}/status`, {
        timeout: 5000,
      });
      diagnostic.checks.liveKitReachable = {
        status: "✅ Reachable",
        response: response.status,
      };
    } catch (error) {
      diagnostic.checks.liveKitReachable = {
        status: "❌ Not reachable",
        error: error.message,
      };
    }

    // Test 2: Generate token
    try {
      const at = new AccessToken(apiKey, apiSecret, { identity: "diagnostic-bot" });
      at.addGrant({
        roomJoin: true,
        room: "diagnostic-room",
        canSubscribe: true,
        canPublish: true,
      });
      const token = at.toJwt();
      diagnostic.checks.tokenGeneration = {
        status: "✅ Token generated",
        length: token.length,
      };
    } catch (error) {
      diagnostic.checks.tokenGeneration = {
        status: "❌ Token generation failed",
        error: error.message,
      };
    }

    // Test 3: Verify SIP format
    const testRoomName = "diagnostic-room-123";
    const targetDomain = sipDomain || sipAddress;
    const sipUri = `sip:${testRoomName}@${targetDomain}`;
    diagnostic.checks.sipFormat = {
      status: targetDomain ? "✅ SIP URI format" : "❌ Missing SIP domain/address",
      example: sipUri,
      testUri: sipUri,
    };

    // Test 4: Basic codec compatibility expectation
    const requiredCodecs = ["PCMU", "PCMA", "OPUS"];
    const missingCodecs = requiredCodecs.filter(
      (codec) => !configuredCodecs.includes(codec),
    );
    diagnostic.checks.codecCompatibility = {
      status: missingCodecs.length
        ? "⚠️ Partial codec coverage"
        : "✅ PCMU/PCMA/OPUS compatible",
      configuredCodecs,
      requiredCodecs,
      missingCodecs,
    };

    // Summary
    const allConfigSet =
      lkUrl && apiKey && apiSecret && sipAddress;

    diagnostic.summary = {
      configurationComplete: allConfigSet ? "✅ YES - Ready for SIP calls" : "❌ NO - Missing configuration",
      nextSteps: allConfigSet
        ? [
            "1. LiveKit SIP inbound trunk should be configured in LiveKit Cloud Console",
            "2. SIP inbound endpoint should have inbound trunk enabled",
            "3. When VoIPBIZ dials the SIP URI, LiveKit should bridge to room",
            "4. Monitor room for '[livekit] participant joined' logs",
          ]
        : [
            "1. Set LIVEKIT_URL=wss://your-cloud.livekit.cloud",
            "2. Set LIVEKIT_API_KEY=your-api-key",
            "3. Set LIVEKIT_API_SECRET=your-api-secret",
            "4. Set LIVEKIT_SIP_ADDRESS=sip.livekit.cloud (or your custom SIP address)",
          ],
    };

    console.log("[diagnostic] configuration check complete", diagnostic);

    return res.status(200).json({
      success: true,
      message: "LiveKit SIP diagnostic complete",
      diagnostic,
    });
  } catch (error) {
    console.error("[diagnostic] error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Diagnostic check failed",
      error: error.message,
    });
  }
};

/**
 * Check room status and participants
 * GET /api/livekit/room/status/:roomName
 */
export const checkRoomStatus = async (req, res) => {
  try {
    const { roomName } = req.params;

    if (!roomName) {
      return res.status(400).json({
        success: false,
        message: "roomName is required",
      });
    }

    const { RoomServiceClient } = await import("livekit-server-sdk");
    
    const lkUrl = process.env.LIVEKIT_URL || "";
    const apiKey = process.env.LIVEKIT_API_KEY || "";
    const apiSecret = process.env.LIVEKIT_API_SECRET || "";

    const host = lkUrl.replace("wss://", "").replace("ws://", "");
    const roomService = new RoomServiceClient(host, apiKey, apiSecret);

    try {
      const room = await roomService.listRooms();
      const foundRoom = room.find((r) => r.name === roomName);

      if (!foundRoom) {
        return res.status(404).json({
          success: false,
          message: `Room "${roomName}" not found`,
          info: {
            availableRooms: room.map((r) => ({
              name: r.name,
              numParticipants: r.numParticipants,
              creationTime: r.creationTime,
            })),
          },
        });
      }

      const participants = await roomService.listParticipants(roomName);

      return res.status(200).json({
        success: true,
        message: "Room status retrieved",
        room: {
          name: foundRoom.name,
          numParticipants: foundRoom.numParticipants,
          creationTime: foundRoom.creationTime,
          maxParticipants: foundRoom.maxParticipants,
          emptyTimeout: foundRoom.emptyTimeout,
        },
        participants: participants.map((p) => ({
          identity: p.identity,
          sid: p.sid,
          state: p.state,
          audioTracks: p.tracks.filter((t) => t.type === 1).length,
          videoTracks: p.tracks.filter((t) => t.type === 0).length,
          tracks: p.tracks.map((t) => ({
            sid: t.sid,
            type: t.type === 0 ? "video" : "audio",
            name: t.name,
            muted: t.muted,
          })),
        })),
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        message: "Failed to fetch room status",
        error: error.message,
      });
    }
  } catch (error) {
    console.error("[room-status] error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Room status check failed",
      error: error.message,
    });
  }
};
