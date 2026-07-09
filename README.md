# Job Tracker

A single-page site that checks the ReliefWeb API **every day, automatically,
for free**, and shows you only currently-open Logistics/Procurement and
Admin/Finance jobs, scored against your CV. No server, no cost, works
entirely on GitHub's free tier.

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
