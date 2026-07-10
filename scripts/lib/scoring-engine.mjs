/**
 * scoring-engine.mjs
 *
 * Compares a structured job profile (extracted by DeepSeek) against the
 * candidate profile (also DeepSeek-extracted, from parse-cv.mjs) and
 * produces a score, verdict, and human-readable reasons.
 */

import {
  HARD_REJECT_PHRASES,
  NATIONAL_RESTRICTION_PHRASES,
  INTERNATIONAL_COUNTER_SIGNALS,
  PENALISED_PROFESSIONS,
  PREFERRED_ROLES,
  MOBILITY_POSITIVE,
  MOBILITY_NEGATIVE,
  EDUCATION_BOOST_FIELDS,
  EDUCATION_PENALTY_FIELDS,
  TITLE_WEIGHT,
  BODY_WEIGHT,
  verdictFor
} from "../config.mjs";

export function checkHardReject(fullText) {
  for (const re of HARD_REJECT_PHRASES) {
    if (re.test(fullText)) return `Hard reject phrase matched: "${re.source}"`;
  }
  return null;
}

export function checkNationalRestriction(fullText) {
  const restricted = NATIONAL_RESTRICTION_PHRASES.some((re) => re.test(fullText));
  if (!restricted) return null;
  const hasCounterSignal = INTERNATIONAL_COUNTER_SIGNALS.some((re) => re.test(fullText));
  if (hasCounterSignal) return null; // explicit international recruitment overrides the restriction phrase
  return "Appears restricted to national/local candidates";
}

/**
 * jobProfile is the structured object DeepSeek extracts per job (see
 * JOB_EXTRACTION_PROMPT in fetch-jobs.mjs).
 * candidateProfile is the .profile object from candidate-profile.json.
 */
export function scoreJob({ title, body, jobProfile, candidateProfile }) {
  const fullText = `${title} ${body}`;
  const titleLower = (title || "").toLowerCase();

  const hardRejectReason = checkHardReject(fullText);
  if (hardRejectReason) {
    return { rejected: true, rejectReason: hardRejectReason };
  }

  const nationalReason = checkNationalRestriction(fullText);
  if (nationalReason) {
    return { rejected: true, rejectReason: nationalReason };
  }

  let titleScore = 0;
  let bodyKeywordScore = 0;
  let structuredScore = 0;
  const reasons = [];
  const addTitle = (pts, label) => { titleScore += pts; reasons.push(`${pts > 0 ? "+" : "-"} ${label} (title)`); };
  const addBodyKeyword = (pts, label) => { bodyKeywordScore += pts; reasons.push(`${pts > 0 ? "+" : "-"} ${label}`); };
  const addStructured = (pts, label) => { structuredScore += pts; reasons.push(`${pts > 0 ? "+" : "-"} ${label}`); };

  // Preferred roles (keyword-style -- title/body weighting applies)
  for (const [role, weight] of Object.entries(PREFERRED_ROLES)) {
    if (titleLower.includes(role)) addTitle(weight, role);
    else if (fullText.toLowerCase().includes(role)) addBodyKeyword(Math.round(weight * 0.5), role);
  }

  // Penalised professions (keyword-style -- title/body weighting applies)
  for (const [prof, weight] of Object.entries(PENALISED_PROFESSIONS)) {
    if (titleLower.includes(prof)) addTitle(weight, prof);
    else if (fullText.toLowerCase().includes(prof)) addBodyKeyword(Math.round(weight * 0.5), prof);
  }

  // Everything below is a high-confidence structured signal (from the AI
  // job-profile extraction or explicit mobility phrasing), not a fuzzy
  // keyword hit -- these count at full strength rather than being
  // dampened by the title/body split.

  // Mobility signals
  for (const { re, points } of [...MOBILITY_POSITIVE, ...MOBILITY_NEGATIVE]) {
    if (re.test(fullText)) {
      addStructured(points, re.source.slice(0, 40));
    }
  }

  // Experience matching, using AI-extracted job requirement vs candidate profile
  if (jobProfile?.years_experience_required != null && candidateProfile?.years_experience_total != null) {
    const req = jobProfile.years_experience_required;
    const have = candidateProfile.years_experience_total;
    const diff = have - req;
    if (diff >= 0 && diff <= 10) {
      addStructured(15, `experience matches (${have}y vs ${req}y required)`);
    } else if (diff > 10) {
      addStructured(-5, `may be overqualified (${have}y vs ${req}y required)`);
    } else {
      addStructured(-30, `below required experience (${have}y vs ${req}y required)`);
    }
  }

  // Education matching
  if (jobProfile?.education_field) {
    const field = jobProfile.education_field.toLowerCase();
    if (EDUCATION_BOOST_FIELDS.some((f) => field.includes(f))) {
      addStructured(10, `education field aligned (${jobProfile.education_field})`);
    } else if (EDUCATION_PENALTY_FIELDS.some((f) => field.includes(f))) {
      addStructured(-20, `education field mismatch (${jobProfile.education_field})`);
    }
  }
  if (jobProfile?.degree_required === "master" || jobProfile?.degree_required === "phd") {
    if (candidateProfile?.education?.highest_level && !["master", "phd"].includes(candidateProfile.education.highest_level)) {
      addStructured(-20, `requires ${jobProfile.degree_required}'s degree`);
    }
  } else if (jobProfile?.degree_required === "bachelor") {
    if (candidateProfile?.education?.highest_level && !["bachelor", "master", "phd"].includes(candidateProfile.education.highest_level)) {
      addStructured(-15, "requires bachelor's degree");
    }
  } else if (jobProfile?.degree_required === "equivalent_experience_accepted") {
    addStructured(15, "degree can be substituted by experience -- good fit");
  }

  // Direct profession/function alignment -- this is the strongest signal
  // available and was previously unused. Compares the job's AI-extracted
  // profession against the candidate's actual functions and preferred
  // job families from their CV.
  if (jobProfile?.profession) {
    const jobProf = jobProfile.profession.toLowerCase();
    const candFunctions = (candidateProfile?.functions || []).map((f) => f.toLowerCase());
    const candPreferred = (candidateProfile?.preferred_job_families || []).map((f) => f.toLowerCase());

    const directFunctionMatch = candFunctions.some((f) => jobProf.includes(f) || f.includes(jobProf));
    const preferredFamilyMatch = candPreferred.some((f) => jobProf.includes(f) || f.includes(jobProf));

    if (directFunctionMatch) {
      addStructured(30, `profession matches your experience (${jobProfile.profession})`);
    } else if (preferredFamilyMatch) {
      addStructured(22, `profession matches your preferred field (${jobProfile.profession})`);
    }
  }

  // Management level alignment
  if (jobProfile?.management_level && candidateProfile?.management_level) {
    const levels = ["entry", "officer", "coordinator", "manager", "senior_manager", "director"];
    const jobIdx = levels.indexOf(jobProfile.management_level);
    const candIdx = levels.indexOf(candidateProfile.management_level);
    if (jobIdx !== -1 && candIdx !== -1) {
      const gap = candIdx - jobIdx;
      // Softened vs. earlier version: a senior candidate applying to a
      // Coordinator/Manager-level role (the realistic target band) should
      // not be penalised heavily just for being more experienced than the
      // stated minimum -- that's normal and often an advantage.
      if (gap === 0) addStructured(10, "management level matches");
      else if (gap === 1) addStructured(5, "slightly senior for this level -- likely fine");
      else if (gap === 2) addStructured(-5, "somewhat senior for this level");
      else if (gap >= 3) addStructured(-15, "significantly overqualified for this level");
      else if (gap <= -2) addStructured(-25, "likely underqualified for this level");
    }
  }

  // Base score: keyword matching contributes up to ~45 points, weighted
  // by title/body prominence. Structured AI signals contribute their full
  // point value directly, since they're higher-confidence than keyword hits.
  const keywordComponent = (titleScore * TITLE_WEIGHT * 2.5) + (bodyKeywordScore * BODY_WEIGHT);
  const weighted = keywordComponent + structuredScore;
  const clamped = Math.max(0, Math.min(100, Math.round(weighted)));

  return {
    rejected: false,
    score: clamped,
    verdict: verdictFor(clamped),
    reasons,
    warnings: jobProfile?.warnings || []
  };
}
