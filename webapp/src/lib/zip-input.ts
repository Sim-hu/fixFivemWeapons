import { unzip } from "fflate";

// アップロードされた ZIP を { 相対パス: バイト列 } に展開する。
// GTA5-Mods 配布物はフォルダ階層 (weapons.rpf 内の cdimages 相当) を
// 保持したまま zip 化されていることが多いので、パスはそのまま保持する。
export function parseZipFile(file: File): Promise<Map<string, Uint8Array>> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
    reader.onload = () => {
      const buf = new Uint8Array(reader.result as ArrayBuffer);
      unzip(buf, (err, unzipped) => {
        if (err) {
          reject(err);
          return;
        }
        const map = new Map<string, Uint8Array>();
        for (const [path, data] of Object.entries(unzipped)) {
          if (path.endsWith("/")) continue; // ディレクトリエントリ
          map.set(path, data);
        }
        resolve(map);
      });
    };
    reader.readAsArrayBuffer(file);
  });
}

// フォルダのドラッグ&ドロップ (DataTransferItem.webkitGetAsEntry) にも対応する。
export async function parseDroppedEntries(
  items: DataTransferItemList,
): Promise<Map<string, Uint8Array>> {
  const map = new Map<string, Uint8Array>();

  async function walk(entry: FileSystemEntry, prefix: string): Promise<void> {
    if (entry.isFile) {
      const fileEntry = entry as FileSystemFileEntry;
      const file = await new Promise<File>((res, rej) => fileEntry.file(res, rej));
      const buf = new Uint8Array(await file.arrayBuffer());
      map.set(`${prefix}${entry.name}`, buf);
    } else if (entry.isDirectory) {
      const dirEntry = entry as FileSystemDirectoryEntry;
      const reader = dirEntry.createReader();
      const entries = await readAllEntries(reader);
      for (const child of entries) {
        await walk(child, `${prefix}${entry.name}/`);
      }
    }
  }

  function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
    return new Promise((resolve, reject) => {
      const all: FileSystemEntry[] = [];
      const readBatch = () => {
        reader.readEntries((batch) => {
          if (batch.length === 0) {
            resolve(all);
            return;
          }
          all.push(...batch);
          readBatch();
        }, reject);
      };
      readBatch();
    });
  }

  const entries: FileSystemEntry[] = [];
  for (let i = 0; i < items.length; i++) {
    const entry = items[i]?.webkitGetAsEntry();
    if (entry) entries.push(entry);
  }

  for (const entry of entries) {
    await walk(entry, "");
  }

  return map;
}
