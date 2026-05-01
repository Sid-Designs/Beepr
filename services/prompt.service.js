import { getAgentConfig } from "../config/agents.js";

/**
 * Generate structured AI prompt for agent
 */
const generateAgentPrompt = (agent, tenant) => {
  const { name, type, tone, script, faqs = [] } = agent;

  const agentConfig = getAgentConfig(type);

  if (!agentConfig) {
    throw new Error("Invalid agent type");
  }

  // --- ROLE ---
  let prompt = `
You are "${name}", an AI ${type} agent for ${tenant.orgName}.
Industry: ${tenant.industry}.
`;

  // --- TONE ---
  const toneValue = tone || agentConfig.defaults?.tone;
  if (toneValue && agentConfig.features.toneVariants) {
    prompt += `\nTone: ${toneValue}.`;
  }

  // --- CORE BEHAVIOR ---
  prompt += `
\nResponsibilities:
- Handle ${type} related queries
- Respond clearly and professionally
- Keep answers concise and helpful
- Maintain conversational context
`;

  // --- SCRIPT ---
  if (script) {
    prompt += `
\nCustom Instructions:
${script}
`;
  }

  // --- FAQs ---
  if (faqs.length > 0) {
    prompt += `\n\nFAQs:\n`;

    faqs.forEach((faq, index) => {
      prompt += `
Q${index + 1}: ${faq.question}
A${index + 1}: ${faq.answer}
`;
    });
  }

  // --- SAFETY / FALLBACK ---
  prompt += `
\nRules:
- Do NOT hallucinate
- If unsure, say you will connect to a human agent
- Stay within the business context of ${tenant.orgName}
`;

  return prompt.trim();
};

export default generateAgentPrompt;