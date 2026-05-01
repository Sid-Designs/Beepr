import mongoose from "mongoose";

import { Agents, getAgentConfig } from "../config/agents.js";

const { Schema } = mongoose;

const faqSchema = new Schema(
    {
        question: {
            type: String,
            required: true,
            trim: true,
        },
        answer: {
            type: String,
            required: true,
            trim: true,
        },
    },
    { _id: false },
);

const AgentSchema = new Schema(
    {
        tenantId: {
            type: Schema.Types.ObjectId,
            ref: "Tenant",
            required: true,
            index: true,
        },
        name: {
            type: String,
            required: true,
            trim: true,
            minlength: 2,
            maxlength: 100,
        },
        type: {
            type: String,
            enum: Object.keys(Agents),
            required: true,
        },
        tone: {
            type: String,
            trim: true,
        },
        script: {
            type: String,
            trim: true,
        },
        faqs: {
            type: [faqSchema],
            default: [],
        },
        prompt: {
            type: String,
            required: true,
            trim: true,
        },
        isActive: {
            type: Boolean,
            default: true,
        },
        version: {
            type: Number,
            default: 1,
        },
    },
    { timestamps: true },
);

AgentSchema.index({ tenantId: 1, isActive: 1 });

AgentSchema.pre("validate", function () {
    const cfg = getAgentConfig(this.type);
    if (!cfg) {
        throw new Error("Invalid agent type");
    }

    if (!this.tone && cfg.defaults?.tone && cfg.features?.toneVariants) {
        this.tone = cfg.defaults.tone;
    }

    const toneValue = typeof this.tone === "string" ? this.tone.trim() : this.tone;
    if (!cfg.features?.toneVariants && toneValue) {
        throw new Error(`Tone not allowed for type: ${this.type}`);
    }

    if (cfg.validation?.toneWhitelist && toneValue) {
        if (!cfg.validation.toneWhitelist.includes(toneValue)) {
            throw new Error(`Tone not allowed for type: ${this.type}`);
        }
    }

    if (cfg.limits?.maxFaqs && Array.isArray(this.faqs)) {
        if (this.faqs.length > cfg.limits.maxFaqs) {
            throw new Error(`FAQ limit exceeded for type: ${this.type}`);
        }
    }

    if (cfg.limits?.maxScriptChars && typeof this.script === "string") {
        if (this.script.length > cfg.limits.maxScriptChars) {
            throw new Error(`Script too long for type: ${this.type}`);
        }
    }
});

export default mongoose.model("Agent", AgentSchema);