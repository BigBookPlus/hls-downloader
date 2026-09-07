# HLS AES-128 Downloader

Chrome Manifest V3 侧边栏：拦截页面 HLS，按 `#EXT-X-KEY:METHOD=AES-128` 的 key/IV **先解密再写入**。不会把密文 `.ts` 拼成 `1.ts`。

这是个人解压加载的开源工具，**不上架 Chrome 应用商店，也没有收费版**。反馈请走 GitHub Issues。

公开测试流（可在侧边栏粘贴 m3u8）：<https://playertest.longtailvideo.com/adaptive/oceans_aes/oceans_aes.m3u8>

## Acceptable use

只保存**你有权保存**的内容（例如自己托管的流、权利人明确允许的副本）。

- 密钥常有时效，并可能依赖登录 Cookie。过期或 401/403 时请自己重新点播，不要把密文当 TS 保存。
- 作者不提供：破解具体网站、绕过登录/付费墙、针对某版权站的适配、把密文重封装当成品。
- 标准 HLS AES-128（RFC 8216）不是 Widevine / FairPlay / PlayReady。本仓库不实现那些 DRM。
- 滥用与作者无关。详见 [NOTICE.md](NOTICE.md)。

## 故意不做

- Widevine / FairPlay / PlayReady / `SAMPLE-AES`
- fMP4 / `#EXT-X-MAP`
- 浏览器内转 MP4（解密后的 `.ts` 可直接播；若要 mp4，用本机 `ffmpeg -i video.ts -c copy video.mp4`，不要对密文 remux）
- Chrome Web Store 上架、付费墙、预置「版权域名黑名单」

## 加载

1. 打开 `chrome://extensions`
2. 打开「开发者模式」
3. 「加载已解压的扩展程序」，选**本仓库根目录**（含 `manifest.json` 的这一层）
4. 打开视频页并开始播放，让播放器请求 `.m3u8`
5. 点击扩展图标打开侧边栏
6. 选流 / 清晰度，点 **下载并解密**
7. 下载过程中不要关闭侧边栏
8. 用 VLC / PotPlayer 打开保存的 `.ts`

也可以在侧边栏粘贴网页链接或 m3u8。勾选 **同时保存材料** 并选文件夹时，会额外写下 `source.m3u8` 和 `key.bin`。

## 它做什么

- 拦截 `.m3u8` / MPEGURL，把 URL 与 Cookie / Referer / Authorization 记在 `chrome.storage.session`
- 解析主播放列表，让你选码率
- 下载 16 字节 AES-128 key
- 按分片做 AES-128-CBC：有 `IV=0x...` 用它，否则用 media sequence 作为 128-bit 大端 IV
- 校验解密结果是 MPEG-TS（`0x47`，188 字节对齐）后再按序写入
- 首片先解密通过，再弹出保存对话框

## 权限为何需要

本扩展只在你本机工作，没有作者的后台、也不上传播放列表或密钥。

| 权限 | 用途 |
| --- | --- |
| `tabs` | 读取当前页 URL，方便贴链打开 |
| `webRequest` | 看到播放器请求 m3u8/key 时的头 |
| `cookies` | 复放站点 Cookie 去拉 key / 分片 |
| `scripting` | 扩展请求被拒时，仅对小体积的 playlist/key 做页面内回退 |
| `storage` | Service Worker 会休眠，状态放 session storage |
| `sidePanel` | 下载必须在侧边栏跑，SW 撑不住长任务 |
| `<all_urls>` | 分片和 key 可能在任意 CDN；扩展 fetch 需要绕过页面 CORS |

## 反馈

用 GitHub Issues。请说明是否 AES-128、是否你有权保存的内容、公开可复现的 m3u8（如上面的 `oceans_aes`）。

**不要**在 Issue 里贴 Cookie、key 文件、Authorization、或整页抓包。模板会再问一遍。

## 校验

在本目录执行：

```bash
node scripts/verify-aes.mjs
```

会检查播放列表解析、sequence IV、PKCS7 AES-128 往返，以及错误 key 不能通过 TS 校验。默认还会拉公开的 `oceans_aes` 样例，确认解密后第一字节是 `0x47`。指定其它列表：

```bash
set HLS_AES_TEST_URL=https://example.com/index.m3u8
node scripts/verify-aes.mjs
```

## 独立成库

若你从某个大仓库里拷出本目录：GitHub 上应**只发布本目录**（含 `manifest.json` 的根），不要把无关脚本一并 push。

## License

[MIT](LICENSE)
