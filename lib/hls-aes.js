const SBOX = new Uint8Array([
  99, 124, 119, 123, 242, 107, 111, 197, 48, 1, 103, 43, 254, 215, 171, 118, 202, 130, 201, 125, 250, 89, 71, 240, 173,
  212, 162, 175, 156, 164, 114, 192, 183, 253, 147, 38, 54, 63, 247, 204, 52, 165, 229, 241, 113, 216, 49, 21, 4, 199,
  35, 195, 24, 150, 5, 154, 7, 18, 128, 226, 235, 39, 178, 117, 9, 131, 44, 26, 27, 110, 90, 160, 82, 59, 214, 179, 41,
  227, 47, 132, 83, 209, 0, 237, 32, 252, 177, 91, 106, 203, 190, 57, 74, 76, 88, 207, 208, 239, 170, 251, 67, 77, 51,
  133, 69, 249, 2, 127, 80, 60, 159, 168, 81, 163, 64, 143, 146, 157, 56, 245, 188, 182, 218, 33, 16, 255, 243, 210,
  205, 12, 19, 236, 95, 151, 68, 23, 196, 167, 126, 61, 100, 93, 25, 115, 96, 129, 79, 220, 34, 42, 144, 136, 70, 238,
  184, 20, 222, 94, 11, 219, 224, 50, 58, 10, 73, 6, 36, 92, 194, 211, 172, 98, 145, 149, 228, 121, 231, 200, 55, 109,
  141, 213, 78, 169, 108, 86, 244, 234, 101, 122, 174, 8, 186, 120, 37, 46, 28, 166, 180, 198, 232, 221, 116, 31, 75,
  189, 139, 138, 112, 62, 181, 102, 72, 3, 246, 14, 97, 53, 87, 185, 134, 193, 29, 158, 225, 248, 152, 17, 105, 217,
  142, 148, 155, 30, 135, 233, 206, 85, 40, 223, 140, 161, 137, 13, 191, 230, 66, 104, 65, 153, 45, 15, 176, 84, 187, 22,
]);

const INV_SBOX = new Uint8Array(256);
for (let i = 0; i < 256; i += 1) INV_SBOX[SBOX[i]] = i;

const RCON = [0x00, 0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36];

function xtime(a) {
  return ((a << 1) ^ ((a >> 7) * 0x1b)) & 0xff;
}

function mul(a, b) {
  let result = 0;
  let aa = a;
  let bb = b;
  for (let i = 0; i < 8; i += 1) {
    if (bb & 1) result ^= aa;
    aa = xtime(aa);
    bb >>= 1;
  }
  return result;
}

function expandKey(key) {
  if (key.length !== 16) {
    throw new Error(`AES-128 key 必须是 16 字节，实际 ${key.length} 字节`);
  }
  const w = new Uint8Array(176);
  w.set(key);
  let rconIndex = 1;
  for (let i = 16; i < 176; i += 4) {
    let t0 = w[i - 4];
    let t1 = w[i - 3];
    let t2 = w[i - 2];
    let t3 = w[i - 1];
    if (i % 16 === 0) {
      const k0 = t0;
      t0 = SBOX[t1] ^ RCON[rconIndex];
      t1 = SBOX[t2];
      t2 = SBOX[t3];
      t3 = SBOX[k0];
      rconIndex += 1;
    }
    w[i] = w[i - 16] ^ t0;
    w[i + 1] = w[i - 15] ^ t1;
    w[i + 2] = w[i - 14] ^ t2;
    w[i + 3] = w[i - 13] ^ t3;
  }
  return w;
}

function addRoundKey(state, roundKey, offset) {
  for (let i = 0; i < 16; i += 1) state[i] ^= roundKey[offset + i];
}

function invShiftRows(state) {
  const t = Uint8Array.from(state);
  state[1] = t[13];
  state[5] = t[1];
  state[9] = t[5];
  state[13] = t[9];
  state[2] = t[10];
  state[6] = t[14];
  state[10] = t[2];
  state[14] = t[6];
  state[3] = t[7];
  state[7] = t[11];
  state[11] = t[15];
  state[15] = t[3];
}

function invSubBytes(state) {
  for (let i = 0; i < 16; i += 1) state[i] = INV_SBOX[state[i]];
}

function invMixColumns(state) {
  for (let c = 0; c < 4; c += 1) {
    const i = c * 4;
    const a0 = state[i];
    const a1 = state[i + 1];
    const a2 = state[i + 2];
    const a3 = state[i + 3];
    state[i] = mul(a0, 0x0e) ^ mul(a1, 0x0b) ^ mul(a2, 0x0d) ^ mul(a3, 0x09);
    state[i + 1] = mul(a0, 0x09) ^ mul(a1, 0x0e) ^ mul(a2, 0x0b) ^ mul(a3, 0x0d);
    state[i + 2] = mul(a0, 0x0d) ^ mul(a1, 0x09) ^ mul(a2, 0x0e) ^ mul(a3, 0x0b);
    state[i + 3] = mul(a0, 0x0b) ^ mul(a1, 0x0d) ^ mul(a2, 0x09) ^ mul(a3, 0x0e);
  }
}

function decryptBlock(roundKey, block) {
  const state = Uint8Array.from(block);
  addRoundKey(state, roundKey, 160);
  for (let round = 9; round >= 1; round -= 1) {
    invShiftRows(state);
    invSubBytes(state);
    addRoundKey(state, roundKey, round * 16);
    invMixColumns(state);
  }
  invShiftRows(state);
  invSubBytes(state);
  addRoundKey(state, roundKey, 0);
  return state;
}

export function mediaSequenceIv(seq) {
  const iv = new Uint8Array(16);
  const view = new DataView(iv.buffer);
  const value = BigInt(seq >>> 0);
  view.setUint32(8, Number((value >> 32n) & 0xffffffffn), false);
  view.setUint32(12, Number(value & 0xffffffffn), false);
  return iv;
}

export function resolveSegmentIv(key, mediaSequence) {
  if (key?.iv && key.iv.length === 16) return key.iv;
  return mediaSequenceIv(mediaSequence);
}

function stripPkcs7(bytes) {
  if (!bytes.length) return bytes;
  const pad = bytes[bytes.length - 1];
  if (pad < 1 || pad > 16 || pad > bytes.length) return null;
  for (let i = 0; i < pad; i += 1) {
    if (bytes[bytes.length - 1 - i] !== pad) return null;
  }
  return bytes.subarray(0, bytes.length - pad);
}

export function looksLikeMpegTs(bytes, packetsToCheck = 4) {
  if (!bytes || bytes.length < 188) return false;
  if (bytes[0] !== 0x47) return false;
  const max = Math.min(packetsToCheck, Math.floor(bytes.length / 188));
  for (let i = 0; i < max; i += 1) {
    if (bytes[i * 188] !== 0x47) return false;
  }
  return true;
}

export function trimToMpegTs(bytes) {
  if (!bytes.length) return bytes;
  const aligned = bytes.length - (bytes.length % 188);
  if (aligned < 188) return bytes;
  return bytes.subarray(0, aligned);
}

function decryptCbcRaw(keyBytes, iv, cipherBytes) {
  if (cipherBytes.length % 16 !== 0) {
    throw new Error(`密文长度 ${cipherBytes.length} 不是 16 的倍数，不是标准 AES-128 分片`);
  }
  const roundKey = expandKey(keyBytes);
  const out = new Uint8Array(cipherBytes.length);
  let prev = iv;
  for (let offset = 0; offset < cipherBytes.length; offset += 16) {
    const block = cipherBytes.subarray(offset, offset + 16);
    const dec = decryptBlock(roundKey, block);
    for (let i = 0; i < 16; i += 1) out[offset + i] = dec[i] ^ prev[i];
    prev = block;
  }
  return out;
}

async function decryptCbcWebCrypto(keyBytes, iv, cipherBytes) {
  const cryptoObj = globalThis.crypto;
  if (!cryptoObj?.subtle) throw new Error("no_subtle");
  const cryptoKey = await cryptoObj.subtle.importKey("raw", keyBytes, { name: "AES-CBC" }, false, ["decrypt"]);
  const plain = await cryptoObj.subtle.decrypt({ name: "AES-CBC", iv }, cryptoKey, cipherBytes);
  return new Uint8Array(plain);
}

export async function decryptAes128Cbc(keyBytes, iv, cipherBytes) {
  if (!(keyBytes instanceof Uint8Array) || keyBytes.length !== 16) {
    throw new Error(`AES-128 key 必须是 16 字节，实际 ${keyBytes?.length ?? 0} 字节`);
  }
  if (!(iv instanceof Uint8Array) || iv.length !== 16) {
    throw new Error("IV 必须是 16 字节");
  }
  const cipher = cipherBytes instanceof Uint8Array ? cipherBytes : new Uint8Array(cipherBytes);
  try {
    const web = await decryptCbcWebCrypto(keyBytes, iv, cipher);
    if (looksLikeMpegTs(web)) return trimToMpegTs(web);
  } catch {
    // PKCS7 失败时走无填充 CBC
  }
  const raw = decryptCbcRaw(keyBytes, iv, cipher);
  const stripped = stripPkcs7(raw);
  const candidate = stripped || raw;
  if (looksLikeMpegTs(candidate)) return trimToMpegTs(candidate);
  if (looksLikeMpegTs(raw)) return trimToMpegTs(raw);
  throw new Error("解密后不是有效 MPEG-TS（缺少 0x47 同步字节）。key/IV 可能错误、过期，或这不是 AES-128 TS。未写入密文拼接文件。");
}

export async function decryptHlsSegment(cipherBytes, keyInfo, keyBytes, mediaSequence) {
  if (!keyInfo || keyInfo.method === "NONE") {
    const plain = cipherBytes instanceof Uint8Array ? cipherBytes : new Uint8Array(cipherBytes);
    return { bytes: plain, decrypted: false };
  }
  if (keyInfo.method !== "AES-128") {
    throw new Error(`不支持的加密方法 ${keyInfo.method}（仅支持 AES-128 / NONE）`);
  }
  const iv = resolveSegmentIv(keyInfo, mediaSequence);
  const bytes = await decryptAes128Cbc(keyBytes, iv, cipherBytes);
  return { bytes, decrypted: true };
}
