import { safeFetch } from "@/lib/safe-fetch";
import { fetchComments } from "@/lib/trakt/comments";

// Reviews for a single episode, merged from two public sources:
//  - IMDb user reviews of the episode itself (each with the reviewer's /10 rating), read from
//    IMDb's public GraphQL endpoint;
//  - Trakt comments on the episode (with the commenter's own rating), through Harbor's
//    existing Trakt client.
// Both are read a page at a time, so the dialog only asks for more when the reader does.

export type EpisodeReviewSource = "imdb" | "trakt";

export type EpisodeReview = {
  id: string;
  source: EpisodeReviewSource;
  author: string;
  avatar: string | null;
  /** 1-10, when the reviewer rated the episode. */
  rating: number | null;
  date: string | null;
  likes: number;
  title: string;
  text: string;
  spoiler: boolean;
  url: string | null;
};

export type EpisodeReviewSort = "liked" | "recent" | "highest" | "lowest" | "longest";

/** Where the next page of each source starts; null once that source is exhausted. */
export type EpisodeReviewsCursor = {
  /** The IMDb review list's cursor, or "" for its first page. */
  imdb: string | null;
  /** The next Trakt comments page, counted from 1. */
  trakt: number | null;
};

export type EpisodeReviewsPage = {
  reviews: EpisodeReview[];
  /** Null when both sources are exhausted. */
  next: EpisodeReviewsCursor | null;
};

const IMDB_GRAPHQL = "https://api.graphql.imdb.com/";
const IMDB_PAGE = 25;
const TRAKT_PAGE = 25;
const IMDB_EPISODE_PAGE = 250;
const IMDB_EPISODE_PAGES = 8;

async function imdbQuery<T>(query: string): Promise<T | null> {
  try {
    const res = await safeFetch(IMDB_GRAPHQL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-imdb-client-name": "imdb-web-next-localized",
      },
      body: JSON.stringify({ query }),
    });
    if (!res.ok) return null;
    return ((await res.json()) as { data?: T }).data ?? null;
  } catch {
    return null;
  }
}

const IMDB_ID = /^tt\d+$/;
// GraphQL values are written into the query, so only well-formed ones get that far.
const validNumber = (n: number | null | undefined, min: number): n is number =>
  Number.isInteger(n) && n! >= min && n! <= 100_000;
const validCursor = (cursor: string) => /^[\w+/=-]*$/.test(cursor);

/** Where an episode's reviews are found: the series' IMDb id and IMDb's own numbering. */
export function episodeReviewsTarget(
  imdbId: string | null | undefined,
  season: number | null | undefined,
  episode: number | null | undefined,
): { imdbId: string; season: number; episode: number } | undefined {
  return imdbId && IMDB_ID.test(imdbId) && validNumber(season, 0) && validNumber(episode, 1)
    ? { imdbId, season, episode }
    : undefined;
}

// Only complete season lists are kept: a failed page leaves nothing cached, so the next
// lookup tries again instead of believing the episode doesn't exist.
const seasonEpisodes = new Map<string, Map<string, string>>();

/** IMDb id of an episode, from the series' IMDb id. Follows the season list's pages. */
export async function imdbEpisodeId(
  seriesImdbId: string,
  season: number,
  episode: number,
): Promise<string | null> {
  if (!episodeReviewsTarget(seriesImdbId, season, episode)) return null;
  const key = `${seriesImdbId}:${season}`;
  const cached = seasonEpisodes.get(key);
  if (cached) return cached.get(String(episode)) ?? null;
  type Data = {
    title?: {
      episodes?: {
        episodes?: {
          pageInfo?: { hasNextPage?: boolean; endCursor?: string };
          edges: {
            node: {
              id: string;
              series?: { displayableEpisodeNumber?: { episodeNumber?: { text?: string } } };
            };
          }[];
        };
      };
    };
  };
  const byNumber = new Map<string, string>();
  let after = "";
  for (let page = 0; page < IMDB_EPISODE_PAGES; page++) {
    const data = await imdbQuery<Data>(
      `{ title(id:"${seriesImdbId}"){ episodes{ episodes(first:${IMDB_EPISODE_PAGE}${after ? `, after:"${after}"` : ""}, filter:{includeSeasons:["${season}"]}){ pageInfo{hasNextPage endCursor} edges{ node{ id series{ displayableEpisodeNumber{ episodeNumber{text} } } } } } } } }`,
    );
    const list = data?.title?.episodes?.episodes;
    if (!list) return null;
    for (const { node } of list.edges) {
      const n = node.series?.displayableEpisodeNumber?.episodeNumber?.text;
      if (n && IMDB_ID.test(node.id)) byNumber.set(n, node.id);
    }
    const found = byNumber.get(String(episode));
    const cursor = list.pageInfo?.endCursor ?? "";
    if (!list.pageInfo?.hasNextPage || !cursor || !validCursor(cursor)) {
      if (byNumber.size) seasonEpisodes.set(key, byNumber);
      return found ?? null;
    }
    // Found before the end: answer now, but don't cache a season we haven't read to the end.
    if (found) return found;
    after = cursor;
  }
  return byNumber.get(String(episode)) ?? null;
}

type ImdbReviewNode = {
  id: string;
  author?: { nickName?: string };
  authorRating?: number | null;
  summary?: { originalText?: string };
  text?: { originalText?: { plainText?: string } };
  submissionDate?: string;
  helpfulness?: { upVotes?: number };
  spoiler?: boolean;
};

async function imdbReviewsPage(
  episodeImdbId: string,
  after: string,
): Promise<{ reviews: EpisodeReview[]; next: string | null }> {
  if (!IMDB_ID.test(episodeImdbId) || !validCursor(after)) return { reviews: [], next: null };
  type Data = {
    title?: {
      reviews?: {
        pageInfo?: { hasNextPage?: boolean; endCursor?: string };
        edges: { node: ImdbReviewNode }[];
      };
    };
  };
  const data = await imdbQuery<Data>(
    `{ title(id:"${episodeImdbId}"){ reviews(first:${IMDB_PAGE}${after ? `, after:"${after}"` : ""}, sort:{by:HELPFULNESS_SCORE, order:DESC}){ pageInfo{hasNextPage endCursor} edges{ node{ id author{nickName} authorRating summary{originalText} text{originalText{plainText}} submissionDate helpfulness{upVotes} spoiler } } } } }`,
  );
  const list = data?.title?.reviews;
  if (!list) return { reviews: [], next: null };
  const reviews = list.edges.map(({ node }): EpisodeReview => ({
    id: `imdb:${node.id}`,
    source: "imdb",
    author: node.author?.nickName || "IMDb",
    avatar: null,
    rating: node.authorRating ?? null,
    date: node.submissionDate ?? null,
    likes: node.helpfulness?.upVotes ?? 0,
    title: node.summary?.originalText ?? "",
    text: node.text?.originalText?.plainText ?? "",
    spoiler: !!node.spoiler,
    url: `https://www.imdb.com/review/${node.id}/`,
  }));
  const cursor = list.pageInfo?.endCursor ?? "";
  return { reviews, next: list.pageInfo?.hasNextPage && cursor ? cursor : null };
}

async function traktCommentsPage(
  seriesImdbId: string,
  season: number,
  episode: number,
  page: number,
): Promise<{ reviews: EpisodeReview[]; next: number | null }> {
  const target = {
    kind: "episode" as const,
    show: { ids: { imdb: seriesImdbId } },
    season,
    number: episode,
  };
  const comments = await fetchComments(target, "likes", page, TRAKT_PAGE);
  const reviews = comments.map((c): EpisodeReview => ({
    id: `trakt:${c.id}`,
    source: "trakt",
    author: c.user.name || c.user.username,
    avatar: c.user.avatar,
    rating: c.userRating,
    date: c.createdAt,
    likes: c.likes,
    title: "",
    text: c.comment,
    spoiler: c.spoiler,
    url: `https://trakt.tv/comments/${c.id}`,
  }));
  return { reviews, next: comments.length < TRAKT_PAGE ? null : page + 1 };
}

const FIRST_PAGE: EpisodeReviewsCursor = { imdb: "", trakt: 1 };

/**
 * One page of an episode's reviews from each source still going; start without a cursor.
 * `episodeImdbId`, when the caller already knows the episode's own IMDb id, skips the lookup.
 */
export async function fetchEpisodeReviews(
  seriesImdbId: string,
  season: number,
  episode: number,
  cursor: EpisodeReviewsCursor = FIRST_PAGE,
  episodeImdbId?: string | null,
): Promise<EpisodeReviewsPage> {
  if (!episodeReviewsTarget(seriesImdbId, season, episode)) return { reviews: [], next: null };
  const [imdb, trakt] = await Promise.all([
    cursor.imdb == null
      ? { reviews: [], next: null }
      : (episodeImdbId && IMDB_ID.test(episodeImdbId)
          ? Promise.resolve(episodeImdbId)
          : imdbEpisodeId(seriesImdbId, season, episode)
        )
          .then((id) => (id ? imdbReviewsPage(id, cursor.imdb!) : { reviews: [], next: null }))
          .catch(() => ({ reviews: [], next: null })),
    cursor.trakt == null
      ? { reviews: [], next: null }
      : traktCommentsPage(seriesImdbId, season, episode, cursor.trakt).catch(() => ({
          reviews: [],
          next: null,
        })),
  ]);
  const next = { imdb: imdb.next, trakt: trakt.next };
  return {
    reviews: [...imdb.reviews, ...trakt.reviews].filter((r) => r.text.trim()),
    next: next.imdb == null && next.trakt == null ? null : next,
  };
}

/** Mean of the reviewers' own ratings, 1-10. */
export function reviewersAverage(reviews: EpisodeReview[]): number | null {
  const ratings = reviews.map((r) => r.rating).filter((v): v is number => v != null);
  return ratings.length ? ratings.reduce((a, b) => a + b, 0) / ratings.length : null;
}

export function sortEpisodeReviews(
  reviews: EpisodeReview[],
  sort: EpisodeReviewSort,
): EpisodeReview[] {
  const time = (r: EpisodeReview) => (r.date ? Date.parse(r.date) || 0 : 0);
  const key: Record<EpisodeReviewSort, (a: EpisodeReview, b: EpisodeReview) => number> = {
    liked: (a, b) => b.likes - a.likes,
    recent: (a, b) => time(b) - time(a),
    // Unrated reviews go last in both rating orders.
    highest: (a, b) => (b.rating ?? -1) - (a.rating ?? -1),
    lowest: (a, b) => (a.rating ?? 11) - (b.rating ?? 11),
    longest: (a, b) => b.text.length - a.text.length,
  };
  return [...reviews].sort(key[sort]);
}
