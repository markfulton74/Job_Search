/**
 * deepseek.mjs
 *
 * Thin wrapper around DeepSeek's OpenAI-compatible chat completions API.
 * Used by both the CV parser and the job parser to turn messy text into
 * structured JSON.
 */

const API_URL = "https://api.deepseek.com/chat/completions";

function getApiKey() {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) {
    throw new Error(
      "DEEPSEEK_API_KEY environment variable is not set. " +
      "Add it as a repo secret (Settings > Secrets and variables > Actions)."
    );
  }
  return key;
}

/**
 * Calls DeepSeek and returns a parsed JSON object.
 * @param {string} systemPrompt - instructions, must tell the model to return ONLY JSON
 * @param {string} userContent - the text to analyse
 * @param {number} maxRetries
 */
export async function askForJson(systemPrompt, userContent, maxRetries = 3) {
  const apiKey = getApiKey();
  let lastErr;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: "deepseek-chat",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userContent }
          ],
          temperature: 0,
          response_format: { type: "json_object" }
        })
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`DeepSeek API returned ${res.status}: ${text}`);
      }

      const data = await res.json();
      const raw = data.choices?.[0]?.message?.content;
      if (!raw) throw new Error("DeepSeek response had no content");

      // Guard against stray markdown fences even though we asked for JSON mode
      const cleaned = raw.replace(/```json|```/g, "").trim();
      return JSON.parse(cleaned);
    } catch (err) {
      lastErr = err;
      console.warn(`DeepSeek attempt ${attempt}/${maxRetries} failed: ${err.message}`);
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
  }
  throw lastErr;
}
