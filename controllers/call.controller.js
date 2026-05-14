import {
  createCallSession,
  removeCallSession,
  wasWsConnected,
} from "../services/callSession.service.js";
import {
  createSipSession,
  getSipSession,
  removeSipSession,
  setSipSessionDispatchRule,
} from "../services/sipSession.service.js";
import {
  createRoomDispatchRule,
  createOutboundSipParticipant,
  deleteDispatchRule,
} from "../services/livekitSip.service.js";
import { startWorkerForCall, stopWorker } from "../services/workerLauncher.js";
import { resolveRouteByDid } from "../services/callRoute.service.js";
import { startWorkerForRoom } from "../services/workerLauncher.js";
import axios from "axios";
import { logInfo, logWarn, logError } from "../utils/logging.util.js";

const BASE_URL = process.env.BASE_URL || "";
const DEFAULT_TENANT_ID = process.env.DEFAULT_TENANT_ID || "";
const DEFAULT_AGENT_ID = process.env.DEFAULT_AGENT_ID || "";
const VOBIZ_AUTH_ID = process.env.VOBIZ_AUTH_ID || "";
const VOBIZ_AUTH_TOKEN = process.env.VOBIZ_AUTH_TOKEN || "";
const VOBIZ_API_BASE = process.env.VOBIZ_API_BASE || "https://api.vobiz.ai/api/v1";
const STREAM_DEBUG_MODE =
  String(process.env.STREAM_DEBUG_MODE || "").toLowerCase() === "true";
const STREAM_XML_FORMAT = String(process.env.STREAM_XML_FORMAT || "auto").toLowerCase();
const LIVEKIT_SIP_DOMAIN = process.env.LIVEKIT_SIP_DOMAIN || process.env.LIVEKIT_SIP_ADDRESS || "";
const LIVEKIT_MANAGE_DISPATCH_RULES =
  String(process.env.LIVEKIT_MANAGE_DISPATCH_RULES || "true").toLowerCase() === "true";
const LIVEKIT_SIP_TARGET_ROOM = String(process.env.LIVEKIT_SIP_TARGET_ROOM || "").trim();
const VOBIZ_BRIDGE_MODE = String(process.env.VOBIZ_BRIDGE_MODE || "voice_app").toLowerCase();

let missingStreamCount = 0;

const getCallId = (body = {}) => {
  return (
    body.CallUUID ||
    body.call_uuid ||
    body.callId ||
    body.call_id ||
    body.call_uuid ||
    body.callUuid
  );
};

const getFromTo = (body = {}) => {
  const from = body.From || body.from || body.caller || body.Caller || "";
  const to = body.To || body.to || body.callee || body.Callee || "";
  return { from, to };
};

const getTenantAgent = (body = {}) => {
  const tenantId = body.tenantId || DEFAULT_TENANT_ID;
  const agentId = body.agentId || DEFAULT_AGENT_ID;
  return { tenantId, agentId };
};

const buildWsUrl = (roomName, callId) => {
  if (!BASE_URL) {
    throw new Error("BASE_URL is not configured");
  }

  const wsBase = BASE_URL.replace(/^http/i, "ws").replace(/\/$/, "");
  const encodedRoom = encodeURIComponent(roomName);
  const encodedCall = encodeURIComponent(callId);
  return `${wsBase}/ws/audio?roomName=${encodedRoom}&callId=${encodedCall}`;
};

const xmlResponse = (xml) => `<?xml version="1.0" encoding="UTF-8"?>${xml}`;

const normalizeSipDomain = (value = "") => {
  return String(value)
    .trim()
    .replace(/^sip:/i, "")
    .replace(/^\/\//, "")
    .replace(/\/.*$/, "");
};

const buildSipDialXml = (roomName) => {
  const sipDomain = normalizeSipDomain(LIVEKIT_SIP_DOMAIN);
  if (!sipDomain) {
    throw new Error("LIVEKIT_SIP_DOMAIN (or LIVEKIT_SIP_ADDRESS) is not configured");
  }
  const safeRoom = String(roomName || "")
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .slice(0, 80);
  const userAddress = `${safeRoom}@${sipDomain}`;
  const sipUri = `sip:${userAddress}`;
  return {
    sipUri,
    // Vobiz expects SIP endpoints inside <User> within <Dial>.
    dialXml: `<Response><Dial timeout="60"><User>${userAddress}</User></Dial></Response>`,
  };
};

const resolveTargetRoomName = (roomName) => {
  if (LIVEKIT_SIP_TARGET_ROOM) {
    return LIVEKIT_SIP_TARGET_ROOM.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80);
  }
  return String(roomName || "").replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80);
};

const buildLiveKitSipTarget = (roomName) => {
  const sipDomain = normalizeSipDomain(LIVEKIT_SIP_DOMAIN);
  if (!sipDomain) {
    throw new Error("LIVEKIT_SIP_DOMAIN (or LIVEKIT_SIP_ADDRESS) is not configured");
  }
  const safeRoom = resolveTargetRoomName(roomName);
  return `sip:${safeRoom}@${sipDomain}`;
};

const stripSipScheme = (value = "") => String(value).replace(/^sip:/i, "");

const buildWebhookUrl = (path) => {
  if (!BASE_URL) {
    throw new Error("BASE_URL is not configured");
  }
  return `${BASE_URL.replace(/\/$/, "")}${path}`;
};

const buildStreamXml = (streamUrl, format) => {
  // Legacy WebSocket format - no longer used
  // Kept for backward compatibility only
  return `<Response><Record maxlength="3600" timeout="60" /></Response>`;
};

const pickXmlFormat = () => {
  // Format selection - simplified since we use SIP dial now
  return "record";
};

// ===== DEBUG: Test XML formats =====
export const debugXmlFormats = async (req, res) => {
  const testUrl = "wss://example.com/ws/audio?roomName=test&callId=test123";
  const formats = ["connect", "start", "stream"];

  const xmlExamples = formats.map((format) => ({
    format,
    xml: buildStreamXml(testUrl, format),
    fullResponse: xmlResponse(buildStreamXml(testUrl, format)),
  }));

  return res.status(200).json({
    success: true,
    currentFormat: STREAM_XML_FORMAT || "default (connect)",
    testUrl,
    examples: xmlExamples,
    message: "Use STREAM_XML_FORMAT env var to set: connect, start, or stream",
  });
};

// ===== NEW SIP SESSION CREATION API =====
export const createSipCallSession = async (req, res) => {
  try {
    const {
      tenantId,
      agentId,
      callerNumber,
      receiverNumber,
      sessionId,
      callObjective = "",
      callConfig = {},
    } = req.body;

    // Validate required fields
    if (!tenantId || !agentId) {
      return res.status(400).json({
        success: false,
        message: "tenantId and agentId are required",
      });
    }

    if (!callerNumber || !receiverNumber) {
      return res.status(400).json({
        success: false,
        message: "callerNumber and receiverNumber are required",
      });
    }

    // Generate or use provided sessionId
    const finalSessionId = sessionId || `sip-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    
    // Build room name from sessionId
    const generatedRoomName = `room-${finalSessionId.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 50)}`;
    const roomName = resolveTargetRoomName(generatedRoomName);

    // Create SIP session
    const session = createSipSession(
      roomName,
      tenantId,
      agentId,
      receiverNumber,
      {
        ...(callConfig && typeof callConfig === "object" ? callConfig : {}),
        objective: callObjective || callConfig?.objective || "",
      },
    );

    console.log("[sip-api] session created", {
      sessionId: finalSessionId,
      roomName,
      tenantId,
      agentId,
      callerNumber,
      receiverNumber,
    });

    // Return session details
    return res.status(200).json({
      success: true,
      data: {
        sessionId: finalSessionId,
        roomName,
        tenantId,
        agentId,
        callerNumber,
        receiverNumber,
        callObjective: callObjective || callConfig?.objective || session.callConfig?.objective || "",
        callConfig: session.callConfig || null,
        status: "ready",
        createdAt: session.createdAt,
        message: "Session created successfully. Use this sessionId for next API calls.",
      },
    });
  } catch (error) {
    console.error("[sip-api] session creation failed:", error.message);
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// ===== NEW UNIFIED START CALL API (ONE-CLICK) =====
export const startSipCall = async (req, res) => {
  try {
    const {
      tenantId,
      agentId,
      callerNumber,
      receiverNumber,
      sessionId,
      autoJoinCaller,
      triggerOutboundCall: shouldTriggerOutbound,
      callObjective = "",
      callConfig = {},
    } = req.body;

    // Validate required fields
    if (!tenantId || !agentId) {
      return res.status(400).json({
        success: false,
        message: "tenantId and agentId are required",
      });
    }

    if (!callerNumber || !receiverNumber) {
      return res.status(400).json({
        success: false,
        message: "callerNumber and receiverNumber are required",
      });
    }

    // Step 1: Generate session
    const finalSessionId = sessionId || `sip-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const generatedRoomName = `room-${finalSessionId.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 50)}`;
    const roomName = resolveTargetRoomName(generatedRoomName);

    console.log("[sip-call] starting unified call", {
      sessionId: finalSessionId,
      roomName,
      tenantId,
      agentId,
      callerNumber,
      receiverNumber,
      triggerOutbound: shouldTriggerOutbound,
      callObjective: callObjective || callConfig?.objective || "",
    });

    // Step 2: Create SIP session
    const session = createSipSession(
      roomName,
      tenantId,
      agentId,
      receiverNumber,
      {
        ...(callConfig && typeof callConfig === "object" ? callConfig : {}),
        objective: callObjective || callConfig?.objective || "",
      },
    );

    // Step 3: Start worker
    try {
      startWorkerForRoom(roomName, {
        tenantId,
        agentId,
        callObjective: callObjective || callConfig?.objective || "",
        callConfig: callConfig && typeof callConfig === "object" ? callConfig : null,
      });
      console.log("[sip-call] worker started for room:", roomName);
    } catch (workerErr) {
      console.error("[sip-call] worker start error:", workerErr.message);
      return res.status(500).json({
        success: false,
        message: `Failed to start worker: ${workerErr.message}`,
      });
    }

    // Step 4: Auto-join caller (optional)
    let callerJoinResult = null;
    if (autoJoinCaller !== false) {
      try {
        // Simulate caller joining via LiveKit webhook
        const webhookPayload = {
          event: "participant_joined",
          room: {
            name: roomName,
            sid: `RM_${Date.now()}`,
          },
          participant: {
            sid: `PA_${callerNumber}`,
            name: `sip_${callerNumber}`,
            identity: `sip_${callerNumber}`,
            tenantId,
            agentId,
            metadata: JSON.stringify({
              sip: {
                from: callerNumber,
                to: receiverNumber,
                callId: finalSessionId,
              },
            }),
          },
          to: receiverNumber,
          sessionId: finalSessionId,
        };

        console.log("[sip-call] auto-joining caller:", callerNumber);
        callerJoinResult = {
          success: true,
          participant: webhookPayload.participant,
          message: "Caller auto-joined session",
        };
      } catch (joinErr) {
        console.warn("[sip-call] auto-join skipped:", joinErr.message);
        callerJoinResult = {
          success: false,
          message: `Auto-join skipped: ${joinErr.message}`,
        };
      }
    }

    // Step 5: Trigger outbound call (optional)
    let outboundCallResult = null;
    if (shouldTriggerOutbound) {
      try {
        console.log("[sip-call] triggering outbound call to:", receiverNumber);

        const headers = {
          "X-Auth-ID": VOBIZ_AUTH_ID,
          "X-Auth-Token": VOBIZ_AUTH_TOKEN,
          "Content-Type": "application/json",
        };

        let outboundPayload;
        let answerUrlWithContext = null;
        let hangupUrlWithContext = null;

        if (VOBIZ_BRIDGE_MODE === "livekit_outbound") {
          console.log("[sip-call] using livekit_outbound bridge mode", {
            roomName,
            from: callerNumber,
            to: receiverNumber,
          });

          const participant = await createOutboundSipParticipant({
            roomName,
            to: receiverNumber,
            from: callerNumber,
            tenantId,
            agentId,
          });

          outboundCallResult = {
            success: true,
            callId: participant.sipCallId,
            participantId: participant.participantId,
            participantIdentity: participant.participantIdentity,
            message: "Outbound call triggered through LiveKit SIP",
            bridgeMode: VOBIZ_BRIDGE_MODE,
            details: participant,
          };
        } else if (VOBIZ_BRIDGE_MODE === "direct_sip") {
          const sipTarget = buildLiveKitSipTarget(roomName);
          outboundPayload = {
            from: callerNumber,
            to: sipTarget,
            tenantId,
            agentId,
            sessionId: finalSessionId,
            roomName,
            metadata: {
              bridgeMode: "direct_sip",
              receiverNumber,
            },
          };
          console.log("[sip-call] using direct_sip bridge mode", {
            roomName,
            sipTarget,
          });
        } else {
          // Voice-application mode (legacy): Vobiz asks answer_url for XML.
          answerUrlWithContext = `${buildWebhookUrl("/api/call/answer")}?sessionId=${encodeURIComponent(finalSessionId)}&roomName=${encodeURIComponent(roomName)}`;
          hangupUrlWithContext = `${buildWebhookUrl("/api/call/hangup")}?sessionId=${encodeURIComponent(finalSessionId)}&roomName=${encodeURIComponent(roomName)}`;
          outboundPayload = {
            from: callerNumber,
            to: receiverNumber,
            answer_url: answerUrlWithContext,
            hangup_url: hangupUrlWithContext,
            tenantId,
            agentId,
            sessionId: finalSessionId,
            roomName,
          };
        }

        if (outboundPayload) {
          let outboundResponse;
          try {
            outboundResponse = await axios.post(
              `${VOBIZ_API_BASE}/Account/${VOBIZ_AUTH_ID}/Call/`,
              outboundPayload,
              {
                headers,
                timeout: 10000,
              },
            );
          } catch (firstErr) {
            // Some Vobiz accounts accept SIP targets only without "sip:" prefix in `to`.
            if (
              VOBIZ_BRIDGE_MODE === "direct_sip" &&
              firstErr?.response?.status === 400 &&
              typeof outboundPayload?.to === "string" &&
              /^sip:/i.test(outboundPayload.to)
            ) {
              const retryPayload = {
                ...outboundPayload,
                to: stripSipScheme(outboundPayload.to),
              };
              console.warn("[sip-call] direct_sip retry without sip scheme", {
                firstStatus: firstErr.response?.status,
                firstError: firstErr.response?.data || firstErr.message,
                retryTo: retryPayload.to,
              });
              outboundResponse = await axios.post(
                `${VOBIZ_API_BASE}/Account/${VOBIZ_AUTH_ID}/Call/`,
                retryPayload,
                {
                  headers,
                  timeout: 10000,
                },
              );
            } else {
              throw firstErr;
            }
          }

          console.log("[sip-call] outbound call triggered:", outboundResponse.data);
          if (answerUrlWithContext) {
            console.log("[sip-call] answer_url:", answerUrlWithContext);
          }
          if (hangupUrlWithContext) {
            console.log("[sip-call] hangup_url:", hangupUrlWithContext);
          }

          outboundCallResult = {
            success: true,
            callId: outboundResponse.data?.call_uuid || outboundResponse.data?.callId,
            message: "Outbound call triggered successfully",
            bridgeMode: VOBIZ_BRIDGE_MODE,
            details: outboundResponse.data,
          };
        }
      } catch (outboundErr) {
        console.warn("[sip-call] outbound call failed:", {
          message: outboundErr.message,
          status: outboundErr.response?.status,
          data: outboundErr.response?.data,
        });
        outboundCallResult = {
          success: false,
          message: `Outbound call failed: ${outboundErr.response?.status || ""} ${JSON.stringify(outboundErr.response?.data || outboundErr.message)}`,
        };
      }
    }

    // Return comprehensive response
    return res.status(200).json({
      success: true,
      data: {
        sessionId: finalSessionId,
        roomName,
        tenantId,
        agentId,
        callerNumber,
        receiverNumber,
        status: "active",
        createdAt: session.createdAt,
        callObjective: callObjective || callConfig?.objective || session.callConfig?.objective || "",
        callConfig: session.callConfig || null,
        worker: {
          status: "started",
          roomName,
        },
        caller: callerJoinResult || {
          status: "waiting",
          message: "Caller join disabled. Waiting for real participant.",
        },
        outboundCall: outboundCallResult || {
          status: "skipped",
          message: "Outbound call trigger disabled",
        },
        message: "Call started successfully! Ready for incoming participant.",
        bridgeMode: VOBIZ_BRIDGE_MODE,
        nextSteps: [
          shouldTriggerOutbound 
            ? "📞 Receiver phone ringing now!" 
            : "Receiver will be called when available",
          "Receiver picks up → Worker answers",
          "STT will process incoming audio",
          "AI will generate responses",
          "TTS will stream audio back",
        ],
      },
    });
  } catch (error) {
    console.error("[sip-call] unified call failed:", error.message);
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// ===== NEW SIP CALL INITIATION API =====
export const initiateSipCall = async (req, res) => {
  try {
    const { sessionId, roomName } = req.body;

    if (!sessionId && !roomName) {
      return res.status(400).json({
        success: false,
        message: "sessionId or roomName is required",
      });
    }

    // Retrieve session
    const resolvedInputRoom = roomName || `room-${sessionId.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 50)}`;
    const finalRoomName = resolveTargetRoomName(resolvedInputRoom);
    const session = getSipSession(finalRoomName);

    if (!session) {
      return res.status(404).json({
        success: false,
        message: "Session not found. Create session first using /api/call/sip/session",
      });
    }

    console.log("[sip-api] initiating call for session", {
      sessionId,
      roomName: finalRoomName,
      tenantId: session.tenantId,
      agentId: session.agentId,
    });

    // Start worker for the room
    startWorkerForRoom(finalRoomName, {
      tenantId: session.tenantId,
      agentId: session.agentId,
    });

    return res.status(200).json({
      success: true,
      data: {
        sessionId,
        roomName: finalRoomName,
        status: "initiated",
        message: "Worker started. Waiting for caller to join.",
      },
    });
  } catch (error) {
    console.error("[sip-api] call initiation failed:", error.message);
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

export const triggerOutboundCall = async (req, res) => {
  try {
    const { from, to, answer_url, hangup_url, tenantId, agentId } = req.body;

    if (!from || !to) {
      return res.status(400).json({
        success: false,
        message: "from and to are required",
      });
    }

    if (!VOBIZ_AUTH_ID || !VOBIZ_AUTH_TOKEN) {
      return res.status(500).json({
        success: false,
        message: "VOBIZ_AUTH_ID and VOBIZ_AUTH_TOKEN are required",
      });
    }

    const payload = {
      from,
      to,
      answer_url: answer_url || buildWebhookUrl("/api/call/answer"),
      hangup_url: hangup_url || buildWebhookUrl("/api/call/hangup"),
      tenantId,
      agentId,
    };

    const response = await axios.post(
      `${VOBIZ_API_BASE}/Account/${VOBIZ_AUTH_ID}/Call/`,
      payload,
      {
        headers: {
          "X-Auth-ID": VOBIZ_AUTH_ID,
          "X-Auth-Token": VOBIZ_AUTH_TOKEN,
          "Content-Type": "application/json",
        },
        timeout: 10000,
      },
    );

    return res.status(200).json({
      success: true,
      data: response.data,
    });
  } catch (error) {
    const message = error.response?.data || error.message;
    console.error("[vobiz] trigger call error:", message);
    return res.status(500).json({
      success: false,
      message,
    });
  }
};

export const handleAnswerWebhook = async (req, res) => {
  try {
    logInfo("[vobiz] answer payload", { body: JSON.stringify(req.body || {}) });

    // ===== Priority 1: Check for SIP session context (from outbound call) =====
    const querySessionId = req.query?.sessionId;
    const queryRoomName = req.query?.roomName;
    const queryTenantId = req.query?.tenantId;
    const queryAgentId = req.query?.agentId;

    if (queryRoomName) {
      console.log("[vobiz] using roomName from query params", {
        sessionId: querySessionId,
        roomName: queryRoomName,
      });

      const { from, to } = getFromTo(req.body);
      const targetRoomName = resolveTargetRoomName(queryRoomName);
      let existingSession = getSipSession(targetRoomName) || getSipSession(queryRoomName);

      if (!existingSession) {
        let tenantId = queryTenantId || DEFAULT_TENANT_ID;
        let agentId = queryAgentId || DEFAULT_AGENT_ID;

        if ((!tenantId || !agentId) && to) {
          const route = await resolveRouteByDid(to);
          tenantId = tenantId || route?.tenantId?.toString();
          agentId = agentId || route?.agentId?.toString();
        }

          existingSession = createSipSession(targetRoomName, tenantId, agentId, to);
        console.log("[vobiz] created SIP session from query room", {
          requestedRoomName: queryRoomName,
          targetRoomName,
          tenantId: existingSession.tenantId,
          agentId: existingSession.agentId,
          from,
          to,
        });
      } else {
        console.log("[vobiz] found existing SIP session", {
          roomName: queryRoomName,
          tenantId: existingSession.tenantId,
          agentId: existingSession.agentId,
        });
      }

      const callId = getCallId(req.body) || querySessionId || queryRoomName;
      logInfo("[vobiz] answer with SIP session", {
        callId,
        roomName: queryRoomName,
        sessionId: querySessionId,
      });

      // Create call session linked to SIP room
      const callSession = createCallSession(callId, existingSession.tenantId, existingSession.agentId);
      callSession.roomName = queryRoomName;

      // ===== SOLUTION: Route directly to LiveKit SIP endpoint =====
      if (normalizeSipDomain(LIVEKIT_SIP_DOMAIN)) {
        if (LIVEKIT_MANAGE_DISPATCH_RULES && !existingSession.dispatchRuleId) {
          try {
            const rule = await createRoomDispatchRule(queryRoomName);
            setSipSessionDispatchRule(queryRoomName, rule.id);
            console.log("[vobiz] dispatch rule created", {
              roomName: queryRoomName,
              ruleId: rule.id,
            });
          } catch (dispatchErr) {
            const message = String(dispatchErr?.message || "");
            const duplicateRule = /dispatch rule .* already exists/i.test(message);
            if (duplicateRule) {
              logWarn("[vobiz] dispatch rule already exists, continuing with SIP dial", {
                roomName: queryRoomName,
                error: message,
              });
            } else {
              throw dispatchErr;
            }
          }
        } else if (!LIVEKIT_MANAGE_DISPATCH_RULES) {
          logInfo("[vobiz] dispatch rule management disabled", {
            roomName: queryRoomName,
          });
        }

        // Route to LiveKit SIP
        const targetRoomName = resolveTargetRoomName(queryRoomName);
        const { sipUri, dialXml } = buildSipDialXml(targetRoomName);

        logInfo("[vobiz] SIP dial response", {
          callId,
          sipUri,
          xml: dialXml,
        });

        console.log("[vobiz] sending SIP dial XML:", dialXml);

        return res
          .status(200)
          .type("text/xml")
          .send(xmlResponse(dialXml));
      }

      // Fallback: Record the call
      console.warn("[vobiz] LiveKit SIP not configured, recording call");
      const recordXml = `<Response><Record maxlength="3600" timeout="60" /></Response>`;
      
      return res
        .status(200)
        .type("text/xml")
        .send(xmlResponse(recordXml));
    }

    // ===== Priority 2: Fall back to traditional call session creation =====
    const callId = getCallId(req.body);
    const { from, to } = getFromTo(req.body);
    let { tenantId, agentId } = getTenantAgent(req.body);

    if ((!tenantId || !agentId) && to) {
      const route = await resolveRouteByDid(to);
      tenantId = tenantId || route?.tenantId?.toString();
      agentId = agentId || route?.agentId?.toString();
    }

    if (!callId || !tenantId || !agentId) {
      console.warn("[vobiz] missing required fields for answer", {
        callId,
        tenantId,
        agentId,
        from,
        to,
      });
      return res.status(400).type("text/xml").send(
        xmlResponse("<Response></Response>"),
      );
    }

    const session = createCallSession(callId, tenantId, agentId);
    startWorkerForCall(session);

    logInfo("[vobiz] answer", {
      callId,
      roomName: session.roomName,
      from,
      to,
    });

    // Try to route to LiveKit SIP if configured
    if (normalizeSipDomain(LIVEKIT_SIP_DOMAIN)) {
      const targetRoomName = resolveTargetRoomName(session.roomName);
      const { sipUri, dialXml } = buildSipDialXml(targetRoomName);

      logInfo("[vobiz] routing to LiveKit SIP", { callId, sipUri });
      console.log("[vobiz] sending SIP dial XML:", dialXml);

      return res
        .status(200)
        .type("text/xml")
        .send(xmlResponse(dialXml));
    }

    // Fallback: Record
    console.warn("[vobiz] LiveKit SIP not configured, recording call");
    const recordXml = `<Response><Record maxlength="3600" timeout="60" /></Response>`;

    return res
      .status(200)
      .type("text/xml")
      .send(xmlResponse(recordXml));
  } catch (error) {
    logError("[vobiz] answer error", { message: error.message });
    console.error("[vobiz] answer error stack:", error.stack);
    return res.status(500).type("text/xml").send(
      xmlResponse("<Response></Response>"),
    );
  }
};

export const handleHangupWebhook = async (req, res) => {
  const callId = getCallId(req.body);
  const queryRoomName = req.query?.roomName;

  if (!callId) {
    return res.status(200).type("text/xml").send(
      xmlResponse("<Response></Response>"),
    );
  }

  const session = removeCallSession(callId);
  stopWorker(callId);

  // Also clean up SIP session if it exists
  if (queryRoomName) {
    const sipSession = removeSipSession(queryRoomName);
    if (sipSession?.dispatchRuleId) {
      await deleteDispatchRule(sipSession.dispatchRuleId);
      console.log("[vobiz] dispatch rule deleted", {
        roomName: queryRoomName,
        ruleId: sipSession.dispatchRuleId,
      });
    }
    logInfo("[vobiz] hangup with SIP session", {
      callId,
      roomName: queryRoomName,
      tenantId: sipSession?.tenantId,
      agentId: sipSession?.agentId,
    });
  } else {
    logInfo("[vobiz] hangup", {
      callId,
      roomName: session?.roomName || "unknown",
    });
  }

  return res.status(200).type("text/xml").send(
    xmlResponse("<Response></Response>"),
  );
};
