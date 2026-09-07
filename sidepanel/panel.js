import { inspectStream, prepareDownload, runDownload } from "../lib/download-job.js";

const els = {
  pageUrl: document.getElementById("page-url"),
  openPage: document.getElementById("open-page"),
  m3u8Url: document.getElementById("m3u8-url"),
  addM3u8: document.getElementById("add-m3u8"),
  refresh: document.getElementById("refresh"),
  clear: document.getElementById("clear"),
  pageHint: document.getElementById("page-hint"),
  streamList: document.getElementById("stream-list"),
  variant: document.getElementById("variant"),
  saveMaterials: document.getElementById("save-materials"),
  download: document.getElementById("download"),
  stop: document.getElementById("stop"),
  progressWrap: document.getElementById("progress-wrap"),
  progressBar: document.getElementById("progress-bar"),
  progressText: document.getElementById("progress-text"),
  status: document.getElementById("status"),
};

const inspected = new Map();
let selectedUrl = "";
let abortController = null;
let activeTabId = null;

function setStatus(text, kind = "") {
  els.status.textContent = text;
  els.status.className = `status ${kind}`.trim();
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    const tail = `${u.pathname}${u.search}`;
    return tail.length > 72 ? `${u.host}…${tail.slice(-56)}` : `${u.host}${tail}`;
  } catch {
    return url;
  }
}

function encryptionBadge(info) {
  if (info?.error) return { text: "不可用", cls: "bad" };
  if (info?.playlist?.kind === "master" || info?.variants?.length) {
    return { text: "主列表", cls: "" };
  }
  if (info?.summary?.encryption === "aes-128") return { text: "AES-128", cls: "aes" };
  if (info?.summary?.encryption === "none") return { text: "明文", cls: "" };
  if (info?.summary?.encryption === "unsupported") return { text: "不支持", cls: "bad" };
  return { text: "未解析", cls: "warn" };
}

async function currentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function send(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, ...payload });
}

function buildCtx(tab, state, playlistEntry) {
  return {
    tabId: tab.id,
    pageUrl: state.pageUrl || tab.url || "",
    capturedHeaders: playlistEntry?.requestHeaders || {},
    hostHeaders: state.hostHeaders || {},
    signal: abortController?.signal,
  };
}

function suggestedName(tab) {
  const raw = (tab?.title || "video").replace(/[\\/:*?"<>|]+/g, " ").trim() || "video";
  return `${raw.slice(0, 60)}.ts`;
}

function renderVariants(info) {
  els.variant.innerHTML = "";
  if (info?.error) {
    els.variant.disabled = true;
    els.variant.append(new Option(info.error, ""));
    els.download.disabled = true;
    return;
  }
  if (info?.variants?.length) {
    for (const variant of info.variants) {
      els.variant.append(new Option(variant.label, variant.url));
    }
    const chosen = info.defaultVariant?.url || info.variants[0].url;
    els.variant.value = chosen;
    els.variant.disabled = false;
    els.download.disabled = false;
    return;
  }
  if (info?.playlist?.segments?.length) {
    const count = info.playlist.segments.length;
    const label =
      info.summary.encryption === "aes-128"
        ? `媒体列表 · AES-128 · ${count} 分片`
        : `媒体列表 · 明文 · ${count} 分片`;
    els.variant.append(new Option(label, ""));
    els.variant.disabled = true;
    els.download.disabled = false;
    return;
  }
  els.variant.append(new Option("没有可下载的分片", ""));
  els.variant.disabled = true;
  els.download.disabled = true;
}

function renderStreams(state) {
  els.streamList.innerHTML = "";
  const playlists = state.playlists || [];
  if (!playlists.length) {
    els.pageHint.textContent = "打开视频页并开始播放，播放器请求 m3u8 后会出现在这里。";
    return;
  }
  els.pageHint.textContent = `当前页：${state.pageUrl || "未知"}`;
  for (const item of playlists) {
    const info = inspected.get(item.url);
    const badge = encryptionBadge(info);
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = `stream${item.url === selectedUrl ? " active" : ""}`;
    button.dataset.url = item.url;
    const top = document.createElement("div");
    const mark = document.createElement("span");
    mark.className = `badge ${badge.cls}`.trim();
    mark.textContent = badge.text;
    top.append(mark);
    if (info?.playlist?.segments?.length) {
      const extra = document.createElement("span");
      extra.className = "hint";
      extra.textContent = ` ${info.playlist.segments.length} 分片`;
      top.append(extra);
    }
    const urlLine = document.createElement("div");
    urlLine.className = "stream-url";
    urlLine.textContent = shortUrl(item.url);
    button.append(top, urlLine);
    if (info?.error) {
      const err = document.createElement("div");
      err.className = "hint";
      err.textContent = info.error;
      button.append(err);
    }
    li.append(button);
    els.streamList.append(li);
  }
}

async function inspectOne(url, ctx) {
  try {
    const info = await inspectStream(url, ctx);
    inspected.set(url, info);
    return info;
  } catch (err) {
    const info = { url, error: err.message || String(err) };
    inspected.set(url, info);
    return info;
  }
}

async function refresh(inspectAll = true) {
  const tab = await currentTab();
  if (!tab?.id) {
    setStatus("找不到当前标签页。", "error");
    return;
  }
  activeTabId = tab.id;
  if (tab.url && !els.pageUrl.value) els.pageUrl.value = tab.url;
  const reply = await send("getTabState", { tabId: tab.id });
  const state = reply?.state || { playlists: [], hostHeaders: {}, pageUrl: tab.url || "" };
  if (inspectAll) {
    for (const item of state.playlists || []) {
      await inspectOne(item.url, buildCtx(tab, state, item));
    }
  }
  if (selectedUrl && !(state.playlists || []).some((p) => p.url === selectedUrl)) {
    selectedUrl = "";
  }
  if (!selectedUrl && state.playlists?.[0]) selectedUrl = state.playlists[0].url;
  renderStreams(state);
  renderVariants(inspected.get(selectedUrl));
}

async function selectStream(url) {
  selectedUrl = url;
  const tab = await currentTab();
  const reply = await send("getTabState", { tabId: tab.id });
  const state = reply?.state || {};
  const entry = (state.playlists || []).find((p) => p.url === url);
  const info = inspected.get(url) || (await inspectOne(url, buildCtx(tab, state, entry)));
  renderStreams(state);
  renderVariants(info);
  if (info.error) setStatus(info.error, "error");
  else setStatus("已选择流。确认清晰度后即可下载。");
}

async function createOutput(saveMaterials, filename) {
  if (saveMaterials) {
    const dir = await window.showDirectoryPicker();
    const fileHandle = await dir.getFileHandle(filename, { create: true });
    const writable = await fileHandle.createWritable();
    return {
      writable,
      fileHandle,
      materialWriter: {
        async writeText(name, text) {
          const handle = await dir.getFileHandle(name, { create: true });
          const writer = await handle.createWritable();
          await writer.write(text);
          await writer.close();
        },
        async writeBytes(name, bytes) {
          const handle = await dir.getFileHandle(name, { create: true });
          const writer = await handle.createWritable();
          await writer.write(bytes);
          await writer.close();
        },
      },
    };
  }
  const fileHandle = await window.showSaveFilePicker({
    suggestedName: filename,
    types: [{ description: "MPEG-TS", accept: { "video/mp2t": [".ts"] } }],
  });
  return {
    writable: await fileHandle.createWritable(),
    fileHandle,
    materialWriter: null,
  };
}

async function removeIncomplete(fileHandle) {
  try {
    if (fileHandle && "remove" in fileHandle) await fileHandle.remove();
  } catch {
    // ignore
  }
}

els.openPage.addEventListener("click", async () => {
  const value = els.pageUrl.value.trim();
  if (!value) {
    setStatus("请先粘贴网页链接。", "error");
    return;
  }
  const tab = await currentTab();
  await chrome.tabs.update(tab.id, { url: value });
  setStatus("已打开页面。请开始播放，然后点刷新。");
});

els.addM3u8.addEventListener("click", async () => {
  const url = els.m3u8Url.value.trim();
  if (!url) {
    setStatus("请先粘贴 m3u8 链接。", "error");
    return;
  }
  const tab = await currentTab();
  await send("addManualPlaylist", { tabId: tab.id, url });
  selectedUrl = url;
  await refresh(true);
  await selectStream(url);
});

els.refresh.addEventListener("click", async () => {
  setStatus("正在解析播放列表…");
  await refresh(true);
  setStatus("已刷新。");
});

els.clear.addEventListener("click", async () => {
  const tab = await currentTab();
  await send("clearTabPlaylists", { tabId: tab.id });
  inspected.clear();
  selectedUrl = "";
  renderVariants(null);
  await refresh(false);
  setStatus("已清空当前标签页的检测记录。");
});

els.streamList.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-url]");
  if (!button) return;
  await selectStream(button.dataset.url);
});

els.download.addEventListener("click", async () => {
  if (!selectedUrl) {
    setStatus("请先选择一条流。", "error");
    return;
  }
  const tab = await currentTab();
  const reply = await send("getTabState", { tabId: tab.id });
  const state = reply?.state || {};
  const entry = (state.playlists || []).find((p) => p.url === selectedUrl);
  abortController = new AbortController();
  const ctx = buildCtx(tab, state, entry);
  let writable = null;
  let fileHandle = null;
  let wrote = false;
  els.download.disabled = true;
  els.stop.disabled = false;
  els.progressWrap.hidden = false;
  els.progressBar.style.width = "0%";
  setStatus("正在校验首个分片（先解密，确认是 MPEG-TS）…");
  try {
    const prepared = await prepareDownload(selectedUrl, els.variant.value || "", ctx);
    setStatus("首片已解密并通过 MPEG-TS 校验，请选择保存位置…");
    const output = await createOutput(els.saveMaterials.checked, suggestedName(tab));
    writable = output.writable;
    fileHandle = output.fileHandle;
    const result = await runDownload({
      playlistUrl: selectedUrl,
      variantUrl: els.variant.value || "",
      ctx,
      writable,
      prepared,
      materialWriter: output.materialWriter,
      saveMaterials: els.saveMaterials.checked,
      onProgress: (p) => {
        wrote = true;
        const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
        els.progressBar.style.width = `${pct}%`;
        els.progressText.textContent = `${p.message} · ${formatBytes(p.writtenBytes)}`;
      },
    });
    await writable.close();
    writable = null;
    setStatus(
      `完成：已解密 ${result.segmentCount} 个分片，写出 ${formatBytes(result.writtenBytes)}（${result.encryption}）。可用本地播放器打开 .ts。`,
      "ok"
    );
  } catch (err) {
    if (writable) {
      try {
        await writable.abort();
      } catch {
        try {
          await writable.close();
        } catch {
          // ignore
        }
      }
    }
    if (wrote) await removeIncomplete(fileHandle);
    setStatus(err.message || String(err), "error");
  } finally {
    abortController = null;
    els.stop.disabled = true;
    els.download.disabled = !selectedUrl;
  }
});

els.stop.addEventListener("click", () => {
  abortController?.abort();
  setStatus("正在停止…");
});

chrome.storage.session.onChanged.addListener(async (changes) => {
  if (!activeTabId) return;
  if (!changes[`tab_${activeTabId}`]) return;
  await refresh(false);
});

chrome.tabs.onActivated.addListener(async (info) => {
  if (info.tabId !== activeTabId) {
    inspected.clear();
    selectedUrl = "";
    await refresh(true);
  }
});

await refresh(true);
setStatus("准备就绪。在视频页点播放后，点刷新以捕获 m3u8。");
