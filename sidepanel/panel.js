import {
  clearDefaultDir,
  createFileInDir,
  dirDisplayName,
  getAuthorizedDefaultDir,
  loadDefaultDir,
  materialWriterForDir,
  pickDefaultDir,
} from "../lib/download-dir.js";
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
  dirLabel: document.getElementById("dir-label"),
  pickDir: document.getElementById("pick-dir"),
  clearDir: document.getElementById("clear-dir"),
  saveMaterials: document.getElementById("save-materials"),
  download: document.getElementById("download"),
  stop: document.getElementById("stop"),
  otherJobs: document.getElementById("other-jobs"),
  progressWrap: document.getElementById("progress-wrap"),
  progressBar: document.getElementById("progress-bar"),
  progressText: document.getElementById("progress-text"),
  status: document.getElementById("status"),
};

const views = new Map();
const jobs = new Map();
let activeTabId = null;
let paintedTabId = null;
let paintGen = 0;

function emptyView() {
  return {
    inspected: new Map(),
    selectedUrl: "",
    variantUrl: "",
    pageUrl: "",
    m3u8Url: "",
    playlists: [],
    statePageUrl: "",
    status: "",
    statusKind: "",
    progressHidden: true,
    progressPct: 0,
    progressText: "",
  };
}

function getView(tabId) {
  if (tabId == null) return emptyView();
  if (!views.has(tabId)) views.set(tabId, emptyView());
  return views.get(tabId);
}

function snapshotView(tabId) {
  if (tabId == null || tabId !== paintedTabId || !views.has(tabId)) return;
  const view = views.get(tabId);
  view.pageUrl = els.pageUrl.value;
  view.m3u8Url = els.m3u8Url.value;
  view.variantUrl = els.variant.value || view.variantUrl;
  view.status = els.status.textContent;
  view.statusKind = els.status.className.replace(/^status\s*/, "").trim();
  view.progressHidden = els.progressWrap.hidden;
  view.progressPct = Number.parseInt(els.progressBar.style.width, 10) || 0;
  view.progressText = els.progressText.textContent;
}

function setStatus(text, kind = "", tabId = activeTabId) {
  if (tabId != null) {
    const view = getView(tabId);
    view.status = text;
    view.statusKind = kind;
  }
  if (tabId === activeTabId) {
    els.status.textContent = text;
    els.status.className = `status ${kind}`.trim();
  }
}

function applyStatus(view) {
  els.status.textContent = view.status;
  els.status.className = `status ${view.statusKind}`.trim();
}

function setProgress(tabId, patch) {
  const view = getView(tabId);
  if (patch.hidden !== undefined) view.progressHidden = patch.hidden;
  if (patch.pct !== undefined) view.progressPct = patch.pct;
  if (patch.text !== undefined) view.progressText = patch.text;
  if (tabId === activeTabId) applyProgress(view);
}

function applyProgress(view) {
  els.progressWrap.hidden = view.progressHidden;
  els.progressBar.style.width = `${view.progressPct}%`;
  els.progressText.textContent = view.progressText;
}

function canStartDownload(tabId) {
  if (jobs.has(tabId)) return false;
  const view = getView(tabId);
  const info = view.inspected.get(view.selectedUrl);
  if (!info || info.error) return false;
  return Boolean(info.variants?.length || info.playlist?.segments?.length);
}

function applyJobButtons(tabId = activeTabId) {
  if (tabId !== activeTabId) return;
  els.download.disabled = !canStartDownload(tabId);
  els.stop.disabled = !jobs.has(tabId);
}

function updateOtherJobsHint() {
  const others = [...jobs.keys()].filter((id) => id !== activeTabId).length;
  if (others <= 0) {
    els.otherJobs.hidden = true;
    els.otherJobs.textContent = "";
    return;
  }
  els.otherJobs.hidden = false;
  els.otherJobs.textContent = `另有 ${others} 个标签页正在下载`;
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

function buildCtx(tab, state, playlistEntry, tabId = tab.id) {
  return {
    tabId: tab.id,
    pageUrl: state.pageUrl || tab.url || "",
    capturedHeaders: playlistEntry?.requestHeaders || {},
    hostHeaders: state.hostHeaders || {},
    signal: jobs.get(tabId)?.controller?.signal,
  };
}

function suggestedName(tab, ext = "ts") {
  const raw = (tab?.title || "video").replace(/[\\/:*?"<>|]+/g, " ").trim() || "video";
  return `${raw.slice(0, 60)}.${ext}`;
}

function renderDirLabel(handle) {
  const name = dirDisplayName(handle);
  els.dirLabel.textContent = name ? name : "未设置（每次选择位置）";
  els.dirLabel.title = name;
  els.clearDir.disabled = !handle;
}

function paintShell(tabId) {
  const view = getView(tabId);
  if (!view.status) {
    view.status = "准备就绪。在视频页点播放后，点刷新以捕获 m3u8。";
  }
  paintedTabId = tabId;
  els.pageUrl.value = view.pageUrl;
  els.m3u8Url.value = view.m3u8Url;
  renderStreams({ playlists: view.playlists, pageUrl: view.statePageUrl || view.pageUrl }, view);
  renderVariants(view.inspected.get(view.selectedUrl), view);
  applyStatus(view);
  applyProgress(view);
  applyJobButtons(tabId);
  updateOtherJobsHint();
}

function switchActiveTab(nextId) {
  if (activeTabId === nextId) return;
  snapshotView(activeTabId);
  activeTabId = nextId;
  paintGen += 1;
  paintShell(nextId);
}

function renderVariants(info, view = getView(activeTabId)) {
  els.variant.innerHTML = "";
  if (info?.error) {
    els.variant.disabled = true;
    els.variant.append(new Option(info.error, ""));
    applyJobButtons();
    return;
  }
  if (info?.variants?.length) {
    for (const variant of info.variants) {
      els.variant.append(new Option(variant.label, variant.url));
    }
    const chosen =
      view.variantUrl && info.variants.some((v) => v.url === view.variantUrl)
        ? view.variantUrl
        : info.defaultVariant?.url || info.variants[0].url;
    els.variant.value = chosen;
    view.variantUrl = chosen;
    els.variant.disabled = false;
    applyJobButtons();
    return;
  }
  if (info?.playlist?.segments?.length) {
    const count = info.playlist.segments.length;
    const format = info.playlist.hasMap ? " · fMP4" : "";
    const label =
      info.summary.encryption === "aes-128"
        ? `媒体列表 · AES-128${format} · ${count} 分片`
        : `媒体列表 · 明文${format} · ${count} 分片`;
    els.variant.append(new Option(label, ""));
    els.variant.disabled = true;
    applyJobButtons();
    return;
  }
  els.variant.append(new Option("没有可下载的分片", ""));
  els.variant.disabled = true;
  applyJobButtons();
}

function renderStreams(state, view = getView(activeTabId)) {
  els.streamList.innerHTML = "";
  const playlists = state.playlists || [];
  if (!playlists.length) {
    els.pageHint.textContent = "打开视频页并开始播放，播放器请求 m3u8 后会出现在这里。";
    return;
  }
  els.pageHint.textContent = `当前页：${state.pageUrl || "未知"}`;
  for (const item of playlists) {
    const info = view.inspected.get(item.url);
    const badge = encryptionBadge(info);
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = `stream${item.url === view.selectedUrl ? " active" : ""}`;
    button.dataset.url = item.url;
    const top = document.createElement("div");
    const mark = document.createElement("span");
    mark.className = `badge ${badge.cls}`.trim();
    mark.textContent = badge.text;
    top.append(mark);
    if (info?.playlist?.segments?.length) {
      const extra = document.createElement("span");
      extra.className = "hint";
      extra.textContent = info.playlist.hasMap
        ? ` ${info.playlist.segments.length} 分片 · fMP4`
        : ` ${info.playlist.segments.length} 分片`;
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

async function inspectOne(url, ctx, tabId = activeTabId) {
  const view = getView(tabId);
  try {
    const info = await inspectStream(url, ctx);
    view.inspected.set(url, info);
    return info;
  } catch (err) {
    const info = { url, error: err.message || String(err) };
    view.inspected.set(url, info);
    return info;
  }
}

function shouldPaint(tabId, gen) {
  return tabId === activeTabId && gen === paintGen;
}

async function loadTabUi(tab, inspectAll) {
  const tabId = tab.id;
  if (tabId === activeTabId) paintGen += 1;
  const gen = paintGen;
  const view = getView(tabId);
  if (tab.url && !view.pageUrl) view.pageUrl = tab.url;
  if (!view.status) {
    view.status = "准备就绪。在视频页点播放后，点刷新以捕获 m3u8。";
  }
  const reply = await send("getTabState", { tabId });
  if (tabId === activeTabId && gen !== paintGen) return;
  const state = reply?.state || { playlists: [], hostHeaders: {}, pageUrl: tab.url || "" };
  const playlists = state.playlists || [];
  if (!playlists.length) {
    view.inspected.clear();
    view.selectedUrl = "";
    view.variantUrl = "";
    if (tab.url) view.pageUrl = tab.url;
  }
  view.playlists = playlists;
  view.statePageUrl = state.pageUrl || tab.url || "";
  for (const item of playlists) {
    if (!inspectAll && view.inspected.has(item.url)) continue;
    if (tabId === activeTabId && gen !== paintGen) return;
    await inspectOne(item.url, buildCtx(tab, state, item, tabId), tabId);
    if (shouldPaint(tabId, gen)) paintShell(tabId);
  }
  if (view.selectedUrl && !playlists.some((p) => p.url === view.selectedUrl)) {
    view.selectedUrl = "";
  }
  if (!view.selectedUrl && playlists[0]) view.selectedUrl = playlists[0].url;
  if (!shouldPaint(tabId, gen)) return;
  paintShell(tabId);
}

async function refresh(inspectAll = true, tabId = activeTabId) {
  if (tabId == null) {
    const tab = await currentTab();
    tabId = tab?.id;
  }
  if (tabId == null) {
    setStatus("找不到当前标签页。", "error");
    return;
  }
  try {
    const tab = await chrome.tabs.get(tabId);
    await loadTabUi(tab, inspectAll);
  } catch {
    if (activeTabId === tabId) setStatus("找不到当前标签页。", "error", tabId);
  }
}

async function selectStream(url) {
  const tab = await currentTab();
  if (!tab?.id) return;
  const view = getView(tab.id);
  view.selectedUrl = url;
  view.variantUrl = "";
  const reply = await send("getTabState", { tabId: tab.id });
  const state = reply?.state || {};
  const entry = (state.playlists || []).find((p) => p.url === url);
  const info = view.inspected.get(url) || (await inspectOne(url, buildCtx(tab, state, entry, tab.id), tab.id));
  if (activeTabId !== tab.id) return;
  renderStreams(state, view);
  renderVariants(info, view);
  if (info.error) setStatus(info.error, "error", tab.id);
  else setStatus("已选择流。确认清晰度后即可下载。", "", tab.id);
}

async function createOutput(saveMaterials, filename, ext = "ts", authorizedDir = null) {
  if (authorizedDir) {
    const created = await createFileInDir(authorizedDir, filename);
    return {
      writable: created.writable,
      fileHandle: created.fileHandle,
      materialWriter: saveMaterials ? materialWriterForDir(authorizedDir) : null,
    };
  }
  if (saveMaterials) {
    const dir = await window.showDirectoryPicker({ id: "hls-default-dir", mode: "readwrite" });
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
  const types =
    ext === "mp4"
      ? [{ description: "MPEG-4", accept: { "video/mp4": [".mp4"] } }]
      : [{ description: "MPEG-TS", accept: { "video/mp2t": [".ts"] } }];
  const fileHandle = await window.showSaveFilePicker({
    suggestedName: filename,
    types,
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

async function abortJobFiles(job) {
  if (job.writable) {
    try {
      await job.writable.abort();
    } catch {
      try {
        await job.writable.close();
      } catch {
        // ignore
      }
    }
    job.writable = null;
  }
  if (job.wrote) await removeIncomplete(job.fileHandle);
}

function finishJob(tabId, job) {
  if (jobs.get(tabId) === job) jobs.delete(tabId);
  applyJobButtons(tabId);
  updateOtherJobsHint();
}

els.openPage.addEventListener("click", async () => {
  const value = els.pageUrl.value.trim();
  if (!value) {
    setStatus("请先粘贴网页链接。", "error");
    return;
  }
  const tab = await currentTab();
  await chrome.tabs.update(tab.id, { url: value });
  getView(tab.id).pageUrl = value;
  setStatus("已打开页面。请开始播放，然后点刷新。", "", tab.id);
});

els.addM3u8.addEventListener("click", async () => {
  const url = els.m3u8Url.value.trim();
  if (!url) {
    setStatus("请先粘贴 m3u8 链接。", "error");
    return;
  }
  const tab = await currentTab();
  const view = getView(tab.id);
  view.m3u8Url = url;
  await send("addManualPlaylist", { tabId: tab.id, url });
  view.selectedUrl = url;
  await refresh(true, tab.id);
  await selectStream(url);
});

els.refresh.addEventListener("click", async () => {
  const tabId = activeTabId;
  setStatus("正在解析播放列表…", "", tabId);
  await refresh(true, tabId);
  if (activeTabId === tabId) setStatus("已刷新。", "", tabId);
});

els.clear.addEventListener("click", async () => {
  const tab = await currentTab();
  await send("clearTabPlaylists", { tabId: tab.id });
  const view = getView(tab.id);
  view.inspected.clear();
  view.selectedUrl = "";
  view.variantUrl = "";
  view.playlists = [];
  view.statePageUrl = "";
  if (activeTabId === tab.id) paintShell(tab.id);
  await refresh(false, tab.id);
  setStatus("已清空当前标签页的检测记录。", "", tab.id);
});

els.streamList.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-url]");
  if (!button) return;
  await selectStream(button.dataset.url);
});

els.variant.addEventListener("change", () => {
  if (activeTabId == null) return;
  getView(activeTabId).variantUrl = els.variant.value;
});

els.pickDir.addEventListener("click", async () => {
  try {
    const handle = await pickDefaultDir();
    renderDirLabel(handle);
    setStatus(`已设置默认目录：${dirDisplayName(handle)}`);
  } catch (err) {
    if (err?.name === "AbortError") return;
    setStatus(err.message || String(err), "error");
  }
});

els.clearDir.addEventListener("click", async () => {
  await clearDefaultDir();
  renderDirLabel(null);
  setStatus("已清除默认目录。下次下载会再选择位置。");
});

els.download.addEventListener("click", async () => {
  const tab = await currentTab();
  if (!tab?.id) {
    setStatus("找不到当前标签页。", "error");
    return;
  }
  const view = getView(tab.id);
  if (!view.selectedUrl) {
    setStatus("请先选择一条流。", "error", tab.id);
    return;
  }
  if (jobs.has(tab.id)) {
    setStatus("该标签页已有下载任务。", "error", tab.id);
    return;
  }
  const variantUrl = els.variant.value || view.variantUrl || "";
  const reply = await send("getTabState", { tabId: tab.id });
  const state = reply?.state || {};
  const entry = (state.playlists || []).find((p) => p.url === view.selectedUrl);
  const job = {
    controller: new AbortController(),
    writable: null,
    fileHandle: null,
    wrote: false,
  };
  jobs.set(tab.id, job);
  applyJobButtons(tab.id);
  updateOtherJobsHint();
  setProgress(tab.id, { hidden: false, pct: 0, text: "" });
  const ctx = buildCtx(tab, state, entry, tab.id);
  setStatus("正在准备保存位置…", "", tab.id);
  let authorizedDir = null;
  try {
    authorizedDir = await getAuthorizedDefaultDir();
    if (!authorizedDir) renderDirLabel(null);
  } catch {
    authorizedDir = null;
    renderDirLabel(null);
  }
  setStatus("正在校验首个分片（先解密，确认是 MPEG-TS 或 fMP4）…", "", tab.id);
  try {
    const prepared = await prepareDownload(view.selectedUrl, variantUrl, ctx);
    const ext = prepared.media.playlist.hasMap ? "mp4" : "ts";
    setStatus(
      authorizedDir
        ? `首片已通过校验，正在保存到 ${dirDisplayName(authorizedDir)}…`
        : "首片已解密并通过校验，请选择保存位置…",
      "",
      tab.id
    );
    const output = await createOutput(
      els.saveMaterials.checked,
      suggestedName(tab, ext),
      ext,
      authorizedDir
    );
    job.writable = output.writable;
    job.fileHandle = output.fileHandle;
    const result = await runDownload({
      playlistUrl: view.selectedUrl,
      variantUrl,
      ctx,
      writable: job.writable,
      prepared,
      materialWriter: output.materialWriter,
      saveMaterials: els.saveMaterials.checked,
      onProgress: (p) => {
        if (jobs.get(tab.id) !== job) return;
        job.wrote = true;
        const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
        setProgress(tab.id, {
          hidden: false,
          pct,
          text: `${p.message} · ${formatBytes(p.writtenBytes)}`,
        });
      },
    });
    await job.writable.close();
    job.writable = null;
    const dest = authorizedDir ? `，已写入 ${dirDisplayName(authorizedDir)}` : "";
    setProgress(tab.id, { hidden: false, pct: 100 });
    setStatus(
      `完成：已解密 ${result.segmentCount} 个分片，写出 ${formatBytes(result.writtenBytes)}（${result.encryption}）${dest}。可用本地播放器打开 .${ext}。`,
      "ok",
      tab.id
    );
  } catch (err) {
    await abortJobFiles(job);
    setStatus(err.message || String(err), "error", tab.id);
  } finally {
    finishJob(tab.id, job);
  }
});

els.stop.addEventListener("click", () => {
  const job = jobs.get(activeTabId);
  if (!job) return;
  job.controller.abort();
  setStatus("正在停止…", "", activeTabId);
});

chrome.storage.session.onChanged.addListener(async (changes) => {
  const tabId = activeTabId;
  if (!tabId) return;
  if (!changes[`tab_${tabId}`]) return;
  await refresh(false, tabId);
});

chrome.tabs.onActivated.addListener(async (info) => {
  if (info.tabId === activeTabId) return;
  switchActiveTab(info.tabId);
  try {
    const tab = await chrome.tabs.get(info.tabId);
    await loadTabUi(tab, false);
  } catch {
    setStatus("找不到当前标签页。", "error", info.tabId);
    applyJobButtons(info.tabId);
    updateOtherJobsHint();
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const job = jobs.get(tabId);
  if (job) {
    job.controller.abort();
    jobs.delete(tabId);
    abortJobFiles(job).catch(() => {});
  }
  views.delete(tabId);
  if (activeTabId === tabId) activeTabId = null;
  if (paintedTabId === tabId) paintedTabId = null;
  updateOtherJobsHint();
});

els.pageUrl.addEventListener("input", () => {
  if (activeTabId != null) getView(activeTabId).pageUrl = els.pageUrl.value;
});

els.m3u8Url.addEventListener("input", () => {
  if (activeTabId != null) getView(activeTabId).m3u8Url = els.m3u8Url.value;
});

renderDirLabel(await loadDefaultDir());
{
  const tab = await currentTab();
  if (tab?.id) {
    activeTabId = tab.id;
    paintGen += 1;
    paintShell(tab.id);
    await loadTabUi(tab, true);
  } else {
    setStatus("找不到当前标签页。", "error");
  }
}
