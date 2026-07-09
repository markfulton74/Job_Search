#!/usr/bin/env node
/**
 * fetch-jobs.mjs
 *
 * Queries the LIVE ReliefWeb API (not a search-engine index, not a cache)
 * for currently-open humanitarian job listings, scores each one against
 * Mark Fulton's profile, and writes the result to jobs.json.
 *
 * Runs automatically once a day via .github/workflows/update-jobs.yml
 * You can also run it manually: node scripts/fetch-jobs.mjs
 *
 * Why this avoids the "stale listing" problem:
 * ReliefWeb's API excludes expired/closed postings by default. You only
 * get archived/expired jobs if you explicitly ask with preset=analysis,
 * which this script never does.
 */

import { writeFile } from "fs/promises";

// As of Nov 2025, ReliefWeb requires a pre-approved appname before the API
// will respond. This is read from a GitHub Actions secret (RELIEFWEB_APPNAME)
// set in your repo -- never hardcoded here, since this file is public.
const APPNAME = process.env.RELIEFWEB_APPNAME;

if (!APPNAME) {
  throw new Error(
    "RELIEFWEB_APPNAME environment variable is not set. " +
    "Add it as a repo secret (Settings > Secrets and variables > Actions) " +
    "and make sure the workflow passes it through -- see README.md."
  );
}

// --- Tune this section to match your CV / target roles -------------------

// Positive keywords and how much they should boost a job's score.
// Matches in the TITLE count for much more than matches in the body (see
// TITLE_MULTIPLIER below) -- a job titled "Logistics Coordinator" should
// outrank one that just happens to mention "logistics" once in a long
// description of an unrelated role.
const POSITIVE_KEYWORDS = {
  "fleet": 8,
  "logistics": 8,
  "procurement": 7,
  "supply chain": 7,
  "movement control": 10,
  "transport": 6,
  "administration": 4,
  "compliance": 4,
  "personnel": 4,
  "multi-site": 5,
  "field service": 10,
  "operations": 4,
  "humanitarian": 3,
  "international": 3,
  "south sudan": 7,
  "mali": 7,
  "abyei": 6,
  "post-conflict": 5,
  "peacekeeping": 6,
  "roster": 4,
  "warehouse": 3,
  "asset management": 5,
  "inventory": 4,
  "fuel": 3,
  "driver": 2
};

// Terms that should PULL a score down. This is what actually removes the
// finance/medical/legal/research noise that keyword-only matching lets through.
const NEGATIVE_KEYWORDS = {
  "chief financial officer": -100,
  "cfo": -100,
  "finance officer": -70,
  "finance manager": -60,
  "accountant": -70,
  "clinical": -100,
  "doctor": -100,
  "nurse": -100,
  "psychologist": -100,
  "mhpss": -100,
  "social worker": -100,
  "legal adviser": -70,
  "lawyer": -70,
  "research": -40,
  "phd": -60,
  "monitoring and evaluation": -40,
  "meal": -35,
  "nutrition": -40,
  "cash programming": -50,
  "teaching": -60,
  "education officer": -60
};

// If any of these match the TITLE, the job is dropped entirely -- not
// scored, not shown, no exceptions. These are roles you are structurally
// not competitive for regardless of how logistics-heavy the description reads.
const HARD_REJECT_TITLE = [
  /finance officer/i,
  /financial officer/i,
  /\bcfo\b/i,
  /accountant/i,
  /\bclinical\b/i,
  /\bdoctor\b/i,
  /\bnurse\b/i,
  /psychologist/i,
  /social worker/i,
  /legal adviser/i,
  /\blawyer\b/i,
  /\bintern(ship)?\b/i,
  /\bvolunteer\b/i,
  /research (manager|assistant|officer)/i,
  /\bnutrition/i,
  /\bteaching\b/i
];

// Wording that signals whether an employer will actually consider and
// sponsor an international candidate -- this matters a lot more for you
// than for someone restricted to one country.
const SPONSOR_POSITIVE = [
  { re: /internationally recruited|international recruitment|international staff/i, points: 15, label: "Internationally recruited" },
  { re: /expat package|accommodation provided|r&r|hardship allowance|relocation (assistance|package)/i, points: 8, label: "International staff benefits mentioned" }
];
const SPONSOR_NEGATIVE = [
  { re: /nationals? only|local candidates? only|national recruitment|national position/i, points: -60, label: "May be restricted to national/local candidates" },
  { re: /must have (the )?right to work|eu citizens? only|must be a citizen of/i, points: -60, label: "May require pre-existing right to work" }
];

// Title-level seniority signal. Your CV is 15 years in -- entry-level
// framing should be penalized, not just ignored.
const SENIOR_TITLE_BOOST = [
  /\bcoordinator\b/i, /\bmanager\b/i, /head of base/i, /area manager/i,
  /field coordinator/i, /logistics manager/i, /\bchief\b/i
];
const JUNIOR_TITLE_PENALTY = [/\bassistant\b/i, /\bjunior\b/i];

// Degree/education signals (also feeds into reasons, not a hard filter,
// since "may require" language is often negotiable via equivalent experience).
const EDUCATION_FLAGS = [
  { re: /advanced university degree|master'?s degree.{0,40}(required|essential)/i, points: -20, label: "May require a Master's degree" },
  { re: /bachelor'?s degree.{0,40}(required|essential|mandatory)/i, points: -15, label: "May require a Bachelor's degree" },
  { re: /no need for higher education|high school diploma/i, points: 15, label: "No degree required -- good fit" }
];

const TITLE_MULTIPLIER = 2.5;

// ReliefWeb career categories to search within
const CATEGORIES = ["Logistics/Procurement", "Admin/Finance"];

const MIN_SCORE_TO_KEEP = 40; // matches the "Hide below 40" verdict tier
const MAX_RESULTS = 60;
const API_FETCH_LIMIT = 60;
const MAX_RETRIES = 3;

function verdictFor(score) {
  if (score >= 85) return { label: "Apply immediately", tier: "apply-now" };
  if (score >= 70) return { label: "Strong candidate", tier: "strong" };
  if (score >= 55) return { label: "Worth reviewing", tier: "review" };
  return { label: "Probably skip", tier: "skip" };
}

// ---------------------------------------------------------------------------

function buildSearchUrl() {
  const keywordQuery = Object.keys(POSITIVE_KEYWORDS)
    .map((k) => (k.includes(" ") ? `"${k}"` : k))
    .join(" OR ");

  const params = [
    ["appname", APPNAME],
    ["preset", "latest"], // excludes expired/archived postings
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

  const qs = params
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");

  return `https://api.reliefweb.int/v2/jobs?${qs}`;
}

function scoreJob(title, body) {
  const titleText = (title || "").toLowerCase();
  const bodyText = (body || "").toLowerCase();
  const fullText = `${titleText} ${bodyText}`;

  // Hard reject -- tested against title only. If it hits, stop immediately.
  for (const re of HARD_REJECT_TITLE) {
    if (re.test(titleText)) {
      return { rejected: true };
    }
  }

  let score = 0;
  const reasons = [];

  const add = (points, label) => {
    score += points;
    reasons.push(`${points > 0 ? "+" : "-"} ${label}`);
  };

  // Positive keywords: title matches worth much more than body matches
  for (const [kw, weight] of Object.entries(POSITIVE_KEYWORDS)) {
    if (titleText.includes(kw)) {
      add(Math.round(weight * TITLE_MULTIPLIER), `${kw} (title)`);
    } else if (bodyText.includes(kw)) {
      add(weight, kw);
    }
  }

  // Negative keywords -- same title-weighting logic
  for (const [kw, weight] of Object.entries(NEGATIVE_KEYWORDS)) {
    if (titleText.includes(kw)) {
      add(Math.round(weight * TITLE_MULTIPLIER), `${kw} (title)`);
    } else if (bodyText.includes(kw)) {
      add(weight, kw);
    }
  }

  // Sponsorship / recruitment wording
  for (const { re, points, label } of [...SPONSOR_POSITIVE, ...SPONSOR_NEGATIVE]) {
    if (re.test(fullText)) add(points, label);
  }

  // Education signals
  for (const { re, points, label } of EDUCATION_FLAGS) {
    if (re.test(fullText)) add(points, label);
  }

  // Seniority signal from title
  if (SENIOR_TITLE_BOOST.some((re) => re.test(titleText))) {
    add(10, "senior-level title");
  }
  if (JUNIOR_TITLE_PENALTY.some((re) => re.test(titleText))) {
    add(-25, "junior-level title");
  }

  const clamped = Math.max(0, Math.min(100, score));
  return { rejected: false, score: clamped, reasons, verdict: verdictFor(clamped) };
}

async function fetchWithRetry(url, attempts = MAX_RETRIES) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      console.log(`Attempt ${i}/${attempts}...`);
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`ReliefWeb API returned ${res.status}: ${await res.text()}`);
      }
      return await res.json();
    } catch (err) {
      lastErr = err;
      console.warn(`Attempt ${i} failed: ${err.message}`);
      if (i < attempts) {
        const waitMs = 3000 * i; // 3s, 6s, 9s backoff
        console.log(`Retrying in ${waitMs / 1000}s...`);
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
  }
  throw lastErr;
}

async function main() {
  const url = buildSearchUrl();
  console.log("Querying ReliefWeb:", url);

  const data = await fetchWithRetry(url);
  const items = data.data || [];
  console.log(`Received ${items.length} raw results from ReliefWeb`);

  const scored = items
    .map((item) => {
      const f = item.fields || {};
      const result = scoreJob(f.title, f.body);
      if (result.rejected) return null;
      return {
        title: f.title || "(untitled)",
        org: (f.source && f.source[0] && f.source[0].name) || "Unknown",
        country: (f.country && f.country[0] && f.country[0].name) || "Unspecified",
        url: f.url_alias || `https://reliefweb.int/node/${item.id}`,
        posted: f.date && f.date.created,
        closing: f.date && f.date.closing,
        category: ((f.career_categories || []).map((c) => c.name) || []).join(", "),
        score: result.score,
        verdict: result.verdict,
        reasons: result.reasons
      };
    })
    .filter((j) => j !== null && j.score >= MIN_SCORE_TO_KEEP)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_RESULTS);

  const output = {
    generated_at: new Date().toISOString(),
    source: "ReliefWeb API (live, expired postings excluded by default)",
    count: scored.length,
    jobs: scored
  };

  await writeFile("jobs.json", JSON.stringify(output, null, 2));
  console.log(`Wrote ${scored.length} scored jobs to jobs.json`);
}

main().catch((err) => {
  console.error("fetch-jobs.mjs failed:", err);
  process.exit(1);
});
    
