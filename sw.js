const TAB_PREFIX = "tab_";
const MAX_PLAYLISTS = 40;
const MAX_HOSTS = 80;

function tabKey(tabId) {
  return TAB_PREFIX + tabId;
}

function headerMap(requestHeaders) {
  const out = {};
  if (!requestHeaders) return out;
  for (const h of requestHeaders) {
    if (!h?.name) continue;
    out[h.name.toLowerCase()] = h.value || "";
  }
  return out;
}

function pickAuthHeaders(requestHeaders) {
  const map = headerMap(requestHeaders);
  const picked = {};
  if (map.cookie) picked.cookie = map.cookie;
  if (map.referer) picked.referer = map.referer;
  if (map.origin) picked.origin = map.origin;
  if (map.authorization) picked.authorization = map.authorization;
  if (map["user-agent"]) picked.userAgent = map["user-agent"];
  return picked;
}

function isPlaylistUrl(url) {
  try {
    const u = new URL(url);
    const path = u.pathname.toLowerCase();
    const full = url.toLowerCase();
    if (path.endsWith(".m3u8") || path.endsWith(".m3u")) return true;
    if (full.includes(".m3u8?") || full.includes("m3u8&")) return true;
    if (full.includes("mpegurl")) return true;
    return false;
  } catch {
    return false;
  }
}

function isKeyOrMediaUrl(url) {
  try {
    const path = new URL(url).pathname.toLowerCase();
    return (
      path.endsWith(".key") ||
      path.endsWith(".ts") ||
      path.endsWith(".m4s") ||
      path.endsWith(".cmfv") ||
      /\/key(?:$|\.)/.test(path)
    );
  } catch {
    return false;
  }
}

function isPlaylistContentType(contentType) {
  if (!contentType) return false;
  const c = contentType.toLowerCase();
  return (
    c.includes("mpegurl") ||
    c.includes("x-mpegurl") ||
    c.includes("vnd.apple.mpegurl")
  );
}

function contentTypeFromHeaders(responseHeaders) {
  const map = headerMap(responseHeaders);
  return map["content-type"] || "";
}

async function readTabState(tabId) {
  const key = tabKey(tabId);
  const data = await chrome.storage.session.get(key);
  return (
    data[key] || {
      pageUrl: "",
      playlists: [],
      hostHeaders: {},
    }
  );
}

async function writeTabState(tabId, state) {
  await chrome.storage.session.set({ [tabKey(tabId)]: state });
}

async function rememberHostHeaders(tabId, url, headers) {
  if (!headers || (!headers.cookie && !headers.referer && !headers.authorization)) {
    return;
  }
  const host = new URL(url).host;
  const state = await readTabState(tabId);
  state.hostHeaders[host] = {
    ...headers,
    time: Date.now(),
  };
  const hosts = Object.entries(state.hostHeaders).sort((a, b) => (b[1].time || 0) - (a[1].time || 0));
  if (hosts.length > MAX_HOSTS) {
    state.hostHeaders = Object.fromEntries(hosts.slice(0, MAX_HOSTS));
  }
  await writeTabState(tabId, state);
}

async function rememberPlaylist(tabId, url, headers) {
  const state = await readTabState(tabId);
  const existing = state.playlists.find((p) => p.url === url);
  const entry = {
    id: existing?.id || `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    url,
    requestHeaders: headers || existing?.requestHeaders || {},
    time: Date.now(),
  };
  if (existing) {
    state.playlists = state.playlists.map((p) => (p.url === url ? { ...p, ...entry } : p));
  } else {
    state.playlists = [entry, ...state.playlists].slice(0, MAX_PLAYLISTS);
  }
  await writeTabState(tabId, state);
  await updateBadge(tabId, state.playlists.length);
}

async function updateBadge(tabId, count) {
  const text = count > 0 ? String(Math.min(count, 99)) : "";
  try {
    await chrome.action.setBadgeText({ tabId, text });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: "#1d4ed8" });
  } catch {
    // badge APIs vary slightly by Chrome version
  }
}

async function attachPageUrl(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab?.url) return;
    const state = await readTabState(tabId);
    if (state.pageUrl !== tab.url) {
      state.pageUrl = tab.url;
      await writeTabState(tabId, state);
    }
  } catch {
    // tab may be gone
  }
}

async function onAuthHeaders(details) {
  if (details.tabId < 0) return;
  if (details.method && details.method !== "GET" && details.method !== "HEAD") return;
  const headers = pickAuthHeaders(details.requestHeaders);
  if (isPlaylistUrl(details.url)) {
    await attachPageUrl(details.tabId);
    await rememberPlaylist(details.tabId, details.url, headers);
    await rememberHostHeaders(details.tabId, details.url, headers);
    return;
  }
  if (isKeyOrMediaUrl(details.url)) {
    await rememberHostHeaders(details.tabId, details.url, headers);
  }
}

async function onPlaylistResponse(details) {
  if (details.tabId < 0) return;
  if (isPlaylistUrl(details.url) || isPlaylistContentType(contentTypeFromHeaders(details.responseHeaders))) {
    await attachPageUrl(details.tabId);
    const state = await readTabState(details.tabId);
    const known = state.playlists.find((p) => p.url === details.url);
    await rememberPlaylist(details.tabId, details.url, known?.requestHeaders || {});
  }
}

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    onAuthHeaders(details);
  },
  { urls: ["<all_urls>"] },
  ["requestHeaders", "extraHeaders"]
);

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    onPlaylistResponse(details);
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await chrome.storage.session.remove(tabKey(tabId));
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!changeInfo.url && changeInfo.status !== "loading") return;
  if (changeInfo.url) {
    const state = await readTabState(tabId);
    const nextHost = (() => {
      try {
        return new URL(changeInfo.url).host;
      } catch {
        return "";
      }
    })();
    const prevHost = (() => {
      try {
        return state.pageUrl ? new URL(state.pageUrl).host : "";
      } catch {
        return "";
      }
    })();
    if (nextHost && prevHost && nextHost !== prevHost) {
      await writeTabState(tabId, {
        pageUrl: changeInfo.url,
        playlists: [],
        hostHeaders: {},
      });
      await updateBadge(tabId, 0);
      return;
    }
    state.pageUrl = changeInfo.url || tab.url || state.pageUrl;
    await writeTabState(tabId, state);
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (message?.type === "getTabState") {
      const state = await readTabState(message.tabId);
      sendResponse({ ok: true, state });
      return;
    }
    if (message?.type === "addManualPlaylist") {
      await rememberPlaylist(message.tabId, message.url, message.headers || {});
      sendResponse({ ok: true });
      return;
    }
    if (message?.type === "clearTabPlaylists") {
      const state = await readTabState(message.tabId);
      state.playlists = [];
      await writeTabState(message.tabId, state);
      await updateBadge(message.tabId, 0);
      sendResponse({ ok: true });
      return;
    }
    sendResponse({ ok: false, error: "unknown_message" });
  })();
  return true;
});
