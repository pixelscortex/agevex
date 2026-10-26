/** A dependency-free PNG fixture with a small bitmap alphabet; no image API calls. */
import { writeFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";

const font: Record<string, string[]> = {
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  G: ["01111", "10000", "10000", "10111", "10001", "10001", "01110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
};

const width = 190,
  height = 48,
  scale = 3,
  inset = 10;

const pixels = Buffer.alloc(height * (1 + width * 3), 255);

for (let y = 0; y < height; y++) pixels[y * (1 + width * 3)] = 0;

for (const [index, letter] of Array.from("AGEVEX 42").entries())
  for (const [y, row] of font[letter].entries())
    for (const [x, bit] of Array.from(row).entries())
      if (bit === "1")
        for (let dy = 0; dy < scale; dy++)
          for (let dx = 0; dx < scale; dx++) {
            const offset =
              (inset + y * scale + dy) * (1 + width * 3) +
              1 +
              (inset + index * 6 * scale + x * scale + dx) * 3;

            pixels.fill(0, offset, offset + 3);
          }

function crc32(buffer: Buffer) {
  let crc = 0xffffffff;

  for (const byte of buffer) {
    crc ^= byte;

    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }

  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer) {
  const name = Buffer.from(type);
  const size = Buffer.alloc(4);

  size.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);

  crc.writeUInt32BE(crc32(Buffer.concat([name, data])));

  return Buffer.concat([size, name, data, crc]);
}
const header = Buffer.alloc(13);

header.writeUInt32BE(width);
header.writeUInt32BE(height, 4);
header[8] = 8;
header[9] = 2;

await writeFile(
  new URL("./ocr.png", import.meta.url),
  Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]),
);
