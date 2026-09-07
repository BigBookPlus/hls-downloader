import { fetchKeyBytes, fetchWithAuth } from "./fetch-auth.js";
import { decryptHlsSegment, looksLikeMpegTs } from "./hls-aes.js";
import { formatVariantLabel, parseM3u8, pickDefaultVariant, summarizePlaylist } from "./m3u8.js";

const CONCURRENCY = 3;

function authOptions(ctx, extra = {}) {
  return {
    tabId: ctx.tabId,
    pageUrl: ctx.pageUrl,
    capturedHeaders: ctx.capturedHeaders || {},
    hostHeaders: ctx.hostHeaders || {},
    signal: ctx.signal,
    ...extra,
  };
}

export async function loadPlaylist(url, ctx) {
  const result = await fetchWithAuth(url, authOptions(ctx, { expect: "text" }));
  const playlist = parseM3u8(result.text, url);
  const summary = summarizePlaylist(playlist);
  return { text: result.text, playlist, summary };
}

export async function inspectStream(url, ctx) {
  const loaded = await loadPlaylist(url, ctx);
  if (loaded.playlist.hasMap) {
    return { url, ...loaded, error: loaded.playlist.unsupportedReason };
  }
  if (loaded.playlist.kind === "master" || loaded.playlist.variants.length) {
    return {
      url,
      ...loaded,
      variants: loaded.playlist.variants.map((v) => ({
        ...v,
        label: formatVariantLabel(v),
      })),
      defaultVariant: pickDefaultVariant(loaded.playlist.variants),
    };
  }
  if (loaded.summary.encryption === "unsupported") {
    return {
      url,
      ...loaded,
      error: `不支持的加密：${(loaded.summary.methods || []).join(", ")}。仅支持 AES-128 / 明文 TS。`,
    };
  }
  return { url, ...loaded };
}

export async function resolveMediaPlaylist(url, ctx, variantUrl) {
  const first = await inspectStream(url, ctx);
  if (first.error) return first;
  if (first.playlist.segments.length && !variantUrl) return first;
  const chosen = variantUrl || first.defaultVariant?.url;
  if (!chosen) {
    return { ...first, error: "主播放列表里没有可用的媒体流。" };
  }
  return inspectStream(chosen, ctx);
}

async function getKey(cache, uri, ctx) {
  if (!uri) throw new Error("EXT-X-KEY 缺少 URI");
  if (cache.has(uri)) return cache.get(uri);
  const pending = fetchKeyBytes(uri, authOptions(ctx)).then((bytes) => {
    cache.set(uri, bytes);
    return bytes;
  });
  cache.set(uri, pending);
  return pending;
}

async function fetchAndDecryptSegment(segment, ctx, keyCache) {
  const cipher = await fetchWithAuth(
    segment.url,
    authOptions(ctx, { expect: "arrayBuffer", range: segment.byteRange || null })
  );
  let keyBytes = null;
  if (segment.key.method === "AES-128") {
    keyBytes = await getKey(keyCache, segment.key.uri, ctx);
  }
  const { bytes, decrypted } = await decryptHlsSegment(
    cipher.bytes,
    segment.key,
    keyBytes,
    segment.mediaSequence
  );
  if (segment.key.method !== "NONE" && !decrypted) {
    throw new Error("分片仍是密文，已中止，避免拼出无法播放的文件。");
  }
  if (!looksLikeMpegTs(bytes)) {
    throw new Error("解密/下载后的分片不是有效 MPEG-TS，已中止，未把密文当作普通 TS 保存。");
  }
  return { bytes, keyBytes, keyUri: segment.key.uri, method: segment.key.method };
}

export async function prepareDownload(playlistUrl, variantUrl, ctx) {
  const media = await resolveMediaPlaylist(playlistUrl, ctx, variantUrl);
  if (media.error) throw new Error(media.error);
  if (!media.playlist.segments.length) throw new Error("媒体播放列表没有分片。");
  if (media.playlist.hasMap) throw new Error(media.playlist.unsupportedReason);
  const segments = media.playlist.segments;
  const keyCache = new Map();
  const first = await fetchAndDecryptSegment(segments[0], ctx, keyCache);
  return { media, segments, keyCache, first };
}

export async function runDownload(options) {
  const { playlistUrl, variantUrl = "", ctx, writable, onProgress, saveMaterials = false, materialWriter, prepared } = options;
  const readyPrepared = prepared || (await prepareDownload(playlistUrl, variantUrl, ctx));
  const { media, segments, keyCache, first } = readyPrepared;
  await writable.write(first.bytes);

  if (saveMaterials && materialWriter) {
    await materialWriter.writeText("source.m3u8", media.text);
    if (first.keyUri && first.keyBytes) {
      await materialWriter.writeBytes("key.bin", first.keyBytes);
    }
  }

  let writtenBytes = first.bytes.length;
  let done = 1;
  onProgress?.({
    done,
    total: segments.length,
    writtenBytes,
    encryption: media.summary.encryption,
    message: `已解密 ${done}/${segments.length} 分片`,
  });

  const ready = new Map();
  const inflight = new Map();
  const workers = [];
  let fail = null;

  const prefetch = async () => {
    try {
      for (let i = 1; i < segments.length; i += 1) {
        if (ctx.signal?.aborted) throw new Error("已停止");
        while (inflight.size >= CONCURRENCY) {
          await Promise.race(inflight.values());
        }
        const index = i;
        const job = fetchAndDecryptSegment(segments[index], ctx, keyCache)
          .then((result) => {
            inflight.delete(index);
            ready.set(index, result);
          })
          .catch((err) => {
            inflight.delete(index);
            fail = err;
            throw err;
          });
        inflight.set(index, job);
        workers.push(job);
      }
      await Promise.all(workers);
    } catch (err) {
      fail = err;
      throw err;
    }
  };

  const writer = async () => {
    for (let index = 1; index < segments.length; index += 1) {
      if (ctx.signal?.aborted) throw new Error("已停止");
      while (!ready.has(index)) {
        if (fail) throw fail;
        await new Promise((resolve) => setTimeout(resolve, 40));
        if (ctx.signal?.aborted) throw new Error("已停止");
        if (fail) throw fail;
      }
      const result = ready.get(index);
      ready.delete(index);
      await writable.write(result.bytes);
      writtenBytes += result.bytes.length;
      done += 1;
      onProgress?.({
        done,
        total: segments.length,
        writtenBytes,
        encryption: media.summary.encryption,
        message: `已解密 ${done}/${segments.length} 分片`,
      });
    }
  };

  await Promise.all([prefetch(), writer()]);

  const uniqueKeys = [];
  const seenUri = new Set();
  for (const [uri, value] of keyCache.entries()) {
    const bytes = value instanceof Uint8Array ? value : await value;
    if (seenUri.has(uri)) continue;
    seenUri.add(uri);
    uniqueKeys.push({ uri, bytes });
  }
  if (saveMaterials && materialWriter && uniqueKeys.length > 1) {
    for (let i = 1; i < uniqueKeys.length; i += 1) {
      await materialWriter.writeBytes(`key-${i}.bin`, uniqueKeys[i].bytes);
    }
  }

  return {
    segmentCount: segments.length,
    writtenBytes,
    encryption: media.summary.encryption,
    mediaText: media.text,
    keys: uniqueKeys,
  };
}
