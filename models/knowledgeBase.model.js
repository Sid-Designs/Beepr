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

    text: {
      type: String,
    },

    docId: {
      type: String,
      index: true,
    },

    metadata: {
      heading: String,
      sourceType: String,
      chunkIndex: Number,
      sourceUrl: String,
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
KnowledgeBaseSchema.index({ tenantId: 1, agentId: 1, docId: 1 });
KnowledgeBaseSchema.index({ content: "text" });

const KnowledgeBase = mongoose.model("KnowledgeBase", KnowledgeBaseSchema);

export default KnowledgeBase;
