import { DEFAULT_AI_MODEL, migrateModelId, supportsSampling } from "@/lib/ai-models";
import { HARBOR_API_BASE } from "@/lib/config/endpoints";
import { LANGUAGES, type UiLanguage } from "@/lib/i18n";
import { safeFetch } from "@/lib/safe-fetch";

// Translates user reviews (Letterboxd, IMDb, Trakt). Uses the AI Search key when one is set, for
// translations that read naturally, and Google's public translate endpoint otherwise or when the
// model fails.

export type ReviewTranslationAi = { key: string; model: string; groq: boolean };

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GOOGLE_URL = "https://translate.googleapis.com/translate_a/single";
// Google's endpoint takes the text in the query string, so long reviews go in chunks.
const GOOGLE_CHUNK = 3500;
const AI_BATCH = 8;

const languageName = Object.fromEntries(
  LANGUAGES.map(({ code, label }) => [code, label]),
) as Record<UiLanguage, string>;
const cache = new Map<string, string>();
const cacheKey = (text: string, to: UiLanguage) => `${to}\u0000${text}`;

export function cachedReviewTranslation(text: string, to: UiLanguage): string | null {
  return cache.get(cacheKey(text, to)) ?? null;
}

function chunks(text: string): string[] {
  const out: string[] = [];
  let current = "";
  for (const paragraph of text.split(/\n{2,}/)) {
    if (current && current.length + paragraph.length > GOOGLE_CHUNK) {
      out.push(current);
      current = "";
    }
    current = current ? `${current}\n\n${paragraph}` : paragraph;
  }
  if (current) out.push(current);
  return out;
}

async function googleTranslate(text: string, to: UiLanguage): Promise<string | null> {
  // Google names Simplified Chinese "zh-CN".
  const target = to === "zh" ? "zh-CN" : to;
  const parts: string[] = [];
  for (const chunk of chunks(text)) {
    const params = new URLSearchParams({
      client: "gtx",
      sl: "auto",
      tl: target,
      dt: "t",
      q: chunk,
    });
    const res = await safeFetch(`${GOOGLE_URL}?${params}`).catch(() => null);
    if (!res?.ok) return null;
    const data = (await res.json().catch(() => null)) as [Array<[string]>] | null;
    if (!Array.isArray(data?.[0])) return null;
    parts.push(data[0].map((segment) => segment[0]).join(""));
  }
  return parts.join("\n\n");
}

async function aiTranslate(
  texts: string[],
  to: UiLanguage,
  ai: ReviewTranslationAi,
): Promise<(string | null)[]> {
  const model = migrateModelId(ai.model.trim()) || DEFAULT_AI_MODEL;
  const language = languageName[to];
  const headers: Record<string, string> = {
    Authorization: `Bearer ${ai.key.trim()}`,
    "Content-Type": "application/json",
  };
  if (!ai.groq) {
    headers["HTTP-Referer"] = HARBOR_API_BASE;
    headers["X-Title"] = "Harbor";
  }
  const res = await fetch(ai.groq ? GROQ_URL : OPENROUTER_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      ...(supportsSampling(model) ? { temperature: 0.2 } : {}),
      max_tokens: 6000,
      messages: [
        {
          role: "system",
          content: `You translate film and TV reviews into ${language}. Write natural, fluent ${language} the way a native critic would, keeping names, paragraph breaks, tone and meaning. Each review is wrapped in <rN>…</rN>; answer with every review translated inside the same tags and nothing else.`,
        },
        {
          role: "user",
          content: texts.map((text, i) => `<r${i + 1}>${text}</r${i + 1}>`).join("\n"),
        },
      ],
    }),
  }).catch(() => null);
  if (!res?.ok) return texts.map(() => null);
  const data = (await res.json().catch(() => null)) as {
    choices?: Array<{ message?: { content?: string } }>;
  } | null;
  const content = data?.choices?.[0]?.message?.content ?? "";
  return texts.map((_, i) => {
    const match = content.match(new RegExp(`<r${i + 1}>([\\s\\S]*?)</r${i + 1}>`));
    return match?.[1]?.trim() || null;
  });
}

/** Translations for each text, in order; null where every translator failed. */
export async function translateReviews(
  texts: string[],
  to: UiLanguage,
  ai: ReviewTranslationAi | null,
): Promise<(string | null)[]> {
  const result = texts.map((text) => cachedReviewTranslation(text, to));
  const missing = texts.map((_, i) => i).filter((i) => result[i] == null && texts[i]!.trim());
  if (ai?.key.trim()) {
    for (let start = 0; start < missing.length; start += AI_BATCH) {
      const batch = missing.slice(start, start + AI_BATCH);
      const translated = await aiTranslate(
        batch.map((i) => texts[i]!),
        to,
        ai,
      );
      batch.forEach((index, i) => (result[index] = translated[i] ?? null));
    }
  }
  await Promise.all(
    missing
      .filter((i) => result[i] == null)
      .map(async (i) => {
        result[i] = await googleTranslate(texts[i]!, to);
      }),
  );
  texts.forEach((text, i) => {
    const translated = result[i];
    if (translated) cache.set(cacheKey(text, to), translated);
  });
  return result;
}
