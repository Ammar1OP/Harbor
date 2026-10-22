import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

function load<T>(path: string, mocks: Record<string, unknown>): T {
  const compiled = ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const exports = {} as T;
  new Function("require", "exports", compiled)((name: string) => {
    assert.ok(name in mocks, `unexpected import ${name}`);
    return mocks[name];
  }, exports);
  return exports;
}

const lib = () =>
  load<typeof import("../src/lib/episode-reviews")>("src/lib/episode-reviews.ts", {
    "@/lib/safe-fetch": { safeFetch: async () => new Response("{}") },
    "@/lib/trakt/comments": { fetchComments: async () => [] },
  });

test("episode reviews target the series' IMDb id and IMDb numbering", () => {
  const { episodeReviewsTarget } = lib();
  assert.deepEqual(episodeReviewsTarget("tt0903747", 1, 1), {
    imdbId: "tt0903747",
    season: 1,
    episode: 1,
  });
  // Season 0 (specials) is a real IMDb season.
  assert.deepEqual(episodeReviewsTarget("tt0903747", 0, 2), {
    imdbId: "tt0903747",
    season: 0,
    episode: 2,
  });
  assert.equal(episodeReviewsTarget("kitsu:1376", 1, 1), undefined);
  assert.equal(episodeReviewsTarget("tt0903747", undefined, 1), undefined);
  assert.equal(episodeReviewsTarget(null, 1, 1), undefined);
});

test("a spoiler review hides its title along with its body", () => {
  const icon = () => null;
  const { ReviewCard } = load<{ ReviewCard: React.FC<any> }>(
    "src/views/detail/episode-reviews-dialog.tsx",
    {
      react: React,
      "react/jsx-runtime": jsxRuntime,
      "lucide-react": {
        ExternalLink: icon,
        Heart: icon,
        Loader2: icon,
        MessageSquareText: icon,
        Star: icon,
        X: icon,
      },
      "@/components/hover-tooltip": { HoverTooltip: ({ children }: any) => children },
      "@/components/modal-shell": {},
      "@/lib/i18n": { useT: () => (text: string) => text },
      "@/lib/window": { openUrl: () => {} },
      "@/lib/episode-reviews": {},
      "./review-translation": { ReviewTranslateButton: () => null },
    },
  );
  const review = {
    id: "imdb:rw1",
    source: "imdb",
    author: "fixture",
    avatar: null,
    rating: 9,
    date: null,
    likes: 0,
    title: "Walt dies at the end",
    text: "Body text",
    spoiler: true,
    url: null,
  };
  const html = renderToStaticMarkup(
    React.createElement(ReviewCard, {
      review,
      tr: { display: (text: string) => text },
    }),
  );
  const hidden = html.slice(html.indexOf('aria-hidden="true"'));
  assert.ok(html.includes('class="select-none blur-[6px]" aria-hidden="true"'), html);
  assert.ok(hidden.indexOf("Walt dies at the end") > 0, "the title sits inside the blurred block");
  assert.ok(hidden.indexOf("Body text") > hidden.indexOf("Walt dies at the end"));
});
