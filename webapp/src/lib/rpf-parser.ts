// RPF7 アーカイブパーサー — ファイル抽出専用 (ネスト RPF 対応)
// GTA5-Mods の addon 系 weapon mod は dlc.rpf (weapons.rpf 等を含む DLC パック)
// のまま配布されることが多く、これを展開しないと中の .ydr/.ytd/.meta に届かない。
import { inflateRaw } from "pako";

const RPF7_MAGIC = 0x52504637;
const DIR_MARKER = 0x7fffff00;
const OPEN_TAG = 0x4e45504f;

export function isRPF7(data: Uint8Array): boolean {
  if (data.length < 16) return false;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return view.getUint32(0, true) === RPF7_MAGIC;
}

// 暗号化 (AES/NG) RPF かどうか。true の場合 extractAllFiles は使えない。
export function isEncryptedRPF(data: Uint8Array): boolean {
  if (data.length < 16) return false;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const encryption = view.getUint32(12, true);
  return encryption !== 0 && encryption !== OPEN_TAG;
}

function getResourcePageSize(flags: number): number {
  if (flags === 0) return 0;
  const s0 = (flags >>> 27) & 0x1;
  const s1 = ((flags >>> 26) & 0x1) << 1;
  const s2 = ((flags >>> 25) & 0x1) << 2;
  const s3 = ((flags >>> 24) & 0x1) << 3;
  const s4 = ((flags >>> 17) & 0x7f) << 4;
  const s5 = ((flags >>> 11) & 0x3f) << 5;
  const s6 = ((flags >>> 7) & 0xf) << 6;
  const s7 = ((flags >>> 5) & 0x3) << 7;
  const s8 = ((flags >>> 4) & 0x1) << 8;
  const baseSize = 0x200 << (flags & 0xf);
  return baseSize * (s0 + s1 + s2 + s3 + s4 + s5 + s6 + s7 + s8);
}

interface FileDataInfo {
  byteOffset: number;
  compressedSize: number;
  uncompressedSize: number;
  isResource: boolean;
}

function parseFileEntry(data: Uint8Array, view: DataView, off: number): FileDataInfo {
  const b = data.subarray(off, off + 16);
  const isResource = (b[7]! & 0x80) !== 0;
  const blockOffset = b[5]! | (b[6]! << 8) | ((b[7]! & 0x7f) << 16);
  const byteOffset = blockOffset * 512;
  const onDiskSize = b[2]! | (b[3]! << 8) | (b[4]! << 16);

  if (isResource) {
    // リソースはディスク上に「RSC7ヘッダー(16B) + deflate圧縮データ」がそのまま
    // onDiskSize バイト格納されている。これがそのまま単体ファイルになる。
    const systemFlags = view.getUint32(off + 8, true);
    const graphicsFlags = view.getUint32(off + 12, true);
    const uncompressedSize = getResourcePageSize(systemFlags) + getResourcePageSize(graphicsFlags) + 16;
    return { byteOffset, compressedSize: onDiskSize, uncompressedSize, isResource: true };
  }

  const uncompressedSize = view.getUint32(off + 8, true);
  return { byteOffset, compressedSize: onDiskSize, uncompressedSize, isResource: false };
}

function extractFileData(rpfData: Uint8Array, info: FileDataInfo): Uint8Array | null {
  const { byteOffset, compressedSize, uncompressedSize, isResource } = info;

  if (isResource) {
    // ディスク上の実サイズぶんちょうどを返す。展開後サイズで読むと末尾に
    // 隣ファイルのデータが混入し、RAGE のローダーが破損扱いにする。
    if (byteOffset >= rpfData.length) return null;
    const diskSize = compressedSize > 0 ? compressedSize : uncompressedSize;
    const end = Math.min(byteOffset + diskSize, rpfData.length);
    return rpfData.subarray(byteOffset, end);
  }

  const isCompressed = compressedSize > 0;
  const dataSize = isCompressed ? compressedSize : uncompressedSize;
  if (byteOffset + dataSize > rpfData.length || dataSize === 0) return null;

  const rawChunk = rpfData.subarray(byteOffset, byteOffset + dataSize);
  if (!isCompressed) return rawChunk;

  try {
    return inflateRaw(rawChunk);
  } catch {
    return null;
  }
}

// RPF 内の全ファイルを { 相対パス: バイト列 } として抽出する。
// ネストした .rpf (DLC パック内の weapons.rpf 等) も再帰的に展開する。
export function extractAllFiles(rpfData: Uint8Array): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  if (!isRPF7(rpfData)) throw new Error("Invalid RPF7 magic");
  if (isEncryptedRPF(rpfData)) throw new Error("Encrypted RPF (AES/NG) is not supported");

  const view = new DataView(rpfData.buffer, rpfData.byteOffset, rpfData.byteLength);
  const entryCount = view.getUint32(4, true);
  const namesLength = view.getUint32(8, true);
  const tocOffset = 16;
  const namesOffset = tocOffset + entryCount * 16;
  if (namesOffset + namesLength > rpfData.length) throw new Error("RPF7 file truncated");
  const namesData = rpfData.subarray(namesOffset, namesOffset + namesLength);

  interface PathEntry {
    name: string;
    isDir: boolean;
    childStart: number;
    childCount: number;
  }

  const entries: PathEntry[] = [];
  for (let i = 0; i < entryCount; i++) {
    const off = tocOffset + i * 16;
    const v1 = view.getUint32(off + 4, true);
    const nameOff = rpfData[off]! | (rpfData[off + 1]! << 8);
    const name = readNullString(namesData, nameOff);

    if (v1 === DIR_MARKER) {
      entries.push({
        name,
        isDir: true,
        childStart: view.getUint32(off + 8, true),
        childCount: view.getUint32(off + 12, true),
      });
    } else {
      entries.push({ name, isDir: false, childStart: 0, childCount: 0 });
    }
  }

  function walk(entryIdx: number, prefix: string) {
    const entry = entries[entryIdx];
    if (!entry?.isDir) return;

    for (let i = 0; i < entry.childCount; i++) {
      const childIdx = entry.childStart + i;
      const child = entries[childIdx];
      if (!child) continue;
      const childPath = prefix ? `${prefix}/${child.name}` : child.name;

      if (child.isDir) {
        walk(childIdx, childPath);
      } else {
        const off = tocOffset + childIdx * 16;
        const info = parseFileEntry(rpfData, view, off);
        const fileData = extractFileData(rpfData, info);
        if (fileData) {
          if (child.name.toLowerCase().endsWith(".rpf") && fileData.length >= 16 && isRPF7(fileData) && !isEncryptedRPF(fileData)) {
            try {
              const innerFiles = extractAllFiles(fileData);
              for (const [innerPath, innerData] of innerFiles) {
                files.set(`${childPath}/${innerPath}`, innerData);
              }
              continue;
            } catch {
              // ネスト抽出失敗 → RPF 自体をファイルとして保存
            }
          }
          files.set(childPath, fileData);
        }
      }
    }
  }

  if (entries.length > 0) walk(0, "");
  return files;
}

function readNullString(data: Uint8Array, offset: number): string {
  const bytes: number[] = [];
  let i = offset;
  while (i < data.length && data[i] !== 0) {
    bytes.push(data[i]!);
    i++;
  }
  return new TextDecoder("ascii").decode(new Uint8Array(bytes));
}
