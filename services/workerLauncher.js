import { spawn } from "node:child_process";
import path from "node:path";

const workers = new Map();

const buildWorkerMetadata = ({ roomName, callObjective, callConfig } = {}) => {
  const metadata = {
    roomName: roomName || "",
    callObjective: callObjective || "",
    callConfig:
      callConfig && typeof callConfig === "object"
        ? callConfig
        : null,
  };

  const hasMetadata = Boolean(
    metadata.callObjective ||
      (metadata.callConfig && Object.keys(metadata.callConfig).length > 0),
  );

  return hasMetadata ? metadata : null;
};

const buildWorkerArgs = ({ roomName, tenantId, agentId, workerMetadata }) => {
  const args = [
    path.resolve("worker.js"),
    roomName,
    tenantId,
    agentId,
  ];

  if (workerMetadata) {
    args.push(JSON.stringify(workerMetadata));
  }

  return args;
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

  const args = buildWorkerArgs({
    roomName: session.roomName,
    tenantId: session.tenantId,
    agentId: session.agentId,
    workerMetadata: session.workerMetadata || null,
  });

  const child = spawn(process.execPath, args, { stdio: "inherit" });
  registerWorker(session.callId, child);
  return child;
};

export const startWorkerForRoom = (roomName, options = {}) => {
  const {
    tenantId,
    agentId,
    callObjective = "",
    callConfig = null,
  } = options;

  if (!roomName || !tenantId || !agentId) {
    throw new Error("roomName, tenantId, and agentId are required");
  }

  if (workers.has(roomName)) {
    return workers.get(roomName);
  }

  const workerMetadata = buildWorkerMetadata({
    roomName,
    callObjective,
    callConfig,
  });

  const args = buildWorkerArgs({
    roomName,
    tenantId,
    agentId,
    workerMetadata,
  });

  const child = spawn(process.execPath, args, { stdio: "inherit" });
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
