import assert from "node:assert/strict";
import test from "node:test";
import { normalizeName, normalizeStreet, sameAddress } from "../lib/normalization.mjs";
import { parseCommunityDetail, scrapeCommunities } from "../lib/scraper.mjs";

test("normalizes address aliases without corrupting complete words", () => {
  assert.equal(normalizeStreet("4850 Northwest Sylvania Avenue"), "4850 nw sylvania ave");
  assert.equal(normalizeStreet("4850 NW Sylvania Ave."), "4850 nw sylvania ave");
  assert.equal(normalizeName("Rehabilitation & Nursing"), "rehabilitation and nursing");
  assert.equal(normalizeName("Healthcare Centre"), "health care center");
  assert.equal(sameAddress(
    { street: "1120 West Main Street", zip: "48867" },
    { billing_street: "1120 W Main St", billing_zip: "48867-0001" },
  ), true);
});

test("parses a community detail page into structured source evidence", () => {
  const html = `
    <div class="wrap"><h1>Bellhaven Test &amp; Gardens</h1>
      <dl class="detail">
        <dt>Address</dt><dd>10 West Main Street<br>Findlay, OH 45840</dd>
        <dt>Care Offerings</dt><dd><span class="badge">Assisted Living</span><span class="badge">Memory Support</span></dd>
        <dt>Administrator</dt><dd>Alex Rivera</dd><dt>Phone</dt><dd>(555) 010-0200</dd>
      </dl>
    </div>`;
  const location = parseCommunityDetail(html, "https://example.test/communities/bellhaven-test");
  assert.deepEqual(location, {
    slug: "bellhaven-test",
    name: "Bellhaven Test & Gardens",
    street: "10 West Main Street",
    city: "Findlay",
    state: "OH",
    zip: "45840",
    care_offerings: ["Assisted Living", "Memory Support"],
    administrator: "Alex Rivera",
    phone: "(555) 010-0200",
    source_url: "https://example.test/communities/bellhaven-test",
  });
});

test("rejects a detail page when source markup no longer exposes a community name", () => {
  const html = `
    <main>
      <dl class="detail">
        <dt>Address</dt><dd>100 Main Street<br>Springfield, OH 45501</dd>
      </dl>
    </main>`;

  assert.throws(
    () => parseCommunityDetail(html, "https://example.test/communities/missing-heading"),
    /Missing community name/,
  );
});

test("rejects duplicate normalized community identities before proposal generation", async () => {
  const detail = (slug) => `
    <main><h1>Bellhaven of Springfield</h1>
      <dl class="detail">
        <dt>Address</dt><dd>100 Main Street<br>Springfield, OH 45501</dd>
        <dt>Care Offerings</dt><dd><span class="badge">Assisted Living</span></dd>
      </dl>
      <span>${slug}</span>
    </main>`;
  const responses = new Map([
    ["https://example.test/", "<main>We serve 2 communities.</main>"],
    ["https://example.test/communities", `
      <div class="wrap"><p>2 communities listed</p>
        <div class="card"><h3><a href="/communities/springfield-one">One</a></h3></div>
        <div class="card"><h3><a href="/communities/springfield-two">Two</a></h3></div>
      </div>`],
    ["https://example.test/communities/springfield-one", detail("one")],
    ["https://example.test/communities/springfield-two", detail("two")],
  ]);
  const fetchImpl = async (input) => {
    const url = new URL(input).toString();
    return responses.has(url)
      ? new Response(responses.get(url), { status: 200 })
      : new Response("missing fixture", { status: 404 });
  };

  await assert.rejects(
    scrapeCommunities({ baseUrl: "https://example.test", fetchImpl }),
    /Duplicate source community identity/,
  );
});
