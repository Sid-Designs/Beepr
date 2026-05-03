import mongoose from "mongoose";
const { Schema } = mongoose;

const KnowledgeBaseSchema = new Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },

    agentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Agent",
      required: true,
      index: true,
    },

    content: {
      type: String,
      required: true,
    },

    embedding: {
      type: [Number],
      required: true,
    },

    sourceType: {
      type: String,
      enum: ["text", "pdf", "url"],
      required: true,
    },

    sourceUrl: {
      type: String,
    },

    sourceId: {
      type: String,
    },
  },
  { timestamps: true },
);

KnowledgeBaseSchema.index({ tenantId: 1, agentId: 1 });
KnowledgeBaseSchema.index({ content: "text" });

const KnowledgeBase = mongoose.model("KnowledgeBase", KnowledgeBaseSchema);

export default KnowledgeBase;
