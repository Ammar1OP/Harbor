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
