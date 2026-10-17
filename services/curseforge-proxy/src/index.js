const API_ORIGIN = "https://api.curseforge.com";

function apiPath(pathname) {
  return pathname.startsWith("/v1/") ? pathname : `/v1${pathname}`;
}

function allowedRequest(method, pathname) {
  if (method === "GET") {
    return pathname === "/v1/mods/search"
      || /^\/v1\/mods\/\d+$/.test(pathname)
      || /^\/v1\/mods\/\d+\/files$/.test(pathname)
      || /^\/v1\/mods\/\d+\/files\/\d+$/.test(pathname);
  }
  return method === "POST" && pathname === "/v1/mods/files";
}

function response(body, status, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}

async function readJson(request) {
  const reader = request.body?.getReader();
  if (!reader) return { error: "Expected a JSON request body." };

  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 4096) {
      await reader.cancel();
      return { tooLarge: true };
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { value: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { error: "Expected a JSON request body." };
  }
}

export default {
  async fetch(request, env) {
    const incoming = new URL(request.url);
    if (request.method === "OPTIONS") return response(null, 204);

    if (!env.CURSEFORGE_API_KEY) {
      return response("CurseForge proxy is not configured.", 503);
    }
    const pathname = apiPath(incoming.pathname);
    if (!allowedRequest(request.method, pathname)) {
      return response("Unsupported CurseForge API route.", 404);
    }

    let body;
    if (request.method === "POST") {
      const parsed = await readJson(request);
      if (parsed.tooLarge) return response("Request body is too large.", 413);
      if (parsed.error) return response(parsed.error, 400);
      body = parsed.value;
      if (!Array.isArray(body?.fileIds)
        || body.fileIds.length < 1
        || body.fileIds.length > 100
        || !body.fileIds.every((id) => Number.isSafeInteger(id) && id > 0)) {
        return response("Invalid file ID list.", 400);
      }
    }

    const upstreamUrl = new URL(pathname + incoming.search, API_ORIGIN);
    const upstream = await fetch(upstreamUrl, {
      method: request.method,
      headers: {
        "x-api-key": env.CURSEFORGE_API_KEY,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      redirect: "manual",
    });

    return response(upstream.body, upstream.status, {
      "Content-Type": upstream.headers.get("Content-Type") || "application/json",
    });
  },
};
