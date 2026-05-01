import mongoose from "mongoose";

import { PLANS } from "../config/plans.js";

const { Schema } = mongoose;

const TenantSchema = new Schema(
  {
    orgName: {
      type: String,
      required: true,
      trim: true,
      minlength: 2,
      maxlength: 100,
    },
    slug: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      match: /^[a-z0-9-]+$/,
      unique: true,
      index: true,
    },
    industry: {
      type: String,
      required: true,
      trim: true,
    },
    plan: {
      type: String,
      enum: Object.keys(PLANS),
      default: "free",
    },
    usageLimits: {
      maxCallsPerMonth: {
        type: Number,
      },
      maxAgents: {
        type: Number,
      },
    },
    usage: {
      callsUsed: { type: Number, default: 0 },
      agentsUsed: { type: Number, default: 0 },
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    metadata: {
      type: Schema.Types.Mixed,
      default: {},
    },
  },
  { timestamps: true },
);

TenantSchema.pre("save", function () {
  if (!this.isNew && !this.isModified("plan")) return;

  const planConfig = PLANS[this.plan];

  if (!planConfig) {
    throw new Error("Invalid plan");
  }

  this.usageLimits = {
    maxCallsPerMonth: planConfig.maxCallsPerMonth,
    maxAgents: planConfig.maxAgents,
  };
});

TenantSchema.index({ plan: 1 });
TenantSchema.index({ isActive: 1 });

export default mongoose.model("Tenant", TenantSchema);
