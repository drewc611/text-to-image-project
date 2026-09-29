const MODEL = "@cf/stabilityai/stable-diffusion-xl-base-1.0";
const PROMPT = "cyberpunk cat";

// One generated image is served to everyone for this long.
const CACHE_TTL_SECONDS = 3600;

// Cap on paid generations per isolate per window. Cache hits are not counted.
const MAX_GENERATIONS_PER_WINDOW = 5;
const WINDOW_MS = 60_000;

type CachedImage = { image: ArrayBuffer; expiresAt: number };

// Second cache layer for when the Cache API stores nothing (for example on a
// workers.dev hostname). It lives only as long as the isolate.
let memo: CachedImage | null = null;
let inFlight: Promise<ArrayBuffer> | null = null;
let generationTimes: number[] = [];

function imageResponse(image: ArrayBuffer): Response {
  return new Response(image, {
    headers: {
      "content-type": "image/png",
      "cache-control": `public, max-age=${CACHE_TTL_SECONDS}`,
      "x-content-type-options": "nosniff",
    },
  });
}

function errorResponse(
  status: number,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(message, {
    status,
    headers: { "cache-control": "no-store", ...headers },
  });
}

function takeGenerationSlot(now: number): boolean {
  generationTimes = generationTimes.filter((t) => now - t < WINDOW_MS);
  if (generationTimes.length >= MAX_GENERATIONS_PER_WINDOW) return false;
  generationTimes.push(now);
  return true;
}

async function generate(env: Env): Promise<ArrayBuffer> {
  const stream = await env.AI.run(MODEL, { prompt: PROMPT });
  return new Response(stream).arrayBuffer();
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname !== "/") {
      return errorResponse(404, "Not found");
    }
    if (request.method !== "GET") {
      return errorResponse(405, "Method not allowed", { allow: "GET" });
    }

    // Key on the path alone so "/?x=1" cannot bypass the cache.
    const cache = caches.default;
    const cacheKey = new Request(new URL("/", url).toString());
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    const now = Date.now();
    if (memo && memo.expiresAt > now) return imageResponse(memo.image);

    if (!inFlight) {
      if (!takeGenerationSlot(now)) {
        return errorResponse(429, "Too many requests", {
          "retry-after": String(Math.ceil(WINDOW_MS / 1000)),
        });
      }
      inFlight = generate(env).finally(() => {
        inFlight = null;
      });
    }

    let image: ArrayBuffer;
    try {
      image = await inFlight;
    } catch (error) {
      console.error("image generation failed", error);
      return errorResponse(502, "Image generation failed");
    }

    memo = { image, expiresAt: Date.now() + CACHE_TTL_SECONDS * 1000 };
    ctx.waitUntil(cache.put(cacheKey, imageResponse(image)));
    return imageResponse(image);
  },
} satisfies ExportedHandler<Env>;
