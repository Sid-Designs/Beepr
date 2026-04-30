import mongoose from "mongoose";

const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGO_URI);
    return conn;
  } catch (error) {
    console.error("❌ MongoDB Connection Failed");
    process.exit(1);
  }
};

export default connectDB;
