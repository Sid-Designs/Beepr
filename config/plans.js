export const PLANS = Object.freeze({
  free: {
    maxCallsPerMonth: 10,
    maxAgents: 1,
  },
  pro: {
    maxCallsPerMonth: 200,
    maxAgents: 3,
  },
  enterprise: {
    maxCallsPerMonth: 2000,
    maxAgents: 10,
  },
});
