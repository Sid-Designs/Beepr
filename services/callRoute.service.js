import CallRoute from "../models/callRoute.model.js";

const normalizeDid = (value) => {
  if (!value) return "";
  return String(value).replace(/[^0-9+]/g, "").trim();
};

export const resolveRouteByDid = async (did) => {
  const normalized = normalizeDid(did);
  if (!normalized) return null;

  const route = await CallRoute.findOne({ did: normalized, isActive: true })
    .select("tenantId agentId did")
    .lean();

  return route || null;
};
