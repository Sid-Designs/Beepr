import express from 'express';
import errorMiddleware from "./middlewares/error.middleware.js";
import healthRoutes from "./routes/health.route.js";

const app = express();

// Middleware
app.use(express.json());

// Routes
app.use("/api", healthRoutes);

// Root Route
app.get("/", (req, res) => {
  res.send("Beepr API is running...");
});

// Error Middleware
app.use(errorMiddleware);

export default app;