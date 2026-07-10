#!/usr/bin/env node
/**
 * parse-cv.mjs
 *
 * Finds the CV file in cv/ (PDF or DOCX), extracts raw text, and asks
 * DeepSeek to turn it into a structured candidate-profile.json.
 *
 * Run this whenever the CV changes. The daily job-fetching workflow does
 * NOT re-run this automatically (parsing costs an API call and the CV
 * doesn't change daily) -- it's triggered separately, see
 * .github/workflows/update-profile.yml
 */

import { readFile, writeFile, readdir } from "fs/promises";
import { extname, join } from "path";
import { askForJson } from "./lib/deepseek.mjs";

const CV_DIR = "cv";
const OUTPUT_PATH = "data/candidate-profile.json";

async function findCvFile() {
  const files = await readdir(CV_DIR);
  const cvFile = files.find((f) => /\.(pdf|docx?)$/i.test(f));
  if (!cvFile) {
    throw new Error(`No PDF or DOCX file found in ${CV_DIR}/. Upload your CV there.`);
  }
  return join(CV_DIR, cvFile);
}

async function extractText(filePath) {
  const ext = extname(filePath).toLowerCase();
  const buffer = await readFile(filePath);

  if (ext === ".pdf") {
    const pdfParse = (await import("pdf-parse")).default;
    const result = await pdfParse(buffer);
    return result.text;
  }

  if (ext === ".docx") {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }

  if (ext === ".doc") {
    throw new Error(
      "Legacy .doc format isn't supported by the parser. Please save/export the CV as .docx or .pdf and re-upload."
    );
  }

  throw new Error(`Unsupported CV file extension: ${ext}`);
}

const SYSTEM_PROMPT = `You are an expert humanitarian sector recruitment analyst.
Read the candidate's CV text and extract a structured profile as JSON.
Only use information present in the CV. Do not invent or assume anything not stated.
Return ONLY a JSON object with exactly this shape:

{
  "years_experience_total": number,
  "years_experience_by_function": { "logistics": number, "fleet": number, "procurement": number, "administration": number, "other_relevant": number },
  "management_level": "entry" | "officer" | "coordinator" | "manager" | "senior_manager" | "director",
  "years_supervisory_experience": number,
  "max_team_size_managed": number,
  "functions": [array of strings, e.g. "logistics", "fleet management", "procurement", "compliance"],
  "countries_worked": [array of country names],
  "organisations": [array of organisation names],
  "technical_skills": [array of strings],
  "languages": [array of strings],
  "education": { "highest_level": "none" | "high_school" | "diploma" | "bachelor" | "master" | "phd", "fields": [array of strings], "institutions": [array of strings] },
  "certifications": [array of strings],
  "post_conflict_or_emergency_experience": boolean,
  "peacekeeping_mission_experience": boolean,
  "preferred_job_families": [array of strings, inferred from career history -- e.g. "logistics", "operations", "supply chain"],
  "summary": "one paragraph plain-language summary of the candidate's profile for recruitment matching purposes"
}`;

async function main() {
  const cvPath = await findCvFile();
  console.log(`Reading CV from: ${cvPath}`);

  const text = await extractText(cvPath);
  if (!text || text.trim().length < 100) {
    throw new Error("Extracted CV text looks too short -- check the file isn't a scanned image PDF with no selectable text.");
  }
  console.log(`Extracted ${text.length} characters of CV text`);

  console.log("Asking DeepSeek to build structured profile...");
  const profile = await askForJson(SYSTEM_PROMPT, text);

  const output = {
    generated_at: new Date().toISOString(),
    source_file: cvPath,
    profile
  };

  await writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`Wrote candidate profile to ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error("parse-cv.mjs failed:", err);
  process.exit(1);
});
