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
// Edit freely -- e.g. add "Bioforce" or remove "aviation" if not relevant.
const POSITIVE_KEYWORDS = {
  "fleet": 8,
  "logistics": 8,
  "procurement": 7,
  "supply chain": 7,
  "movement control": 10,
  "transport": 6,
  "administration": 5,
  "compliance": 6,
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

// Phrases that get surfaced as flags for you to check manually.
// These do NOT exclude a job -- they just warn you before you spend time on it.
const FLAG_PATTERNS = [
  { re: /nationals? only|local candidates? only|national recruitment|national position/i,
    label: "May be restricted to national/local candidates" },
  { re: /advanced university degree|master'?s degree.{0,40}(required|essential)/i,
    label: "May require a Master's degree" },
  { re: /bachelor'?s degree.{0,40}(required|essential|mandatory)/i,
    label: "May require a Bachelor's degree" },
  { re: /no need for higher education|high school diploma/i,
    label: "No degree required -- good fit" },
  { re: /internationally recruited/i,
    label: "Internationally recruited -- good fit" }
];

// ReliefWeb career categories to search within
const CATEGORIES = ["Logistics/Procurement", "Admin/Finance"];

const MIN_SCORE_TO_KEEP = 15;
const MAX_RESULTS = 60;       // how many scored jobs to keep in jobs.json
const API_FETCH_LIMIT = 60;   // how many raw jobs to request per API call (smaller = less likely to time out)
const MAX_RETRIES = 3;

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
  const text = `${title || ""} ${body || ""}`.toLowerCase();
  let score = 0;
  for (const [kw, weight] of Object.entries(POSITIVE_KEYWORDS)) {
    if (text.includes(kw)) score += weight;
  }
  const flags = [];
  for (const { re, label } of FLAG_PATTERNS) {
    if (re.test(text)) flags.push(label);
  }
  return { score: Math.min(score, 100), flags };
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
      const { score, flags } = scoreJob(f.title, f.body);
      return {
        title: f.title || "(untitled)",
        org: (f.source && f.source[0] && f.source[0].name) || "Unknown",
        country: (f.country && f.country[0] && f.country[0].name) || "Unspecified",
        url: f.url_alias || `https://reliefweb.int/node/${item.id}`,
        posted: f.date && f.date.created,
        closing: f.date && f.date.closing,
        category: ((f.career_categories || []).map((c) => c.name) || []).join(", "),
        score,
        flags
      };
    })
    .filter((j) => j.score >= MIN_SCORE_TO_KEEP)
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
