// Lightcast Open Skills ID mapping via LLM.
//
// Maps free-text skills (from cv.md) to Lightcast Open Skills taxonomy IDs.
// Uses the configured LLM provider (Gemini/DeepSeek) or MCP sampling to perform
// the mapping. Falls back to lightcast_id: null when no LLM is available.
//
// Lightcast IDs follow the format "KS" + alphanumeric characters (e.g., "KS1234AB56").
// The mapping is best-effort: the LLM returns confidence scores, and we accept mappings
// with confidence >= 0.7.

import { chatLogged, llmAvailable } from './llm.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SkillMapping {
  name: string;
  lightcast_id: string | null;
  confidence: number;
}

export interface LightcastMappingOptions {
  /** Minimum confidence threshold to accept a mapping. Default: 0.7 */
  minConfidence?: number;
}

// ── Mapper ────────────────────────────────────────────────────────────────────

/**
 * Map a list of free-text skills to Lightcast Open Skills IDs using the LLM.
 *
 * The LLM is given a system prompt explaining the Lightcast taxonomy and asked to
 * return STRICT JSON: [{ name, lightcast_id, confidence }].
 *
 * If no LLM is available (llmAvailable() === false), returns all skills with
 * lightcast_id: null and confidence: 0.
 *
 * @param skills - Array of skill names (e.g., ["Python", "TypeScript", "Machine Learning"])
 * @param opts - Options (minConfidence threshold)
 * @returns Array of SkillMapping objects
 */
export async function mapSkillsToLightcast(
  skills: string[],
  opts: LightcastMappingOptions = {},
): Promise<SkillMapping[]> {
  if (!skills.length) return [];

  const minConfidence = opts.minConfidence ?? 0.7;

  // If no LLM is available, return unmapped skills
  if (!llmAvailable()) {
    return skills.map((name) => ({
      name,
      lightcast_id: null,
      confidence: 0,
    }));
  }

  // Build the LLM prompt
  const systemPrompt = `You are a skill-taxonomy mapper. Your task is to map free-text skills to their corresponding Lightcast Open Skills IDs.

Lightcast Open Skills is a standardized taxonomy of work skills. Each skill has a unique ID in the format "KS" followed by alphanumeric characters (e.g., "KS1234AB56", "KS7890CD12").

Given a list of skills, map each to its most likely Lightcast ID. If you cannot confidently map a skill (e.g., it's too vague, proprietary, or not in the Lightcast taxonomy), set lightcast_id to null.

Return STRICT JSON in this exact format:
[
  { "name": "Python", "lightcast_id": "KS1234AB56", "confidence": 0.95 },
  { "name": "TypeScript", "lightcast_id": "KS7890CD12", "confidence": 0.92 },
  { "name": "Some Proprietary Tool", "lightcast_id": null, "confidence": 0.3 }
]

Confidence should be a number between 0 and 1, representing how confident you are in the mapping. Only return confidence >= 0.7 for mappings you're reasonably sure about.`;

  const userPrompt = `Map these skills to Lightcast Open Skills IDs:
${skills.map((s) => `- ${s}`).join('\n')}

Return STRICT JSON array.`;

  // Call the LLM
  try {
    const call = await chatLogged(
      'mapSkillsToLightcast',
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      {
        responseFormat: 'json_object',
        temperature: 0.2,
        maxTokens: 2000,
      },
    );

    if (!call.parseOk || !Array.isArray(call.parsed)) {
      // Parse failed — return unmapped skills
      console.error(`[lightcast] LLM parse failed: ${call.parseError}`);
      return skills.map((name) => ({
        name,
        lightcast_id: null,
        confidence: 0,
      }));
    }

    // Validate and filter the response
    const mappings: SkillMapping[] = [];
    const parsed = call.parsed as any[];

    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const name = String(item.name || '').trim();
      const lightcast_id = typeof item.lightcast_id === 'string' ? item.lightcast_id.trim() : null;
      const confidence = typeof item.confidence === 'number' ? item.confidence : 0;

      if (!name) continue;

      // Validate Lightcast ID format (KS + alphanumeric)
      if (lightcast_id && !/^KS[A-Z0-9]+$/i.test(lightcast_id)) {
        // Invalid format — treat as unmapped
        mappings.push({ name, lightcast_id: null, confidence: 0 });
        continue;
      }

      // Apply confidence threshold
      if (lightcast_id && confidence >= minConfidence) {
        mappings.push({ name, lightcast_id, confidence });
      } else {
        mappings.push({ name, lightcast_id: null, confidence });
      }
    }

    // Ensure all input skills are in the output (even if the LLM missed some)
    const inputSet = new Set(skills.map((s) => s.toLowerCase()));
    const outputSet = new Set(mappings.map((m) => m.name.toLowerCase()));
    for (const skill of skills) {
      if (!outputSet.has(skill.toLowerCase())) {
        mappings.push({ name: skill, lightcast_id: null, confidence: 0 });
      }
    }

    return mappings;
  } catch (e: any) {
    // LLM call failed — return unmapped skills
    console.error(`[lightcast] LLM call failed: ${e?.message ?? e}`);
    return skills.map((name) => ({
      name,
      lightcast_id: null,
      confidence: 0,
    }));
  }
}
