import "../config/env.js";
import { SipClient } from "livekit-server-sdk";

const LIVEKIT_URL = process.env.LIVEKIT_URL || "";
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || "";
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || "";

const getLiveKitHost = () =>
  LIVEKIT_URL.replace(/^wss:\/\//i, "https://").replace(/^ws:\/\//i, "http://");

const parseTrunkIds = () => {
  const value =
    process.env.LIVEKIT_SIP_TRUNK_IDS ||
    process.env.LIVEKIT_SIP_TRUNK ||
    "";

  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
};

const createSipClient = () => {
  const host = getLiveKitHost();

  if (!host || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
    throw new Error("LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET are required");
  }

  return new SipClient(host, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
};

export const createRoomDispatchRule = async (roomName) => {
  const sipClient = createSipClient();
  const trunkIds = parseTrunkIds();

  const rule = await sipClient.createSipDispatchRule(
    {
      type: "direct",
      roomName,
    },
    {
      name: `vobiz-${roomName}`,
      metadata: JSON.stringify({
        source: "vobiz",
        roomName,
        createdAt: new Date().toISOString(),
      }),
      ...(trunkIds.length ? { trunkIds } : {}),
    },
  );

  return {
    id: rule.sipDispatchRuleId,
    name: rule.name,
  };
};

const normalizePhoneNumber = (value) => {
  const number = String(value || "").trim();
  if (!number || number.startsWith("+") || number.startsWith("sip:")) {
    return number;
  }

  return `+${number.replace(/[^\d]/g, "")}`;
};

export const createOutboundSipParticipant = async ({
  roomName,
  to,
  from,
  tenantId,
  agentId,
}) => {
  const trunkId = process.env.LIVEKIT_OUTBOUND_TRUNK_ID || "";
  if (!trunkId) {
    throw new Error("LIVEKIT_OUTBOUND_TRUNK_ID is required for LiveKit outbound calls");
  }

  const sipClient = createSipClient();
  const destination = normalizePhoneNumber(to);
  const fromNumber = normalizePhoneNumber(from);

  const participant = await sipClient.createSipParticipant(
    trunkId,
    destination,
    roomName,
    {
      fromNumber: fromNumber || undefined,
      participantIdentity: `sip-${destination.replace(/[^\dA-Za-z_-]/g, "-")}`,
      participantName: destination,
      participantMetadata: JSON.stringify({
        source: "vobiz",
        direction: "outbound",
        tenantId,
        agentId,
      }),
      playDialtone: true,
      waitUntilAnswered: false,
    },
  );

  return {
    participantId: participant.participantId,
    participantIdentity: participant.participantIdentity,
    sipCallId: participant.sipCallId,
  };
};

export const deleteDispatchRule = async (dispatchRuleId) => {
  if (!dispatchRuleId) return false;

  const sipClient = createSipClient();
  await sipClient.deleteSipDispatchRule(dispatchRuleId);
  return true;
};
