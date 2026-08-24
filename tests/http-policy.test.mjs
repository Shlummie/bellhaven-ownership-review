import assert from "node:assert/strict";
import test from "node:test";
import { retryDelay } from "../lib/http.mjs";

test("missing or empty Retry-After headers use exponential backoff", () => {
  assert.equal(retryDelay(new Response(null, { status: 503 }), 0), 200);
  assert.equal(retryDelay(new Response(null, {
    status: 503,
    headers: { "retry-after": "" },
  }), 1), 400);
  assert.equal(retryDelay(new Response(null, {
    status: 503,
    headers: { "retry-after": "   " },
  }), 2), 800);
});

test("valid Retry-After seconds remain honored and bounded", () => {
  assert.equal(retryDelay(new Response(null, {
    status: 429,
    headers: { "retry-after": "0" },
  }), 0), 0);
  assert.equal(retryDelay(new Response(null, {
    status: 429,
    headers: { "retry-after": "10" },
  }), 0), 2_000);
});
