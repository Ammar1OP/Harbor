import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { JSDOM } from "jsdom";
import ts from "typescript";

async function openDetails({
  active = true,
  type = "movie",
  imdbId = "tt0111161",
  full = false,
}: { active?: boolean; type?: string; imdbId?: string | null; full?: boolean } = {}) {
  const requests: string[] = [];
  const openedUrls: string[] = [];
  const effects: (() => void)[] = [];
  const mocks: Record<string, unknown> = {
    react: {
      ...React,
      useState: (initial: unknown) => [initial, () => {}],
      useCallback: (fn: unknown) => fn,
      useEffect: (fn: () => void) => effects.push(fn),
    },
    "react/jsx-runtime": jsxRuntime,
    "lucide-react": {},
    "@/components/hover-tooltip": {},
    "@/lib/stremboxd/provider": {
      useLetterboxd: () => ({ isActive: active, isFullConnected: full, username: "fixture" }),
    },
    "@/lib/stremboxd/client": {
      fetchLetterboxdReviewsDirect: async (id: string) => {
        requests.push(`reviews:${id}`);
        return { reviews: [], hasNext: false };
      },
      fetchLetterboxdFriendsReviews: async (_username: string, id: string) => {
        requests.push(`friends:${id}`);
        return [];
      },
    },
    "@/lib/window": { openUrl: (url: string) => openedUrls.push(url) },
    "@/lib/i18n": { useT: () => (text: string) => text, useUiLanguage: () => "en", LANGUAGES: [] },
    "@/lib/settings": { useSettings: () => ({ settings: {} }) },
    "./review-translation": {
      useReviewTranslator: () => ({ display: (text: string) => text }),
      ReviewTranslateBar: () => null,
      ReviewTranslateButton: () => null,
    },
  };
  const source = readFileSync("src/views/detail/letterboxd-reviews.tsx", "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const exports = {} as { LetterboxdReviews: React.ElementType };
  new Function("require", "exports", compiled)((name: string) => {
    assert.ok(name in mocks, `unexpected import ${name}`);
    return mocks[name];
  }, exports);

  // Mount the wrapper and boundary so effects only run for mounted children.
  function mount(node: any): void {
    if (!node) return;
    if (Array.isArray(node)) return node.forEach(mount);
    if (typeof node.type === "function") {
      mount(
        node.type.prototype?.render ? new node.type(node.props).render() : node.type(node.props),
      );
    } else {
      mount(node.props?.children);
    }
  }
  mount(React.createElement(exports.LetterboxdReviews, { meta: { id: "fixture", type }, imdbId }));
  effects.forEach((effect) => effect());
  await new Promise<void>((resolve) => setImmediate(resolve));
  return { requests, openedUrls };
}

test("opening details with Letterboxd disabled makes no review requests", async () => {
  assert.deepEqual(await openDetails({ active: false, full: true }), {
    requests: [],
    openedUrls: [],
  });
});

test("opening series details makes no Letterboxd review requests", async () => {
  assert.deepEqual(await openDetails({ type: "series", full: true }), {
    requests: [],
    openedUrls: [],
  });
});

test("enabled film details load reviews without opening an external page", async () => {
  assert.deepEqual(await openDetails({ full: true }), {
    requests: ["reviews:tt0111161", "friends:tt0111161"],
    openedUrls: [],
  });
});

test("film details without an IMDb ID do not request Letterboxd reviews", async () => {
  assert.deepEqual(await openDetails({ imdbId: null }), { requests: [], openedUrls: [] });
});

for (const status of [403, 404, 503]) {
  test(`the actual friends-review client returns no reviews on HTTP ${status}`, async () => {
    const requests: string[] = [];
    const mocks: Record<string, unknown> = {
      "@/lib/safe-fetch": {
        safeFetch: async (url: string) => {
          requests.push(url);
          return requests.length === 1
            ? new Response(
                '<link rel="canonical" href="https://letterboxd.com/film/practical-magic/">',
              )
            : new Response("<title>Just a moment...</title>", { status });
        },
      },
      "./config": { STREMBOXD_BASE: "https://example.invalid" },
      "./cache": {},
    };
    const source = readFileSync("src/lib/stremboxd/client.ts", "utf8");
    const compiled = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS },
    }).outputText;
    const exports = {} as typeof import("../src/lib/stremboxd/client");
    new Function("require", "exports", compiled)((name: string) => {
      assert.ok(name in mocks, `unexpected import ${name}`);
      return mocks[name];
    }, exports);

    assert.deepEqual(await exports.fetchLetterboxdFriendsReviews("fixture", "tt0120791"), []);
    assert.deepEqual(requests, [
      "https://letterboxd.com/imdb/tt0120791/",
      "https://letterboxd.com/fixture/friends/film/practical-magic/reviews/",
    ]);
  });
}

function loadClient(safeFetch: (url: string) => Promise<Response>) {
  globalThis.DOMParser ??= new JSDOM().window.DOMParser;
  const mocks: Record<string, unknown> = {
    "@/lib/safe-fetch": { safeFetch },
    "./config": { STREMBOXD_BASE: "https://example.invalid" },
    "./cache": {},
  };
  const source = readFileSync("src/lib/stremboxd/client.ts", "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exports = {} as typeof import("../src/lib/stremboxd/client");
  new Function("require", "exports", compiled)((name: string) => {
    assert.ok(name in mocks, `unexpected import ${name}`);
    return mocks[name];
  }, exports);
  return exports;
}

const review = (author: string, stars: string, text: string) =>
  `<article class="production-viewing"><a class="avatar" href="/${author}/"></a><span class="displayname">${author}</span><span class="inline-rating"><svg aria-label="${stars}"></svg></span><div class="js-review-body" lang="en"><p>${text}</p></div></article>`;

test("blocked review pages fall back to the film page and sort its reviews here", async () => {
  const requests: string[] = [];
  const client = loadClient(async (url) => {
    requests.push(url);
    if (url.endsWith("/imdb/tt0120791/")) {
      return new Response(
        `<link rel="canonical" href="https://letterboxd.com/film/practical-magic/">${review("a", "★★★★★", "Loved it")}${review("b", "★½", "Not for me at all")}${review("c", "★★★", "Fine")}`,
      );
    }
    return new Response("<title>Just a moment...</title>", { status: 403 });
  });

  const lowest = await client.fetchLetterboxdReviewsDirect("tt0120791", 1, "lowest");
  assert.deepEqual(
    lowest.reviews.map((r) => r.author),
    ["b", "c", "a"],
  );
  assert.deepEqual(requests, [
    "https://letterboxd.com/imdb/tt0120791/",
    "https://letterboxd.com/film/practical-magic/reviews/by/entry-rating-lowest/",
  ]);

  const longest = await client.fetchLetterboxdReviewsDirect("tt0120791", 1, "longest");
  assert.deepEqual(
    longest.reviews.map((r) => r.author),
    ["b", "a", "c"],
  );
});

test("Letterboxd star labels read as numbers", () => {
  const client = loadClient(async () => new Response(""));
  assert.equal(client.letterboxdStars("★★★½"), 3.5);
  assert.equal(client.letterboxdStars("½"), 0.5);
  assert.equal(client.letterboxdStars(null), null);
});
