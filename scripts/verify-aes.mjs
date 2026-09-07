import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decryptAes128Cbc,
  decryptHlsSegment,
  looksLikeFmp4,
  looksLikeMpegTs,
  mediaSequenceIv,
  resolveSegmentIv,
} from "../lib/hls-aes.js";
import { parseM3u8, summarizePlaylist } from "../lib/m3u8.js";

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function hexToBytes(hex) {
  const clean = hex.replace(/^0x/, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function makeTsPackets(count, seed = 7) {
  const bytes = new Uint8Array(count * 188);
  for (let i = 0; i < count; i += 1) {
    bytes[i * 188] = 0x47;
    for (let j = 1; j < 188; j += 1) bytes[i * 188 + j] = (seed + i + j) & 0xff;
  }
  return bytes;
}

async function encryptTs(plain, key, iv) {
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "AES-CBC" }, false, ["encrypt"]);
  return new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv }, cryptoKey, plain));
}

const sampleMaster = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360
mid.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720
high.m3u8
`;

const sampleMedia = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXT-X-MEDIA-SEQUENCE:5
#EXT-X-KEY:METHOD=AES-128,URI="https://example.com/k1.key"
#EXTINF:9.0,
a.ts
#EXT-X-KEY:METHOD=AES-128,URI="https://example.com/k2.key",IV=0x0000000000000000000000000000000A
#EXTINF:9.0,
b.ts
#EXT-X-KEY:METHOD=NONE
#EXTINF:9.0,
c.ts
#EXT-X-ENDLIST
`;

const sampleMap = `#EXTM3U
#EXT-X-MEDIA-SEQUENCE:9
#EXT-X-KEY:METHOD=AES-128,URI="https://example.com/k.map.key"
#EXT-X-MAP:URI="init.mp4",BYTERANGE="720@0"
#EXTINF:1,
seg.m4s
#EXT-X-MAP:URI="init2.mp4"
#EXTINF:1,
seg2.m4s
`;

function makeFtypBox() {
  const bytes = new Uint8Array(20);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 20);
  bytes.set([0x66, 0x74, 0x79, 0x70], 4);
  bytes.set([0x69, 0x73, 0x6f, 0x6d], 8);
  bytes.set([0x69, 0x73, 0x6f, 0x6d], 16);
  return bytes;
}

const failed = [];
let passed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log("ok ", name);
  } catch (err) {
    failed.push(`${name}: ${err.message}`);
    console.error("FAIL", name, err.message);
  }
}

await test("parse master playlist", () => {
  const p = parseM3u8(sampleMaster, "https://cdn.example/master.m3u8");
  assert(p.kind === "master", `kind=${p.kind}`);
  assert(p.variants.length === 2, "need 2 variants");
  assert(p.variants[1].url.endsWith("/high.m3u8"), p.variants[1].url);
});

await test("parse AES-128 key rotation and sequence IV", () => {
  const p = parseM3u8(sampleMedia, "https://cdn.example/media.m3u8");
  const summary = summarizePlaylist(p);
  assert(summary.encryption === "aes-128", summary.encryption);
  assert(p.segments.length === 3, "need 3 segments");
  assert(p.segments[0].mediaSequence === 5, String(p.segments[0].mediaSequence));
  assert(p.segments[0].key.method === "AES-128", p.segments[0].key.method);
  assert(p.segments[0].key.uri === "https://example.com/k1.key", p.segments[0].key.uri);
  assert(p.segments[0].key.iv === null, "first key has no IV");
  assert(p.segments[1].key.uri.endsWith("k2.key"), p.segments[1].key.uri);
  assert(p.segments[1].key.iv[15] === 0x0a, "explicit IV last byte");
  assert(p.segments[2].key.method === "NONE", "key cleared");
});

await test("parse fMP4 map playlists", () => {
  const p = parseM3u8(sampleMap, "https://cdn.example/map.m3u8");
  assert(p.hasMap, "should detect map");
  assert(!p.unsupportedReason, p.unsupportedReason);
  assert(p.segments.length === 2, "need 2 segments");
  assert(p.segments[0].map.url.endsWith("/init.mp4"), p.segments[0].map.url);
  assert(p.segments[0].map.byteRange?.offset === 0, "map offset");
  assert(p.segments[0].map.byteRange?.length === 720, "map length");
  assert(p.segments[0].map.key.method === "AES-128", "map inherits key");
  assert(p.segments[0].map.key.uri.endsWith("k.map.key"), p.segments[0].map.key.uri);
  assert(p.segments[0].map.mediaSequence === 9, String(p.segments[0].map.mediaSequence));
  assert(p.segments[1].map.url.endsWith("/init2.mp4"), p.segments[1].map.url);
  assert(p.segments[1].map.mediaSequence === 10, String(p.segments[1].map.mediaSequence));
  assert(looksLikeFmp4(makeFtypBox()), "ftyp fixture should look like fMP4");
});

await test("media sequence IV is 128-bit big-endian", () => {
  const iv = mediaSequenceIv(5);
  assert(iv.length === 16, "iv length");
  assert([...iv.slice(0, 15)].every((b) => b === 0), "high bytes zero");
  assert(iv[15] === 5, `last byte ${iv[15]}`);
  const resolved = resolveSegmentIv({ method: "AES-128", iv: null }, 5);
  assert(resolved[15] === 5, "resolve fallback");
});

await test("decrypt PKCS7 AES-128 TS and reject ciphertext", async () => {
  const key = hexToBytes("00112233445566778899aabbccddeeff");
  const iv = mediaSequenceIv(5);
  const plain = makeTsPackets(3);
  const cipher = await encryptTs(plain, key, iv);
  assert(!looksLikeMpegTs(cipher), "ciphertext must not look like TS");
  const out = await decryptAes128Cbc(key, iv, cipher);
  assert(looksLikeMpegTs(out), "decrypted should be TS");
  assert(out.length === plain.length, `len ${out.length} != ${plain.length}`);
  assert(out.every((b, i) => b === plain[i]), "roundtrip mismatch");

  const tmp = join(tmpdir(), `hls-aes-verify-${Date.now()}.ts`);
  await writeFile(tmp, out);
  const { readFile } = await import("node:fs/promises");
  const saved = new Uint8Array(await readFile(tmp));
  assert(saved[0] === 0x47, "saved file starts with sync byte");
  await unlink(tmp);
});

await test("wrong key does not produce a fake TS file", async () => {
  const key = hexToBytes("00112233445566778899aabbccddeeff");
  const wrong = hexToBytes("ffffffffffffffffffffffffffffffff");
  const iv = mediaSequenceIv(1);
  const plain = makeTsPackets(2);
  const cipher = await encryptTs(plain, key, iv);
  let threw = false;
  try {
    await decryptAes128Cbc(wrong, iv, cipher);
  } catch (err) {
    threw = true;
    assert(err.message.includes("MPEG-TS") || err.message.includes("fMP4"), err.message);
  }
  assert(threw, "wrong key should throw instead of writing garbage");
  assert(!looksLikeMpegTs(cipher), "do not treat ciphertext as TS");
});

await test("decrypt PKCS7 AES-128 fMP4", async () => {
  const key = hexToBytes("00112233445566778899aabbccddeeff");
  const iv = mediaSequenceIv(1);
  const plain = makeFtypBox();
  const cipher = await encryptTs(plain, key, iv);
  assert(!looksLikeFmp4(cipher), "ciphertext must not look like fMP4");
  const out = await decryptAes128Cbc(key, iv, cipher);
  assert(looksLikeFmp4(out), "decrypted should be fMP4");
  assert(out.length === plain.length, `len ${out.length} != ${plain.length}`);
  assert(out.every((b, i) => b === plain[i]), "roundtrip mismatch");
});

const liveUrl =
  process.env.HLS_AES_TEST_URL ||
  "https://playertest.longtailvideo.com/adaptive/oceans_aes/oceans_aes.m3u8";

await test("public AES-128 stream decrypts to MPEG-TS", async () => {
  let res;
  try {
    res = await fetch(liveUrl);
  } catch (err) {
    console.log("   skipped (network)", err.message);
    return;
  }
  if (!res.ok) {
    console.log("   skipped HTTP", res.status);
    return;
  }
  const text = await res.text();
  const playlist = parseM3u8(text, liveUrl);
  assert(playlist.kind === "master" || playlist.segments.length > 0, "empty playlist");
  let media = playlist;
  if (playlist.variants.length) {
    const mediaUrl = playlist.variants[0].url;
    media = parseM3u8(await (await fetch(mediaUrl)).text(), mediaUrl);
  }
  const seg = media.segments[0];
  assert(seg, "no segments");
  if (seg.key.method !== "AES-128") return;
  const key = new Uint8Array(await (await fetch(seg.key.uri)).arrayBuffer());
  assert(key.length === 16, `key ${key.length}`);
  const cipher = new Uint8Array(await (await fetch(seg.url)).arrayBuffer());
  assert(!looksLikeMpegTs(cipher), "ciphertext must not look like TS");
  const { bytes } = await decryptHlsSegment(cipher, seg.key, key, seg.mediaSequence);
  assert(looksLikeMpegTs(bytes), "decrypted public segment must be MPEG-TS");
  assert(bytes[0] === 0x47, "sync byte");
});

if (failed.length) {
  console.error(`\n${passed} passed, ${failed.length} failed`);
  for (const item of failed) console.error("-", item);
  process.exit(1);
}

console.log(`\n${passed} passed`);
