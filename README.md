# Job Tracker — AI Recruitment Assistant (Phase 1)

Phase 1 upgrade: this no longer does plain keyword matching. It now:

1. Parses your actual CV (PDF/DOCX) into a structured `candidate-profile.json`
   using DeepSeek.
2. For each live ReliefWeb job, extracts a structured job profile (profession,
   management level, years required, degree required, mobility signals) --
   also via DeepSeek.
3. Compares the two structured profiles and scores the match, with full
   explainability (`reasons`), warnings, hard-reject rules, and a national-
   restriction filter.
4. Shows a daily summary (analysed / displayed / hidden / excellent / strong
   / review / average score) and a breakdown of *why* jobs were hidden.

## New setup steps (in addition to the original ones)

1. **Add a DeepSeek API key as a repo secret**:
   Settings → Secrets and variables → Actions → New repository secret →
   Name: `DEEPSEEK_API_KEY` → Value: (your key).

2. **Upload your CV as PDF or DOCX** into `cv/` (not `.doc` -- convert to
   `.docx` first if needed).

3. **Run "Update candidate profile from CV"** from the Actions tab once
   (it also auto-runs whenever you push a new file into `cv/`). This
   generates `data/candidate-profile.json`. Check it looks right --
   right now there's no edit UI yet (that's Phase 2), so to correct a
   mistake you'd edit `data/candidate-profile.json` directly, or fix
   your CV wording and re-run.

4. **Run "Update job listings"** as before. It'll now use your candidate
   profile for real matching instead of generic keywords.

## Architecture

- `scripts/config.mjs` — single source of truth for every rule (hard
  rejects, national restriction phrases, penalised/preferred professions,
  mobility signals, education fields). Nothing else should hardcode a
  keyword list.
- `scripts/lib/deepseek.mjs` — shared API client, JSON-mode enforced.
- `scripts/parse-cv.mjs` — CV → candidate-profile.json.
- `scripts/lib/scoring-engine.mjs` — the actual comparison/scoring logic,
  reusable and unit-testable independent of the ReliefWeb fetch step.
- `scripts/fetch-jobs.mjs` — orchestrates: fetch → cheap pre-filter →
  AI job-profile extraction → score → write jobs.json.

## Cost note

Each daily run makes roughly one DeepSeek call per surviving job (after the
free regex pre-filter removes hard-rejects and national-only postings) plus
one call whenever the CV changes. DeepSeek's pricing is low, but it's not
free -- keep an eye on usage in your DeepSeek account dashboard, especially
if you widen `SEARCH_TERMS` in `fetch-jobs.mjs`.

## What's not built yet (Phase 2/3)

- CV upload page with visible/editable extracted profile
- Apply / Maybe / Reject / Hard Reject buttons + application tracker
  (needs a persistence decision -- see project chat history)
- Preference learning from your decisions
- Favourites/ignore-organisation lists
- Full dashboard (this phase only adds summary cards to the existing list page)
- Multi-source aggregation beyond ReliefWeb

---


## Why this is different from a normal job board bookmark

Regular search engines and job aggregators cache old listings, so you end
up looking at jobs that closed weeks or years ago. This page instead calls
ReliefWeb's own live database directly, which excludes expired listings by
default. A GitHub Actions robot re-runs the check once a day and updates
the page automatically — you never manually search again.

## One-time setup (all doable from your phone in GitHub's web editor)

1. **Create a new repository** on GitHub (public repos get free Pages +
   Actions). Name it whatever you like, e.g. `job-tracker`.

2. **Upload all the files in this project** keeping the exact folder
   structure:
   ```
   index.html
   jobs.json
   scripts/fetch-jobs.mjs
   .github/workflows/update-jobs.yml
   cv/CV_Mark_Fulton.pdf          <-- upload your CV here
   ```
   In GitHub's mobile web editor: tap "Add file" → "Upload files" for each
   one, making sure the folder paths match exactly (GitHub lets you type a
   path like `scripts/fetch-jobs.mjs` when uploading, which creates the
   folder automatically).

3. **Upload your CV as a PDF** into the `cv/` folder, named exactly
   `CV_Mark_Fulton.pdf` (or edit the filename in `index.html`, in the line
   that says `href="cv/CV_Mark_Fulton.pdf"`, to match whatever you name it).

4. **Add your ReliefWeb appname as a secret** (as of Nov 2025, ReliefWeb
   requires a pre-approved appname before the API will respond — this is
   the "API key"-like string ReliefWeb emailed you):
   Settings → Secrets and variables → Actions → "New repository secret" →
   Name: `RELIEFWEB_APPNAME` → Value: (paste the string ReliefWeb gave you,
   e.g. `OpsTrainer-apiintegration-2233ops`) → Add secret.
   It's stored encrypted and never appears in your public code.

5. **Turn on GitHub Pages**:
   Settings → Pages → Source → "Deploy from a branch" → Branch: `main`,
   folder: `/ (root)` → Save.
   Your site will appear at `https://<your-username>.github.io/job-tracker/`
   within a minute or two.

6. **Check Actions is enabled**:
   Settings → Actions → General → make sure "Allow all actions" is selected.

7. **Run the first update manually** (don't wait for tomorrow):
   Go to the "Actions" tab → click "Update job listings" → "Run workflow" →
   "Run workflow" again to confirm. Wait ~30 seconds, refresh, and it should
   show green. Your site will now have live data.

From then on, it re-checks automatically every day at 05:00 UTC. You can
also always trigger it manually from the Actions tab if you want a fresh
check right now.

## Customizing the matching

Open `scripts/fetch-jobs.mjs` and edit:

- `POSITIVE_KEYWORDS` — add/remove/reweight terms that should boost a job's
  score (e.g. add `"bioforce": 4` if you get that certification).
- `FLAG_PATTERNS` — the warning badges shown on each listing (degree
  requirements, nationality restrictions, etc.).
- `CATEGORIES` — which ReliefWeb career categories to search. Currently
  `Logistics/Procurement` and `Admin/Finance`. Full list of categories is
  visible on reliefweb.int/jobs if you want to add more (e.g.
  `Management` or `Program/Project Management`).
- `MIN_SCORE_TO_KEEP` — raise this if you're getting too many low-relevance
  results, lower it if you want to see more borderline matches.

After editing, either wait for the next scheduled run or trigger it
manually from the Actions tab.

## Limitations

- Currently only queries **ReliefWeb**, since it's the one major board with
  a genuinely free, public, real-time API. UN careers.un.org (Inspira) and
  most INGO ATS platforms (Workday, SmartRecruiters etc.) don't offer this,
  so they can't be added the same way without a paid scraping service.
- Scoring is keyword-based, not true CV matching — it's a fast filter, not
  a judgment call. Always read the actual listing before applying.
- If ReliefWeb changes their API structure, the workflow may start failing
  silently. Check the Actions tab occasionally for red ❌ marks.
