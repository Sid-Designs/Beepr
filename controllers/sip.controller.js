import { resolveRouteByDid } from "../services/callRoute.service.js";
import {
  createSipSession,
  getSipSession,
  removeSipSession,
} from "../services/sipSession.service.js";
import { startWorkerForRoom, stopWorkerByRoom } from "../services/workerLauncher.js";
import { deleteDispatchRule } from "../services/livekitSip.service.js";
import { WebhookReceiver } from "livekit-server-sdk";

const DEFAULT_TENANT_ID = process.env.DEFAULT_TENANT_ID || "";
const DEFAULT_AGENT_ID = process.env.DEFAULT_AGENT_ID || "";
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || "";
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || "";
const DEBUG_SIP_WEBHOOK =
  String(process.env.DEBUG_SIP_WEBHOOK || "").toLowerCase() === "true";
const activeRooms = new Set();
const processedEvents = new Set();
const SIP_EVENTS_OF_INTEREST = new Set([
  "room_started",
  "participant_joined",
  "participant_left",
  "room_finished",
]);

const receiver = LIVEKIT_API_KEY && LIVEKIT_API_SECRET
  ? new WebhookReceiver(LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
  : null;

const normalizeNumber = (value) => {
  if (!value) return "";
  return String(value).replace(/\+/g, "").trim();
};

const extractRoomName = (payload = {}) => {
  return payload.room?.name || payload.roomName || payload.room?.roomName || "";
};

const parseSipMetadata = (participant) => {
  let sipData = {};

  try {
    const meta = participant?.metadata || "{}";
    const parsed = typeof meta === "string" ? JSON.parse(meta) : meta;
    sipData = parsed?.sip || {};
  } catch {
    console.warn("[sip] metadata parse failed");
  }

  return sipData;
};

const extractCallId = (payload = {}, sipData = {}) => {
  return (
    sipData.callId ||
    payload.callId ||
    payload.call_id ||
    payload.room?.name ||
    ""
  );
};

const extractFromTo = (payload = {}, participant = {}, sipData = {}) => {
  const from =
    sipData.from ||
    participant.name ||
    participant.identity?.replace(/^sip_/, "") ||
    "unknown";

  const to = sipData.to || payload?.to || "unknown";

  return { from, to };
};

const mapTenant = async (toNumber) => {
  const did = normalizeNumber(toNumber);
  const route = did ? await resolveRouteByDid(did) : null;

  return {
    tenantId: route?.tenantId?.toString() || DEFAULT_TENANT_ID,
    agentId: route?.agentId?.toString() || DEFAULT_AGENT_ID,
  };
};

const logSipEvent = (eventType, roomName, participantSid, extra = {}) => {
  const level = SIP_EVENTS_OF_INTEREST.has(eventType) ? "log" : "warn";
  console[level]("[sip] event", {
    eventType,
    roomName,
    participantSid,
    ...extra,
  });
};

const debugSip = (...args) => {
  if (DEBUG_SIP_WEBHOOK) {
    console.log(...args);
  }
};

const logProviderCallEvent = (payload = {}) => {
  const eventName = payload.Event || payload.eventName;
  if (!eventName) return false;

  if (eventName === "CallInitiated") {
    console.log("[vobiz] call initiated", {
      from: payload.From,
      to: payload.To,
      status: payload.Status,
      allowed: payload.Allowed,
      sipCallId: payload.SIPCallID,
    });
    return true;
  }

  if (eventName === "Hangup") {
    console.log("[vobiz] call ended", {
      from: payload.From,
      to: payload.To,
      status: payload.Status,
      reason: payload.Reason,
      duration: payload.Duration,
      billsec: payload.Billsec,
      hangupSource: payload.HangupSource,
    });
    return true;
  }

  debugSip("[vobiz] event", {
    event: eventName,
    from: payload.From,
    to: payload.To,
    status: payload.Status,
  });
  return true;
};

export const handleLiveKitSipWebhook = async (req, res) => {
  try {
    const contentType = req.headers?.["content-type"] || "";
    const authHeader = req.headers?.authorization || "";
    const bodyLength =
      typeof req.body === "string"
        ? req.body.length
        : (req.body instanceof Buffer ? req.body.length : 0);

    debugSip("[sip] webhook hit", {
      contentType,
      hasAuthHeader: Boolean(authHeader),
      bodyLength,
      timestamp: new Date().toISOString(),
    });

    // ===== STEP 1: Extract raw body (Buffer or String) =====
    const rawBody = typeof req.body === "string"
      ? req.body
      : (req.body instanceof Buffer
          ? req.body.toString("utf-8")
          : JSON.stringify(req.body || {}));

    const rawBodyBuffer = req.body instanceof Buffer
      ? req.body
      : Buffer.from(rawBody, "utf-8");

    debugSip("[sip] raw body received:", rawBody.substring(0, 200));

    // ===== STEP 2: Parse raw body to JSON =====
    let parsedBody;
    try {
      parsedBody = JSON.parse(rawBody);
    } catch (parseErr) {
      console.error("[sip] JSON parse failed:", parseErr.message);
      console.error("[sip] raw body was:", rawBody);
      return res.status(400).send("Invalid JSON");
    }

    debugSip("[sip] parsed body:", JSON.stringify(parsedBody, null, 2));

    if (parsedBody?.Event && logProviderCallEvent(parsedBody)) {
      return res.status(200).send("OK");
    }

    // ===== STEP 3: Signature verification (with safe fallback) =====
    let event;

    try {
      if (authHeader && receiver) {
        debugSip("[sip] verifying signature with auth header...");
        event = await receiver.receive(rawBodyBuffer, authHeader);
        debugSip("[sip] signature verified");
      } else {
        if (!authHeader) {
          console.warn("[sip] no auth header - using raw payload (unverified)");
        }
        if (!receiver) {
          console.warn("[sip] WebhookReceiver not initialized - using raw payload");
        }
        event = parsedBody;
      }
    } catch (verifyErr) {
      console.error("[sip] verification failed:", verifyErr.message);
      console.warn("[sip] falling back to unverified payload");
      event = parsedBody;
    }

    if (!event || Object.keys(event).length === 0) {
      console.warn("[sip] empty verified payload, using parsed body");
      event = parsedBody;
    }

    // ===== STEP 4: Extract event data =====
    debugSip("[sip] webhook received:", JSON.stringify(event, null, 2));
    const eventType = event.event || event.eventType || event.type || "";
    const roomName = extractRoomName(event);
    const participant = event.participant || {};
    const participantSid = participant.sid || "na";

    if (!eventType && !roomName && logProviderCallEvent(event)) {
      return res.status(200).send("OK");
    }

    if (SIP_EVENTS_OF_INTEREST.has(eventType)) {
      logSipEvent(eventType, roomName, participantSid);
    } else {
      debugSip("[sip] event", { eventType, roomName, participantSid });
    }

    debugSip("[sip] RAW PARTICIPANT:", participant);

    const eventKey = `${eventType}:${roomName}:${participantSid}`;

    if (processedEvents.has(eventKey)) {
      debugSip("[sip] duplicate event skipped", {
        eventType,
        roomName,
        participantSid,
      });
      return res.status(200).send("OK");
    }

    processedEvents.add(eventKey);

    if (!eventType || !roomName) {
      debugSip("[sip] skipping event - missing eventType or roomName", {
        eventType,
        roomName,
      });
      return res.status(200).send("OK");
    }

    // ===== STEP 5: Handle room_started event =====
    if (eventType === "room_started") {
      debugSip("[sip] room_started", { eventType, roomName, participantSid });
      return res.status(200).send("OK");
    }

    // ===== STEP 6: Handle participant_joined event =====
    if (eventType === "participant_joined") {
      if (activeRooms.has(roomName) || getSipSession(roomName)) {
        debugSip("[sip] worker already started", {
          roomName,
          participantSid,
        });
        return res.status(200).send("OK");
      }

      activeRooms.add(roomName);

      const sipData = parseSipMetadata(participant);
      const { from, to } = extractFromTo(event, participant, sipData);
      const callId = extractCallId(event, sipData);

      const fromNorm = normalizeNumber(from);
      const toNorm = normalizeNumber(to);

      // ===== PRIORITY 1: Use tenantId/agentId from participant if provided =====
      let tenantId = participant.tenantId;
      let agentId = participant.agentId;

      // ===== PRIORITY 2: Check if sessionId provided (for API-created sessions) =====
      if (!tenantId || !agentId) {
        const sessionId = event.sessionId || participant.sessionId;
        if (sessionId) {
          const existingSession = getSipSession(roomName);
          if (existingSession) {
            tenantId = existingSession.tenantId;
            agentId = existingSession.agentId;
            console.log("[sip] using existing session context", {
              sessionId,
              roomName,
              tenantId,
              agentId,
            });
          }
        }
      }

      // ===== PRIORITY 3: Fall back to DID lookup if not in participant =====
      if (!tenantId || !agentId) {
        const mapped = await mapTenant(toNorm);
        tenantId = mapped.tenantId;
        agentId = mapped.agentId;
      }

      if (!tenantId || !agentId) {
        console.warn("[sip] no tenant mapping", { roomName, to: toNorm, participantData: participant });
        return res.status(200).send("OK");
      }

      console.log("[sip] participant joined", {
        eventType,
        from: fromNorm,
        to: toNorm,
        callId,
        roomName,
        participantSid,
      });

      createSipSession(roomName, tenantId, agentId, toNorm);
      startWorkerForRoom(roomName, { tenantId, agentId });

      console.log("[sip] worker started", {
        roomName,
        tenantId,
        agentId,
        did: toNorm,
        participantSid,
      });

      return res.status(200).send("OK");
    }

    // ===== STEP 7: Handle room_finished/participant_left events =====
    if (eventType === "room_finished" || eventType === "participant_left") {
      const session = removeSipSession(roomName);
      stopWorkerByRoom(roomName);
      activeRooms.delete(roomName);

      if (session?.dispatchRuleId) {
        try {
          await deleteDispatchRule(session.dispatchRuleId);
        } catch (error) {
          console.warn("[sip] dispatch rule delete failed:", error.message);
        }
      }

      console.log("[sip] room ended", {
        roomName,
        eventType,
        tenantId: session?.tenantId,
        agentId: session?.agentId,
        participantSid,
      });

      return res.status(200).send("OK");
    }

    // ===== STEP 8: Unhandled event type =====
    debugSip("[sip] unhandled event type:", {
      eventType,
      roomName,
      participantSid,
    });
    return res.status(200).send("OK");
  } catch (error) {
    console.error("[sip] webhook error:", error.message);
    console.error("[sip] stack trace:", error.stack);
    // Always return 200 OK to acknowledge receipt (LiveKit will retry on non-200)
    return res.status(200).send("OK");
  }
};
