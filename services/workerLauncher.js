import { spawn } from "node:child_process";
import path from "node:path";

const workers = new Map();

const buildWorkerArgs = (session) => {
  return [
    path.resolve("worker.js"),
    session.roomName,
    session.tenantId,
    session.agentId,
  ];
};

const registerWorker = (key, child) => {
  workers.set(key, child);

  child.on("exit", () => {
    workers.delete(key);
  });
};

export const startWorkerForCall = (session) => {
  if (!session?.callId) {
    throw new Error("session.callId is required");
  }

  if (workers.has(session.callId)) {
    return workers.get(session.callId);
  }

  const args = buildWorkerArgs(session);
  const child = spawn(process.execPath, args, {
    stdio: "inherit",
  });

  registerWorker(session.callId, child);

  return child;
};

export const startWorkerForRoom = (roomName, { tenantId, agentId }) => {
  if (!roomName || !tenantId || !agentId) {
    throw new Error("roomName, tenantId, and agentId are required");
  }

  if (workers.has(roomName)) {
    return workers.get(roomName);
  }

  const args = buildWorkerArgs({ roomName, tenantId, agentId });
  const child = spawn(process.execPath, args, {
    stdio: "inherit",
  });

  registerWorker(roomName, child);
  return child;
};

export const stopWorker = (callId) => {
  const child = workers.get(callId);
  if (!child) return false;

  try {
    child.kill("SIGTERM");
  } catch {
    // best-effort
  }

  workers.delete(callId);
  return true;
};

export const stopWorkerByRoom = (roomName) => {
  const child = workers.get(roomName);
  if (!child) return false;

  try {
    child.kill("SIGTERM");
  } catch {
    // best-effort
  }

  workers.delete(roomName);
  return true;
};
