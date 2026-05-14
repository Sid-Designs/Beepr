import { getAgentConfig } from "../config/agents.js";

/**
 * Generate structured AI prompt for agent
 */
const generateAgentPrompt = (agent, tenant) => {
  const { name, type, tone, script, faqs = [], callConfig = {} } = agent;

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

  if (agentConfig.goals?.goal) {
    prompt += `
\nGoal:
${agentConfig.goals.goal}
`;
  }

  if (Array.isArray(agentConfig.goals?.tasks) && agentConfig.goals.tasks.length > 0) {
    prompt += `\nKey Tasks:`;
    agentConfig.goals.tasks.forEach((task) => {
      prompt += `\n- ${task}`;
    });
    prompt += "\n";
  }

  // --- SCRIPT ---
  if (script) {
    prompt += `
\nCustom Instructions:
${script}
`;
  }

  if (callConfig && Object.keys(callConfig).length > 0) {
    const qualificationFields = Array.isArray(callConfig.qualificationFields)
      ? callConfig.qualificationFields.filter(Boolean)
      : [];

    prompt += `\n\nCall Behavior Configuration:`;

    if (callConfig.objective) {
      prompt += `\n- Call objective: ${callConfig.objective}`;
    }

    if (callConfig.reasonForCalling) {
      prompt += `\n- Reason for calling: ${callConfig.reasonForCalling}`;
    }

    if (callConfig.primaryGoal) {
      prompt += `\n- Primary goal: ${callConfig.primaryGoal}`;
    }

    if (callConfig.openingScript) {
      prompt += `\n- Opening script: ${callConfig.openingScript}`;
    }

    if (qualificationFields.length > 0) {
      prompt += `\n- Qualification fields: ${qualificationFields.join(", ")}`;
    }

    prompt += `\n- Appointment booking enabled: ${callConfig.allowAppointmentBooking ? "yes" : "no"}`;
    prompt += `\n- Human handoff enabled: ${callConfig.allowHandoff ? "yes" : "no"}`;

    if (callConfig.businessContext) {
      prompt += `\n- Business context: ${callConfig.businessContext}`;
    }
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
- ${agentConfig.goals?.handoff || "If unsure, say you will connect to a human agent"}
- Stay within the business context of ${tenant.orgName}
`;

  return prompt.trim();
};

export default generateAgentPrompt;
