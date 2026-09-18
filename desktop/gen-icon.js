const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const OUT = path.join(__dirname);
const S = 512;

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function encodePNG(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit, RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- helpers in icon space [0..S] ----
function lerp(a, b, t) { return a + (b - a) * t; }
function inTri(px, py, ax, ay, bx, by, cx, cy) {
  const s1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const s2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const s3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const neg = (s1 < 0) || (s2 < 0) || (s3 < 0);
  const pos = (s1 > 0) || (s2 > 0) || (s3 > 0);
  return !(neg && pos);
}
function inRoundRect(px, py, x0, y0, x1, y1, r) {
  const cx = Math.max(x0 + r, Math.min(px, x1 - r));
  const cy = Math.max(y0 + r, Math.min(py, y1 - r));
  const dx = px - cx, dy = py - cy;
  const inRect = px >= x0 && px <= x1 && py >= y0 && py <= y1;
  return inRect && (dx * dx + dy * dy <= r * r || !(px < x0 + r || px > x1 - r || py < y0 + r || py > y1 - r));
}

function render(size) {
  const px = Buffer.alloc(size * size * 4);
  const sc = size / S;
  const x0 = 0.07 * S, y0 = 0.07 * S, x1 = 0.93 * S, y1 = 0.93 * S;
  const r = 0.18 * S;
  // plane triangles (dart / paper plane)
  const T1 = [[0.30, 0.34], [0.70, 0.26], [0.58, 0.74]];
  const T2 = [[0.70, 0.26], [0.42, 0.50], [0.58, 0.74]];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const fx = x / sc, fy = y / sc;
      if (!inRoundRect(fx, fy, x0, y0, x1, y1, r)) { px[i] = px[i + 1] = px[i + 2] = px[i + 3] = 0; continue; }
      const t = fx / S + fy / S;
      const rr = (0.44 + 0.16 * t) * 255;
      const gg = 0.1 * t * 255 + 60;
      const bb2 = (0.78 + 0.22 * (1 - t)) * 255;
      // glossy highlight
      let colR = rr, colG = gg, colB = bb2;
      const glow = Math.max(0, 0.22 - Math.abs(fy - y0 - 20 * sc) / (80 * sc));
      colR = Math.min(255, colR + glow * 255); colG = Math.min(255, colG + glow * 255); colB = Math.min(255, colB + glow * 255);
      let plane = false;
      if (inTri(fx, fy, ...T1[0], ...T1[1], ...T1[2])) plane = true;
      if (inTri(fx, fy, ...T2[0], ...T2[1], ...T2[2])) plane = true;
      if (plane) { colR = 255; colG = 255; colB = 255; }
      px[i] = Math.round(colR); px[i + 1] = Math.round(colG); px[i + 2] = Math.round(colB); px[i + 3] = 255;
    }
  }
  return px;
}

const png512 = encodePNG(512, render(512));
fs.writeFileSync(path.join(OUT, 'icon.png'), png512);
fs.writeFileSync(path.join(OUT, 'icon-512.png'), png512);
fs.writeFileSync(path.join(OUT, 'icon-256.png'), encodePNG(256, render(256)));
fs.writeFileSync(path.join(OUT, 'icon-128.png'), encodePNG(128, render(128)));

// ICO (wraps PNG, Vista+ compatible)
function ico(png, w, h, bpp) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4);
  const entry = Buffer.alloc(16);
  entry[0] = w === 256 ? 0 : w; entry[1] = h === 256 ? 0 : h;
  entry[2] = 0; entry[3] = 0;
  entry.writeUInt16LE(1, 4); entry.writeUInt16LE(bpp, 6);
  entry.writeUInt32LE(png.length, 8); entry.writeUInt32LE(22, 12);
  return Buffer.concat([header, entry, png]);
}
fs.writeFileSync(path.join(OUT, 'icon.ico'), ico(png512, 256, 256, 32));
console.log('icons written:', OUT);