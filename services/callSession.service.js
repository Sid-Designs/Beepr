const sessions = new Map();

const normalizeCallId = (value) => {
  if (!value) return "";
  return String(value).trim();
};

const buildRoomName = (callId) => {
  const safe = callId.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 64);
  return `call-${safe || Date.now()}`;
};

export const createCallSession = (callId, tenantId, agentId) => {
  const id = normalizeCallId(callId);
  if (!id) throw new Error("callId is required");

  if (sessions.has(id)) {
    return sessions.get(id);
  }

  const session = {
    callId: id,
    tenantId,
    agentId,
    roomName: buildRoomName(id),
    createdAt: new Date().toISOString(),
    answerAt: Date.now(),
    wsConnectedAt: null,
  };

  sessions.set(id, session);
  return session;
};

export const getCallSession = (callId) => {
  const id = normalizeCallId(callId);
  if (!id) return null;
  return sessions.get(id) || null;
};

export const removeCallSession = (callId) => {
  const id = normalizeCallId(callId);
  if (!id) return null;
  const session = sessions.get(id) || null;
  sessions.delete(id);
  return session;
};

export const markWsConnected = (callId) => {
  const id = normalizeCallId(callId);
  if (!id) return null;
  const session = sessions.get(id);
  if (!session) return null;
  session.wsConnectedAt = Date.now();
  return session;
};

export const wasWsConnected = (callId) => {
  const id = normalizeCallId(callId);
  if (!id) return false;
  const session = sessions.get(id);
  return Boolean(session?.wsConnectedAt);
};
