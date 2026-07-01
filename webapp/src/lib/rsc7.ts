import type { RSC7Header } from "./types";

const RSC7_MAGIC = 0x37435352; // "RSC7" LE

// ヘッダーのみ読む軽量版。マジック/バージョン検証だけが目的なので
// deflate 展開はしない(ファイル数が多い場合の速度を優先)。
export function readRSC7Header(data: Uint8Array): RSC7Header | null {
  if (data.byteLength < 16) return null;

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const magic = view.getUint32(0, true);
  if (magic !== RSC7_MAGIC) return null;

  return {
    magic,
    version: view.getUint32(4, true),
    systemFlags: view.getUint32(8, true),
    graphicsFlags: view.getUint32(12, true),
    systemSize: 0,
    graphicsSize: 0,
  };
}
