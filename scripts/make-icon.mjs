// 生成 1024x1024 纯色应用图标源文件（避免提交二进制资产时的来源不明）。
// 运行：node scripts/make-icon.mjs && pnpm tauri icon app-icon.png
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const W = 1024;
const H = 1024;
const EDGE = 20;

// 青绿强调色，与设计稿一致；边缘略深形成边框
const FILL = [20, 184, 166];
const BORDER = [11, 122, 110];

const stride = W * 4 + 1; // 每行前置 1 字节 PNG filter 类型
const rows = Buffer.alloc(stride * H);
for (let y = 0; y < H; y++) {
  const rowStart = y * stride;
  rows[rowStart] = 0; // filter: None
  for (let x = 0; x < W; x++) {
    const edge = x < EDGE || y < EDGE || x >= W - EDGE || y >= H - EDGE;
    const [r, g, b] = edge ? BORDER : FILL;
    const i = rowStart + 1 + x * 4;
    rows[i] = r;
    rows[i + 1] = g;
    rows[i + 2] = b;
    rows[i + 3] = 255;
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
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
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type: RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(rows, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

writeFileSync("app-icon.png", png);
console.log(`app-icon.png written (${png.length} bytes)`);
