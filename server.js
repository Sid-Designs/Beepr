import dotenv from "dotenv";
import app from "./app.js";
import connectDB from "./config/db.js";

dotenv.config();

const PORT = process.env.PORT || 5000;
const NODE_ENV = process.env.NODE_ENV || "development";

// Start Server
const startServer = async () => {
  try {
    // Connect Database
    const conn = await connectDB();

    // Start Express Server
    app.listen(PORT, () => {
      console.log("======================================");
      console.log(`🚀 Server running in ${NODE_ENV} mode`);
      console.log(`🗄️  MongoDB Connected Successfully`);
      console.log(`🌐 http://localhost:${PORT}`);
      console.log("======================================");
    });
  } catch (error) {
    console.error("❌ Server failed to start:", error.message);
    process.exit(1);
  }
};

startServer();