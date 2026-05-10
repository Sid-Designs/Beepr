import mongoose from "mongoose";

const { Schema } = mongoose;

const CallRouteSchema = new Schema(
  {
    did: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    tenantId: {
      type: Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },
    agentId: {
      type: Schema.Types.ObjectId,
      ref: "Agent",
      required: true,
      index: true,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    metadata: {
      type: Schema.Types.Mixed,
      default: {},
    },
  },
  { timestamps: true },
);

CallRouteSchema.index({ did: 1, isActive: 1 });

export default mongoose.model("CallRoute", CallRouteSchema);
