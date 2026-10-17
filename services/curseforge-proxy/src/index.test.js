import assert from "node:assert/strict";
import test from "node:test";
import worker from "./index.js";

test("rejects routes outside the CurseForge allowlist", async () => {
  const response = await worker.fetch(
    new Request("https://proxy.example/v1/anything"),
    { CURSEFORGE_API_KEY: "publisher-key" },
  );
  assert.equal(response.status, 404);
});

test("adds the server-side key when forwarding an allowed route", async () => {
  const originalFetch = globalThis.fetch;
  let upstreamRequest;
  globalThis.fetch = async (url, init) => {
    upstreamRequest = { url: String(url), init };
    return new Response('{"data":[]}', {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const response = await worker.fetch(
      new Request("https://proxy.example/v1/mods/search?gameId=432"),
      { CURSEFORGE_API_KEY: "publisher-key" },
    );
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '{"data":[]}');
    assert.equal(
      upstreamRequest.url,
      "https://api.curseforge.com/v1/mods/search?gameId=432",
    );
    assert.equal(upstreamRequest.init.headers["x-api-key"], "publisher-key");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("forwards allowed requests when the proxy base URL omits the /v1 suffix", async () => {
  const originalFetch = globalThis.fetch;
  let upstreamUrl;
  globalThis.fetch = async (url) => {
    upstreamUrl = String(url);
    return new Response('{"data":[]}', { status: 200 });
  };

  try {
    const response = await worker.fetch(
      new Request("https://proxy.example/mods/search?gameId=432"),
      { CURSEFORGE_API_KEY: "publisher-key" },
    );
    assert.equal(response.status, 200);
    assert.equal(
      upstreamUrl,
      "https://api.curseforge.com/v1/mods/search?gameId=432",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects invalid batches before contacting CurseForge", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("Unexpected upstream request");
  };

  try {
    const response = await worker.fetch(
      new Request("https://proxy.example/v1/mods/files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileIds: ["not-an-id"] }),
      }),
      { CURSEFORGE_API_KEY: "publisher-key" },
    );
    assert.equal(response.status, 400);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects requests when the publisher key is missing", async () => {
  const response = await worker.fetch(
    new Request("https://proxy.example/v1/mods/search"),
    {},
  );
  assert.equal(response.status, 503);
});

test("limits request body size before parsing", async () => {
  const body = JSON.stringify({ fileIds: ["1".repeat(5000)] });
  const response = await worker.fetch(
    new Request("https://proxy.example/v1/mods/files", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    }),
    { CURSEFORGE_API_KEY: "publisher-key" },
  );
  assert.equal(response.status, 413);
});
