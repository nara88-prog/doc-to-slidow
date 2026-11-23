/**
 * electron/summarizer/ollama.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Optional Ollama LLM upgrade path.
 * Calls http://localhost:11434 (Ollama's default local port).
 * If Ollama is not running, `isOllamaAvailable()` returns false and no error
 * is thrown — the caller falls back to the extractive summarizer.
 *
 * Uses Node's built-in `fetch` (Node 18+) — no extra HTTP library needed.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const OLLAMA_URL = 'http://localhost:11434';
const OLLAMA_MODEL = 'mistral'; // change to any locally-pulled model

let ollamaChecked = false;
let ollamaPresent = false;

/** Check once whether Ollama is reachable on localhost. */
export async function isOllamaAvailable(): Promise<boolean> {
  if (ollamaChecked) return ollamaPresent;
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, {
      signal: AbortSignal.timeout(1_500),
    });
    ollamaPresent = res.ok;
  } catch {
    ollamaPresent = false;
  }
  ollamaChecked = true;
  return ollamaPresent;
}

/**
 * Summarize text using a locally-running Ollama model.
 * Throws if the request fails; caller must handle and fall back.
 */
export async function ollamaSummarize(text: string): Promise<string> {
  const prompt =
    `Summarize the following document in 5–8 concise, bullet-free sentences ` +
    `that capture the key points. Use plain English. Output only the summary.\n\n` +
    text.slice(0, 8000); // token safety cap

  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
  const json = (await res.json()) as { response: string };
  return json.response.trim();
}
