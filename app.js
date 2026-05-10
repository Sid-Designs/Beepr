import express from 'express';
import errorMiddleware from "./middlewares/error.middleware.js";
import healthRoutes from "./routes/health.route.js";
import tenantRoutes from "./routes/tenant.route.js";
import agentRoutes from "./routes/agent.route.js";
import kbRoutes from "./routes/kb.route.js";
import aiRoutes from "./routes/ai.route.js";
import livekitRoutes from "./routes/livekit.route.js";
import callRoutes from "./routes/call.route.js";

const app = express();

// Middleware
// Only the LiveKit SIP webhook needs the raw body for signature verification.
app.use("/api/livekit/sip/webhook", express.raw({ type: "*/*" }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
app.use("/api", healthRoutes);
app.use("/api/tenant", tenantRoutes);
app.use("/api/agent", agentRoutes);
app.use("/api/kb", kbRoutes);
app.use("/api/ai", aiRoutes);
app.use("/api/call", callRoutes);
app.use("/api/livekit", livekitRoutes);

// Root Route
app.get("/", (req, res) => {
  res.send("Beepr API is running...");
});

// Error Middleware
app.use(errorMiddleware);

export default app;