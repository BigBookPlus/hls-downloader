function parseAttrList(source) {
  const out = {};
  const re = /([A-Z0-9-]+)=(?:"([^"]*)"|'([^']*)'|([^,]*))/gi;
  let match;
  while ((match = re.exec(source))) {
    out[match[1].toUpperCase()] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return out;
}

function resolveUri(uri, baseUrl) {
  if (!uri) return "";
  if (/^(https?:|data:|blob:)/i.test(uri)) return uri;
  return new URL(uri, baseUrl).href;
}

function parseIv(value) {
  if (!value) return null;
  let hex = String(value).trim();
  if (hex.startsWith("0x") || hex.startsWith("0X")) hex = hex.slice(2);
  if (hex.length % 2) hex = "0" + hex;
  if (hex.length > 32) hex = hex.slice(-32);
  hex = hex.padStart(32, "0");
  const iv = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) {
    iv[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return iv;
}

function parseKeyTag(value, baseUrl) {
  const attrs = parseAttrList(value);
  const method = (attrs.METHOD || "NONE").toUpperCase();
  if (method === "NONE") {
    return { method: "NONE", uri: "", iv: null };
  }
  return {
    method,
    uri: attrs.URI ? resolveUri(attrs.URI, baseUrl) : "",
    iv: parseIv(attrs.IV),
  };
}

function parseByteRange(value, previousEnd) {
  if (!value) return null;
  const [lengthPart, offsetPart] = value.split("@");
  const length = Number(lengthPart);
  const offset = offsetPart !== undefined ? Number(offsetPart) : previousEnd;
  if (!Number.isFinite(length) || !Number.isFinite(offset)) return null;
  return { offset, length };
}

function cloneKey(key) {
  return { ...key, iv: key.iv ? new Uint8Array(key.iv) : null };
}

function parseMapTag(value, baseUrl, currentKey, nextMediaSequence) {
  const attrs = parseAttrList(value);
  return {
    url: attrs.URI ? resolveUri(attrs.URI, baseUrl) : "",
    byteRange: attrs.BYTERANGE ? parseByteRange(attrs.BYTERANGE, 0) : null,
    key: cloneKey(currentKey),
    mediaSequence: nextMediaSequence,
  };
}

export function parseM3u8(text, baseUrl) {
  const lines = String(text)
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const playlist = {
    kind: "media",
    version: 1,
    mediaSequence: 0,
    targetDuration: 0,
    variants: [],
    segments: [],
    hasMap: false,
    mapUri: "",
    unsupportedReason: "",
  };

  let pendingStreamInf = null;
  let currentKey = { method: "NONE", uri: "", iv: null };
  let currentMap = null;
  let pendingInf = null;
  let pendingByteRange = null;
  let previousRangeEnd = 0;
  let mediaIndex = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith("#EXT-X-VERSION:")) {
      playlist.version = Number(line.slice("#EXT-X-VERSION:".length)) || 1;
      continue;
    }
    if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      playlist.mediaSequence = Number(line.slice("#EXT-X-MEDIA-SEQUENCE:".length)) || 0;
      continue;
    }
    if (line.startsWith("#EXT-X-TARGETDURATION:")) {
      playlist.targetDuration = Number(line.slice("#EXT-X-TARGETDURATION:".length)) || 0;
      continue;
    }
    if (line.startsWith("#EXT-X-MAP:")) {
      currentMap = parseMapTag(
        line.slice("#EXT-X-MAP:".length),
        baseUrl,
        currentKey,
        playlist.mediaSequence + mediaIndex
      );
      playlist.hasMap = true;
      playlist.mapUri = currentMap.url;
      continue;
    }
    if (line.startsWith("#EXT-X-KEY:")) {
      currentKey = parseKeyTag(line.slice("#EXT-X-KEY:".length), baseUrl);
      continue;
    }
    if (line.startsWith("#EXT-X-BYTERANGE:")) {
      pendingByteRange = parseByteRange(line.slice("#EXT-X-BYTERANGE:".length), previousRangeEnd);
      continue;
    }
    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      pendingStreamInf = parseAttrList(line.slice("#EXT-X-STREAM-INF:".length));
      playlist.kind = "master";
      continue;
    }
    if (line.startsWith("#EXT-X-I-FRAME-STREAM-INF:")) {
      continue;
    }
    if (line.startsWith("#EXTINF:")) {
      const payload = line.slice("#EXTINF:".length);
      const duration = Number(payload.split(",")[0]);
      pendingInf = { duration: Number.isFinite(duration) ? duration : 0 };
      continue;
    }
    if (line.startsWith("#")) continue;

    if (pendingStreamInf) {
      playlist.variants.push({
        url: resolveUri(line, baseUrl),
        bandwidth: Number(pendingStreamInf.BANDWIDTH) || 0,
        resolution: pendingStreamInf.RESOLUTION || "",
        codecs: pendingStreamInf.CODECS || "",
        name: pendingStreamInf.NAME || pendingStreamInf["VIDEO-RANGE"] || "",
      });
      pendingStreamInf = null;
      continue;
    }

    const seq = playlist.mediaSequence + mediaIndex;
    const range = pendingByteRange;
    if (range) previousRangeEnd = range.offset + range.length;
    playlist.segments.push({
      url: resolveUri(line, baseUrl),
      duration: pendingInf?.duration || 0,
      mediaSequence: seq,
      key: cloneKey(currentKey),
      byteRange: range,
      map: currentMap,
    });
    mediaIndex += 1;
    pendingInf = null;
    pendingByteRange = null;
  }

  if (playlist.segments.length > 0) {
    playlist.kind = playlist.variants.length > 0 ? "mixed" : "media";
  }

  return playlist;
}

export function summarizePlaylist(playlist) {
  const methods = new Set();
  for (const segment of playlist.segments) {
    methods.add(segment.key.method);
    if (segment.map?.key?.method) methods.add(segment.map.key.method);
  }
  if (playlist.kind === "master") {
    return {
      kind: "master",
      encryption: "unknown",
      variantCount: playlist.variants.length,
      segmentCount: 0,
      unsupportedReason: playlist.unsupportedReason,
    };
  }
  let encryption = "none";
  if (methods.has("SAMPLE-AES") || [...methods].some((m) => m !== "NONE" && m !== "AES-128")) {
    encryption = "unsupported";
  } else if (methods.has("AES-128")) {
    encryption = "aes-128";
  }
  return {
    kind: playlist.kind,
    encryption,
    variantCount: playlist.variants.length,
    segmentCount: playlist.segments.length,
    unsupportedReason: playlist.unsupportedReason,
    methods: [...methods],
  };
}

export function formatVariantLabel(variant) {
  const bits = [];
  if (variant.resolution) bits.push(variant.resolution);
  if (variant.bandwidth) bits.push(`${Math.round(variant.bandwidth / 1000)} kbps`);
  if (variant.name) bits.push(variant.name);
  return bits.join(" · ") || variant.url;
}

export function pickDefaultVariant(variants) {
  if (!variants.length) return null;
  return [...variants].sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))[0];
}
