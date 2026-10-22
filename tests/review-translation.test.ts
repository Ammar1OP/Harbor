import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

function loadTranslation(safeFetch: (url: string) => Promise<Response>) {
  const mocks: Record<string, unknown> = {
    "@/lib/ai-models": {
      DEFAULT_AI_MODEL: "fixture",
      migrateModelId: (id: string) => id,
      supportsSampling: () => true,
    },
    "@/lib/config/endpoints": { HARBOR_API_BASE: "https://example.invalid" },
    "@/lib/i18n": { LANGUAGES: [{ code: "ar", label: "Arabic" }] },
    "@/lib/safe-fetch": { safeFetch },
  };
  const source = readFileSync("src/lib/review-translation.ts", "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exports = {} as typeof import("../src/lib/review-translation");
  new Function("require", "exports", compiled)((name: string) => {
    assert.ok(name in mocks, `unexpected import ${name}`);
    return mocks[name];
  }, exports);
  return exports;
}

test("without an AI key, reviews go through Google and are cached", async () => {
  const requests: string[] = [];
  const { translateReviews, cachedReviewTranslation } = loadTranslation(async (url) => {
    requests.push(url);
    const q = new URL(url).searchParams.get("q");
    return new Response(JSON.stringify([[[`ar:${q}`, q]]]));
  });

  assert.deepEqual(await translateReviews(["Great film", "  "], "ar", null), [
    "ar:Great film",
    null,
  ]);
  assert.equal(new URL(requests[0]!).searchParams.get("tl"), "ar");
  assert.equal(cachedReviewTranslation("Great film", "ar"), "ar:Great film");

  await translateReviews(["Great film"], "ar", null);
  assert.equal(requests.length, 1);
});

test("a failed translation comes back as null", async () => {
  const { translateReviews } = loadTranslation(async () => new Response("", { status: 429 }));
  assert.deepEqual(await translateReviews(["Slow but rewarding"], "ar", null), [null]);
});

test("long reviews without paragraph breaks are split near the chunk limit", () => {
  const { translationChunks } = loadTranslation(async () => new Response(""));
  const sentence = "This episode builds tension slowly and pays it off. ";
  const text = sentence.repeat(Math.ceil(12_500 / sentence.length)).trim();
  const chunks = translationChunks(text);
  assert.ok(chunks.length >= 4, `only ${chunks.length} chunks`);
  for (const chunk of chunks) assert.ok(chunk.text.length <= 3500, `${chunk.text.length} chars`);
  // Pieces of one paragraph rejoin with the space they were cut at, not a paragraph break.
  assert.equal(chunks.map((c) => c.glue + c.text).join(""), text);
  assert.ok(chunks.slice(0, -1).every((c) => c.text.endsWith(".")));
});

test("a single word longer than the limit is still cut", () => {
  const { translationChunks } = loadTranslation(async () => new Response(""));
  const text = "x".repeat(8000);
  const chunks = translationChunks(text);
  assert.deepEqual(
    chunks.map((c) => c.text.length),
    [3500, 3500, 1000],
  );
  assert.equal(chunks.map((c) => c.glue + c.text).join(""), text);
});

test("short paragraphs still share a request", () => {
  const { translationChunks } = loadTranslation(async () => new Response(""));
  assert.deepEqual(translationChunks("One.\n\nTwo."), [{ text: "One.\n\nTwo.", glue: "" }]);
});
