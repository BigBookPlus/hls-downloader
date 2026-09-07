function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function mergeHeaders(url, pageUrl, capturedHeaders, hostHeaders) {
  const host = hostOf(url);
  const fromHost = host && hostHeaders ? hostHeaders[host] || {} : {};
  const cookie = capturedHeaders.cookie || fromHost.cookie || "";
  const referer = capturedHeaders.referer || fromHost.referer || pageUrl || "";
  const origin = capturedHeaders.origin || fromHost.origin || (referer ? new URL(referer).origin : "");
  const authorization = capturedHeaders.authorization || fromHost.authorization || "";
  return { cookie, referer, origin, authorization };
}

async function cookiesForUrl(url) {
  if (!globalThis.chrome?.cookies?.getAll) return "";
  try {
    const list = await chrome.cookies.getAll({ url });
    return list.map((c) => `${c.name}=${c.value}`).join("; ");
  } catch {
    return "";
  }
}

function buildRequestHeaders(auth, cookieFallback) {
  const headers = {};
  const cookie = auth.cookie || cookieFallback;
  if (cookie) headers.Cookie = cookie;
  if (auth.referer) headers.Referer = auth.referer;
  if (auth.origin) headers.Origin = auth.origin;
  if (auth.authorization) headers.Authorization = auth.authorization;
  headers.Accept = "*/*";
  return headers;
}

function statusError(url, status) {
  if (status === 401 || status === 403) {
    return new Error(
      `请求被拒绝 HTTP ${status}：${url}。请先登录并在原页面点播，等播放器重新拉到 m3u8/key 后再下载。密钥常有时效。`
    );
  }
  return new Error(`请求失败 HTTP ${status}：${url}`);
}

async function fetchOnce(url, headers, range, signal) {
  const init = {
    method: "GET",
    headers: { ...headers },
    credentials: "include",
    cache: "no-store",
    signal,
  };
  if (range) {
    init.headers.Range = `bytes=${range.offset}-${range.offset + range.length - 1}`;
  }
  try {
    return await fetch(url, init);
  } catch (err) {
    if (headers.Referer || headers.Origin || headers.Cookie) {
      const retryHeaders = { Accept: "*/*" };
      if (headers.Cookie) retryHeaders.Cookie = headers.Cookie;
      if (headers.Authorization) retryHeaders.Authorization = headers.Authorization;
      if (range) retryHeaders.Range = `bytes=${range.offset}-${range.offset + range.length - 1}`;
      return await fetch(url, {
        method: "GET",
        headers: retryHeaders,
        credentials: "include",
        cache: "no-store",
        referrer: headers.Referer || "",
        referrerPolicy: "unsafe-url",
        signal,
      });
    }
    throw err;
  }
}

async function fetchViaTab(tabId, url, expect, range) {
  if (!tabId || !globalThis.chrome?.scripting?.executeScript) return null;
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: async (resourceUrl, kind, byteRange) => {
      const headers = {};
      if (byteRange) {
        headers.Range = `bytes=${byteRange.offset}-${byteRange.offset + byteRange.length - 1}`;
      }
      const res = await fetch(resourceUrl, { credentials: "include", headers, cache: "no-store" });
      if (!res.ok) return { ok: false, status: res.status };
      if (kind === "text") {
        return { ok: true, status: res.status, text: await res.text() };
      }
      const buffer = await res.arrayBuffer();
      return { ok: true, status: res.status, bytes: Array.from(new Uint8Array(buffer)) };
    },
    args: [url, expect, range || null],
  });
  return result || null;
}

export async function fetchWithAuth(url, options = {}) {
  const {
    tabId,
    pageUrl = "",
    capturedHeaders = {},
    hostHeaders = {},
    range = null,
    signal,
    expect = "arrayBuffer",
    allowTabFallback = expect === "text",
  } = options;

  if (url.startsWith("data:")) {
    const res = await fetch(url);
    if (expect === "text") return { status: 200, text: await res.text(), bytes: null, headers: {} };
    return { status: 200, text: "", bytes: new Uint8Array(await res.arrayBuffer()), headers: {} };
  }

  const auth = mergeHeaders(url, pageUrl, capturedHeaders, hostHeaders);
  const cookieFallback = await cookiesForUrl(url);
  const headers = buildRequestHeaders(auth, cookieFallback);
  const res = await fetchOnce(url, headers, range, signal);
  if (res.ok) {
    if (expect === "text") {
      return { status: res.status, text: await res.text(), bytes: null, headers: {} };
    }
    return { status: res.status, text: "", bytes: new Uint8Array(await res.arrayBuffer()), headers: {} };
  }

  if (allowTabFallback && tabId && (res.status === 401 || res.status === 403 || res.status === 0)) {
    const viaTab = await fetchViaTab(tabId, url, expect, range);
    if (viaTab?.ok) {
      if (expect === "text") return { status: viaTab.status, text: viaTab.text, bytes: null, headers: {} };
      return { status: viaTab.status, text: "", bytes: new Uint8Array(viaTab.bytes || []), headers: {} };
    }
    if (viaTab && !viaTab.ok) throw statusError(url, viaTab.status);
  }

  throw statusError(url, res.status);
}

export async function fetchKeyBytes(url, options = {}) {
  const result = await fetchWithAuth(url, { ...options, expect: "arrayBuffer", allowTabFallback: true });
  const bytes = result.bytes || new Uint8Array();
  if (bytes.length !== 16) {
    throw new Error(
      `密钥长度不是 16 字节（得到 ${bytes.length}）。可能已过期、需要登录，或返回了 HTML/JSON 而不是 AES key。请刷新页面重新点播后再试。`
    );
  }
  return bytes;
}
