import { AccessToken } from "livekit-server-sdk";

export const generateLiveKitToken = async (roomName, participantName) => {
  if (!roomName) {
    throw new Error("roomName is required");
  }

  if (!participantName) {
    throw new Error("participantName is required");
  }

  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;

  if (!apiKey || !apiSecret) {
    throw new Error("LiveKit API key/secret not configured");
  }

  const token = new AccessToken(apiKey, apiSecret, {
    identity: participantName,
  });

  token.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canSubscribe: true,
  });

  const jwt = token.toJwt();
  return typeof jwt === "string" ? jwt : await jwt;
};
