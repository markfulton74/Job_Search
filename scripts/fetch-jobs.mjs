#!/usr/bin/env node
/**
 * fetch-jobs.mjs
 *
 * Pipeline:
 *  1. Query the live ReliefWeb API (expired postings excluded by default).
 *  2. Cheap regex pre-filter (hard-reject phrases, national restrictions)
 *     to avoid spending API calls on jobs that are rejected outright.
 *  3. For surviving jobs, ask DeepSeek to extract a structured job profile.
 *  4. Score that profile against data/candidate-profile.json.
 *  5. Write jobs.json with scored/verdicted/explained results, plus a
 *     daily summary and a hidden-jobs breakdown.
 *
 * Requires candidate-profile.json to already exist -- run parse-cv.mjs
 * first (or via its own workflow) before this will produce meaningful
 * scores.
 */

import { writeFile, readFile } from "fs/promises";
import { askForJson } from "./lib/deepseek.mjs";
import { checkHardReject, checkNationalRestriction, scoreJob } from "./lib/scoring-engine.mjs";
import { MIN_SCORE_TO_SHOW } from "./config.mjs";

const APPNAME = process.env.RELIEFWEB_APPNAME;
if (!APPNAME) {
  throw new Error(
    "RELIEFWEB_APPNAME environment variable is not set. Add it as a repo secret."
  );
}

const CANDIDATE_PROFILE_PATH = "data/candidate-profile.json";
const OUTPUT_PATH = "jobs.json";
const API_FETCH_LIMIT = 60;
const MAX_RETRIES = 3;

// Broad net -- fine-grained rejection happens after this via config.mjs rules
const SEARCH_TERMS = [
  "logistics", "fleet", "procurement", "supply chain", "operations",
  "administration", "movement control", "transport", "warehouse",
  "field coordinator", "area manager", "base manager"
];

function buildSearchUrl() {
  const keywordQuery = SEARCH_TERMS
    .map((k) => (k.includes(" ") ? `"${k}"` : k))
    .join(" OR ");

  const params = [
    ["appname", APPNAME],
    ["preset", "latest"],
    ["limit", String(API_FETCH_LIMIT)],
    ["query[value]", keywordQuery],
    ["query[operator]", "OR"],
    ["fields[include][]", "title"],
    ["fields[include][]", "body"],
    ["fields[include][]", "url_alias"],
    ["fields[include][]", "date.closing"],
    ["fields[include][]", "date.created"],
    ["fields[include][]", "country.name"],
    ["fields[include][]", "source.name"],
    ["fields[include][]", "career_categories.name"]
  ];

  const qs = params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
  return `https://api.reliefweb.int/v2/jobs?${qs}`;
}

async function fetchWithRetry(url, attempts = MAX_RETRIES) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      console.log(`ReliefWeb attempt ${i}/${attempts}...`);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`ReliefWeb API returned ${res.status}: ${await res.text()}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      console.warn(`Attempt ${i} failed: ${err.message}`);
      if (i < attempts) await new Promise((r) => setTimeout(r, 3000 * i));
    }
  }
  throw lastErr;
}

const JOB_EXTRACTION_PROMPT = `You are an expert humanitarian recruitment analyst.
Read this job posting and extract a structured profile as JSON. Only use information
stated or clearly implied in the posting. Return ONLY a JSON object with exactly this shape:

{
  "profession": "the primary professional field, e.g. logistics, finance, medical, programme management",
  "management_level": "entry" | "officer" | "coordinator" | "manager" | "senior_manager" | "director",
  "years_experience_required": number or null,
  "degree_required": "none" | "equivalent_experience_accepted" | "bachelor" | "master" | "phd" | null,
  "education_field": "the field of study required/preferred, if any, else null",
  "languages_required": [array of strings],
  "international_recruitment": true | false | null,
  "warnings": [array of short strings flagging anything ambiguous or risky for an international applicant, e.g. "Visa status unclear", "French preferred but not stated as mandatory"]
}`;

async function extractJobProfile(title, body) {
  const text = `Title: ${title}\n\nDescription:\n${(body || "").slice(0, 4000)}`;
  return askForJson(JOB_EXTRACTION_PROMPT, text);
}

async function main() {
  let candidateProfile = null;
  try {
    const raw = await readFile(CANDIDATE_PROFILE_PATH, "utf-8");
    candidateProfile = JSON.parse(raw).profile;
    console.log("Loaded candidate profile.");
  } catch (err) {
    console.warn(
      `Could not load ${CANDIDATE_PROFILE_PATH} (${err.message}). ` +
      "Scoring will proceed with weaker accuracy until parse-cv.mjs has been run."
    );
  }

  const url = buildSearchUrl();
  console.log("Querying ReliefWeb:", url);
  const data = await fetchWithRetry(url);
  const items = data.data || [];
  console.log(`Received ${items.length} raw results from ReliefWeb`);

  const summary = {
    analysed: items.length,
    displayed: 0,
    hidden_hard_reject: 0,
    hidden_national_restriction: 0,
    hidden_low_score: 0,
    excellent_matches: 0,
    strong_matches: 0,
    review_matches: 0
  };
  const hiddenBreakdown = {};
  const results = [];

  for (const item of items) {
    const f = item.fields || {};
    const title = f.title || "(untitled)";
    const body = f.body || "";
    const fullText = `${title} ${body}`;

    // Cheap pre-filter before spending an API call
    const hardRejectReason = checkHardReject(fullText);
    if (hardRejectReason) {
      summary.hidden_hard_reject++;
      hiddenBreakdown["Internal/restricted recruitment"] = (hiddenBreakdown["Internal/restricted recruitment"] || 0) + 1;
      continue;
    }
    const nationalReason = checkNationalRestriction(fullText);
    if (nationalReason) {
      summary.hidden_national_restriction++;
      hiddenBreakdown["National-only"] = (hiddenBreakdown["National-only"] || 0) + 1;
      continue;
    }

    let jobProfile = null;
    try {
      jobProfile = await extractJobProfile(title, body);
    } catch (err) {
      console.warn(`AI extraction failed for "${title}": ${err.message}. Scoring without job profile.`);
    }

    const result = scoreJob({ title, body, jobProfile, candidateProfile });

    if (result.rejected) {
      summary.hidden_hard_reject++;
      hiddenBreakdown[result.rejectReason] = (hiddenBreakdown[result.rejectReason] || 0) + 1;
      continue;
    }

    if (result.score < MIN_SCORE_TO_SHOW) {
      summary.hidden_low_score++;
      const reason = jobProfile?.profession ? `Low match (${jobProfile.profession})` : "Low match";
      hiddenBreakdown[reason] = (hiddenBreakdown[reason] || 0) + 1;
      continue;
    }

    if (result.verdict.tier === "apply-now") summary.excellent_matches++;
    else if (result.verdict.tier === "strong") summary.strong_matches++;
    else if (result.verdict.tier === "review") summary.review_matches++;

    results.push({
      title,
      org: (f.source && f.source[0] && f.source[0].name) || "Unknown",
      country: (f.country && f.country[0] && f.country[0].name) || "Unspecified",
      url: f.url_alias || `https://reliefweb.int/node/${item.id}`,
      posted: f.date && f.date.created,
      closing: f.date && f.date.closing,
      category: ((f.career_categories || []).map((c) => c.name) || []).join(", "),
      score: result.score,
      verdict: result.verdict,
      reasons: result.reasons,
      warnings: result.warnings,
      job_profile: jobProfile
    });
  }

  results.sort((a, b) => b.score - a.score);
  summary.displayed = results.length;
  summary.average_score = results.length
    ? Math.round(results.reduce((s, j) => s + j.score, 0) / results.length)
    : 0;
  summary.best_match_today = results[0] ? `${results[0].title} (${results[0].org})` : null;

  const output = {
    generated_at: new Date().toISOString(),
    source: "ReliefWeb API (live) + DeepSeek structured extraction",
    candidate_profile_loaded: !!candidateProfile,
    summary,
    hidden_breakdown: hiddenBreakdown,
    jobs: results
  };

  await writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`Wrote ${results.length} scored jobs to ${OUTPUT_PATH}`);
  console.log("Summary:", summary);
}

main().catch((err) => {
  console.error("fetch-jobs.mjs failed:", err);
  process.exit(1);
});
