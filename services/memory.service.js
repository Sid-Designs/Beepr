const sessionStore = new Map();

const createDefaultSession = () => ({
  messages: [],
  lastContext: "",
  lastIntent: "",
  lastIntentData: null,
  callState: null,
});

const normalizeMessages = (messages) => {
  if (!Array.isArray(messages)) return [];

  return messages.filter(
    (msg) =>
      msg &&
      (msg.role === "user" || msg.role === "assistant") &&
      typeof msg.content === "string",
  );
};

export const getSessionMessages = (sessionId) => {
  if (!sessionId) return [];

  const session = sessionStore.get(sessionId);
  return normalizeMessages(session?.messages);
};

export const addMessageToSession = (sessionId, role, content) => {
  if (!sessionId || !role || typeof content !== "string") return;

  const session = sessionStore.get(sessionId) || createDefaultSession();
  const messages = normalizeMessages(session.messages);
  messages.push({ role, content });

  // Keep only last 5 exchanges (user+assistant), i.e. 10 messages.
  const trimmed = messages.slice(-10);
  sessionStore.set(sessionId, { ...session, messages: trimmed });
};

export const getSessionContext = (sessionId) => {
  if (!sessionId) return "";
  const session = sessionStore.get(sessionId);
  return typeof session?.lastContext === "string" ? session.lastContext : "";
};

export const setSessionContext = (sessionId, context) => {
  if (!sessionId || typeof context !== "string") return;
  const session = sessionStore.get(sessionId) || createDefaultSession();
  sessionStore.set(sessionId, { ...session, lastContext: context });
};

export const getSessionIntent = (sessionId) => {
  if (!sessionId) return "";
  const session = sessionStore.get(sessionId);
  return typeof session?.lastIntent === "string" ? session.lastIntent : "";
};

export const setSessionIntent = (sessionId, intent) => {
  if (!sessionId || typeof intent !== "string") return;
  const session = sessionStore.get(sessionId) || createDefaultSession();
  sessionStore.set(sessionId, { ...session, lastIntent: intent });
};

export const getSessionIntentData = (sessionId) => {
  if (!sessionId) return null;
  const session = sessionStore.get(sessionId);
  return session?.lastIntentData || null;
};

export const setSessionIntentData = (sessionId, intentData) => {
  if (!sessionId || !intentData) return;
  const session = sessionStore.get(sessionId) || createDefaultSession();
  sessionStore.set(sessionId, { ...session, lastIntentData: intentData });
};

export const getSessionCallState = (sessionId) => {
  if (!sessionId) return null;
  const session = sessionStore.get(sessionId);
  return session?.callState || null;
};

export const setSessionCallState = (sessionId, callState) => {
  if (!sessionId || !callState || typeof callState !== "object") return;
  const session = sessionStore.get(sessionId) || createDefaultSession();
  sessionStore.set(sessionId, { ...session, callState });
};
