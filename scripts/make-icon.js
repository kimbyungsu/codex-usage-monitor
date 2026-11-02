/*
 * 확장 아이콘 생성기 — 외부 라이브러리 없이(node 내장 zlib) 256x256 PNG를 그린다.
 * 디자인: 어두운 바탕 라운드 사각 + 겹친 두 개의 270° 한도 게이지(바깥 주황 = Claude, 안쪽 흰색 = Codex).
 * 4x 슈퍼샘플링으로 부드러운 경계. 산출물: docs/icon.png (package.json "icon"이 참조 → vsix·마켓 타일).
 * 사용: node scripts/make-icon.js
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const SIZE = 256, S = 4, W = SIZE * S; // 논리 256, 슈퍼샘플 1024

// ── 색 ──
const BG = [16, 20, 32, 255]; // 어두운 남색 바탕
const TRACK = [46, 54, 74, 255]; // 게이지 바탕 트랙
const ORANGE = [233, 123, 58, 255]; // Claude
const WHITE = [237, 239, 244, 255]; // Codex

// ── 도형 판정(논리 좌표) ──
function inRoundRect(x, y, r = 48) {
  if (x < 0 || x > SIZE || y < 0 || y > SIZE) return false;
  const cx = Math.max(r, Math.min(SIZE - r, x));
  const cy = Math.max(r, Math.min(SIZE - r, y));
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

const CX = 128, CY = 138;
const START = 135, SWEEP = 270; // 화면 좌표(y 아래)에서 시계 방향 각도: 왼쪽 아래 → 오른쪽 아래

/** 270° 게이지 링. 반환: "fill" | "track" | null. 끝은 둥근 캡. */
function gauge(x, y, rMid, thick, fraction) {
  const half = thick / 2;
  const dx = x - CX, dy = y - CY;
  const d = Math.sqrt(dx * dx + dy * dy);
  const a = ((Math.atan2(dy, dx) * 180) / Math.PI - START + 720) % 360; // 0..360, 게이지 시작 기준
  const fillEnd = SWEEP * fraction;
  const capAt = (deg) => {
    const rad = ((START + deg) * Math.PI) / 180;
    const px = CX + rMid * Math.cos(rad), py = CY + rMid * Math.sin(rad);
    return (x - px) ** 2 + (y - py) ** 2 <= half * half;
  };
  const onRing = Math.abs(d - rMid) <= half;
  if ((onRing && a <= fillEnd) || capAt(0) || capAt(fillEnd)) return "fill";
  if ((onRing && a <= SWEEP) || capAt(SWEEP)) return "track";
  return null;
}

function colorAt(x, y) {
  if (!inRoundRect(x, y)) return [0, 0, 0, 0];
  for (const [rMid, thick, frac, color] of [
    [88, 22, 0.68, ORANGE],
    [54, 22, 0.42, WHITE],
  ]) {
    const g = gauge(x, y, rMid, thick, frac);
    if (g === "fill") return color;
    if (g === "track") return TRACK;
  }
  return BG;
}

// ── 래스터 + 다운샘플 ──
const out = Buffer.alloc(SIZE * SIZE * 4);
for (let py = 0; py < SIZE; py++) {
  for (let px = 0; px < SIZE; px++) {
    const acc = [0, 0, 0, 0];
    for (let sy = 0; sy < S; sy++) {
      for (let sx = 0; sx < S; sx++) {
        const c = colorAt(px + (sx + 0.5) / S, py + (sy + 0.5) / S);
        const a = c[3] / 255;
        acc[0] += c[0] * a; acc[1] += c[1] * a; acc[2] += c[2] * a; acc[3] += c[3];
      }
    }
    const n = S * S, alpha = acc[3] / n, i = (py * SIZE + px) * 4;
    const k = alpha > 0 ? 255 / acc[3] : 0; // 프리멀티 해제
    out[i] = Math.round(acc[0] * k);
    out[i + 1] = Math.round(acc[1] * k);
    out[i + 2] = Math.round(acc[2] * k);
    out[i + 3] = Math.round(alpha);
  }
}

// ── PNG 인코딩 ──
const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0; // filter: none
  out.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);
const dest = path.join(__dirname, "..", "docs", "icon.png");
fs.writeFileSync(dest, png);
console.log(`icon written: ${dest} (${png.length} bytes)`);
