/**
 * config.mjs
 *
 * Single source of truth for every rule used anywhere in the pipeline
 * (CV parsing prompts, job scoring, hard rejects). Nothing in scripts/
 * should hardcode a keyword list outside of this file.
 */

// Phrases that mean "you cannot apply, full stop" -- checked against the
// full job text, not just the title, since these often appear mid-body.
export const HARD_REJECT_PHRASES = [
  /internal applicants? only/i,
  /current employees? only/i,
  /internal recruitment/i,
  /opportunity marketplace/i,
  /existing staff only/i
];

// National/visa restriction phrases -- rejected UNLESS the text also
// contains an explicit international-recruitment counter-signal.
export const NATIONAL_RESTRICTION_PHRASES = [
  /national position/i,
  /nationals? only/i,
  /local candidates? only/i,
  /must (already )?(hold|possess) (the )?(right to work|work permit)/i,
  /no visa sponsorship/i
];

export const INTERNATIONAL_COUNTER_SIGNALS = [
  /international recruitment/i,
  /internationally recruited/i,
  /visa sponsorship (available|provided)/i,
  /international staff/i
];

// Professions/functions to reject or heavily penalise unless the
// candidate profile explicitly lists them as a skill.
export const PENALISED_PROFESSIONS = {
  "finance": -60,
  "accounting": -70,
  "accountant": -70,
  "medical": -90,
  "clinical": -90,
  "psychology": -90,
  "mental health": -90,
  "social work": -80,
  "legal": -70,
  "teaching": -60,
  "education": -40,
  "research": -40,
  "nutrition": -40,
  "monitoring and evaluation": -40,
  "meal": -35,
  "security specialist": -50,
  "cash programming specialist": -50,
  "human resources": -40
};

// Roles/functions to favour strongly.
export const PREFERRED_ROLES = {
  "operations manager": 20,
  "logistics manager": 20,
  "fleet manager": 20,
  "area manager": 18,
  "field coordinator": 18,
  "base manager": 18,
  "country logistics": 18,
  "supply chain manager": 18,
  "operations coordinator": 16,
  "emergency operations": 16,
  "administration manager": 14,
  "movement control": 20,
  "transport": 12,
  "logistics": 14,
  "supply chain": 14,
  "procurement": 12,
  "fleet": 14,
  "warehousing": 10,
  "humanitarian operations": 14
};

// International mobility signals.
export const MOBILITY_POSITIVE = [
  { re: /international recruitment|internationally recruited|international staff/i, points: 15 },
  { re: /visa sponsorship/i, points: 15 },
  { re: /flights? (provided|covered|included)/i, points: 6 },
  { re: /accommodation provided/i, points: 6 },
  { re: /hardship allowance/i, points: 6 },
  { re: /\br&r\b/i, points: 5 },
  { re: /family (duty station|package)/i, points: 4 },
  { re: /expat package/i, points: 8 }
];
export const MOBILITY_NEGATIVE = [
  { re: /must (already )?(hold|possess) (the )?(right to work|work permit)/i, points: -60 },
  { re: /no visa sponsorship/i, points: -60 }
];

// Education signal weights (applied on top of whatever the AI job-parser
// extracts as required degree field).
export const EDUCATION_BOOST_FIELDS = [
  "business", "management", "administration", "supply chain", "operations", "logistics"
];
export const EDUCATION_PENALTY_FIELDS = [
  "medicine", "law", "accounting", "clinical", "engineering", "psychology", "teaching"
];

export const TITLE_WEIGHT = 0.7;
export const BODY_WEIGHT = 0.3;

export function verdictFor(score) {
  if (score >= 85) return { label: "Excellent match", tier: "apply-now" };
  if (score >= 70) return { label: "Strong match", tier: "strong" };
  if (score >= 55) return { label: "Worth reviewing", tier: "review" };
  return { label: "Low match", tier: "skip" };
}

export const MIN_SCORE_TO_SHOW = 40;
