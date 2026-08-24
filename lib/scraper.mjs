import * as cheerio from "cheerio";
import { fetchWithPolicy, readTextLimited } from "./http.mjs";
import { addressKey, normalizeName } from "./normalization.mjs";

export const DEFAULT_WEBSITE_BASE = "https://analyst-assessment-production.up.railway.app";

function cleanText(value = "") {
  return String(value).replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

async function fetchHtml(url, fetchImpl) {
  const response = await fetchWithPolicy(url, {
    headers: { "user-agent": "bellhaven-ownership-review/1.0" },
  }, {
    attempts: 3,
    timeoutMs: 15_000,
    fetchImpl,
  });
  if (!response.ok) {
    throw new Error(`Website request failed (${response.status}) for ${url}`);
  }
  if (response.url && new URL(response.url).origin !== new URL(url).origin) {
    throw new Error(`Website request redirected outside the configured origin: ${response.url}`);
  }
  return readTextLimited(response);
}

function parseAddress($, addressElement) {
  const clone = addressElement.clone();
  clone.find("br").replaceWith("\n");
  const lines = clone
    .text()
    .split(/\n+/)
    .map(cleanText)
    .filter(Boolean);
  if (lines.length < 2) {
    throw new Error(`Unexpected address format: ${cleanText(addressElement.text())}`);
  }

  const locality = lines.at(-1);
  const match = locality.match(/^(.*?),\s*([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)$/);
  if (!match) throw new Error(`Unexpected locality format: ${locality}`);
  const street = lines.slice(0, -1).join(" ");
  const city = cleanText(match[1]);
  if (street.length > 300 || city.length > 150) {
    throw new Error(`Address fields exceed safety limits: ${street}, ${city}`);
  }
  return {
    street,
    city,
    state: match[2].toUpperCase(),
    zip: match[3],
  };
}

export function parseCommunityDetail(html, url) {
  const $ = cheerio.load(html);
  const fields = new Map();
  $("dl.detail dt").each((_, element) => {
    const label = cleanText($(element).text()).toLowerCase();
    fields.set(label, $(element).next("dd"));
  });

  const addressElement = fields.get("address");
  if (!addressElement?.length) throw new Error(`Missing address on ${url}`);
  const careElement = fields.get("care offerings");
  const offerings = careElement
    ? careElement.find(".badge").toArray().map((element) => cleanText($(element).text()))
    : [];
  if (offerings.length > 20 || offerings.some((offering) => !offering || offering.length > 200)) {
    throw new Error(`Invalid care offerings on ${url}`);
  }

  const parsedUrl = new URL(url);
  const slug = parsedUrl.pathname.split("/").filter(Boolean).at(-1);
  const name = cleanText($("main h1, .wrap h1").first().text());
  if (!slug) throw new Error(`Missing community slug on ${url}`);
  if (!name) throw new Error(`Missing community name on ${url}`);
  if (name.length > 300) throw new Error(`Community name exceeds 300 characters on ${url}`);
  const administrator = cleanText(fields.get("administrator")?.text());
  const phone = cleanText(fields.get("phone")?.text());
  if (administrator.length > 300 || phone.length > 100) {
    throw new Error(`Community contact fields exceed safety limits on ${url}`);
  }
  return {
    slug,
    name,
    ...parseAddress($, addressElement),
    care_offerings: [...new Set(offerings)],
    administrator,
    phone,
    source_url: parsedUrl.toString(),
  };
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export async function scrapeCommunities({
  baseUrl = DEFAULT_WEBSITE_BASE,
  fetchImpl = fetch,
  concurrency = 6,
} = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 20) {
    throw new Error("Scraper concurrency must be an integer between 1 and 20");
  }
  const rootUrl = new URL("/", baseUrl).toString();
  const websiteOrigin = new URL(rootUrl).origin;
  const homeHtml = await fetchHtml(rootUrl, fetchImpl);
  const homepageClaim = Number(homeHtml.match(/serve\s+(\d+)\s+communities/i)?.[1] ?? 0);

  const detailUrls = new Set();
  let directoryUrl = new URL("/communities", baseUrl);
  const visitedDirectoryPages = new Set();
  let paginationComplete = false;
  let directoryClaim = 0;
  while (visitedDirectoryPages.size < 50) {
    const pageKey = directoryUrl.toString();
    if (visitedDirectoryPages.has(pageKey)) {
      throw new Error(`Directory pagination looped back to ${pageKey}`);
    }
    visitedDirectoryPages.add(pageKey);
    const html = await fetchHtml(directoryUrl.toString(), fetchImpl);
    const $ = cheerio.load(html);
    if (!directoryClaim) {
      directoryClaim = Number($(".wrap > p").first().text().match(/(\d+)\s+communities listed/i)?.[1] ?? 0);
    }
    $(".card h3 a[href^='/communities/']").each((_, anchor) => {
      const detailUrl = new URL($(anchor).attr("href"), baseUrl);
      if (detailUrl.origin !== websiteOrigin) throw new Error(`Community link left the configured website: ${detailUrl}`);
      detailUrls.add(detailUrl.toString());
    });
    const nextHref = $(".pager a").filter((_, anchor) => /next/i.test($(anchor).text())).attr("href");
    if (!nextHref) {
      paginationComplete = true;
      break;
    }
    directoryUrl = new URL(nextHref, baseUrl);
    if (directoryUrl.origin !== websiteOrigin) {
      throw new Error(`Directory pagination left the configured website: ${directoryUrl}`);
    }
  }
  if (!paginationComplete) {
    throw new Error("Directory pagination exceeded the 50-page safety limit");
  }

  if (!detailUrls.size) throw new Error("The Bellhaven directory returned no community links");
  if (directoryClaim && detailUrls.size !== directoryClaim) {
    throw new Error(`Directory declared ${directoryClaim} communities but scraper found ${detailUrls.size}`);
  }

  const locations = await mapWithConcurrency([...detailUrls], concurrency, async (url) => {
    const html = await fetchHtml(url, fetchImpl);
    return parseCommunityDetail(html, url);
  });
  const slugs = new Set();
  const identities = new Set();
  for (const location of locations) {
    const identity = `${normalizeName(location.name)}|${addressKey(location)}`;
    if (slugs.has(location.slug)) throw new Error(`Duplicate community slug: ${location.slug}`);
    if (identities.has(identity)) throw new Error(`Duplicate source community identity: ${location.name}`);
    slugs.add(location.slug);
    identities.add(identity);
  }
  locations.sort((left, right) => left.name.localeCompare(right.name));

  return {
    scraped_at: new Date().toISOString(),
    website_base: baseUrl,
    directory_pages: visitedDirectoryPages.size,
    directory_claimed_count: directoryClaim || locations.length,
    homepage_claimed_count: homepageClaim || null,
    count_discrepancy: Boolean(homepageClaim && homepageClaim !== locations.length),
    locations,
  };
}
