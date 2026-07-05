import { useCallback, useRef, useState } from "react";
import { getSupportedArchiveExtension, parseArchiveFile, parseDroppedEntries } from "../lib/zip-input";

interface DropZoneProps {
  disabled?: boolean;
  onLoaded: (sourceFiles: Map<string, Uint8Array>, sourceName: string) => void;
  onError: (message: string) => void;
}

export function DropZone({ disabled, onLoaded, onError }: DropZoneProps) {
  const [isDragOver, setIsDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFiles = useCallback(
    async (fileList: FileList) => {
      const file = fileList[0];
      if (!file) return;
      if (!getSupportedArchiveExtension(file)) {
        onError("ZIP または RAR ファイルを選択してください (GTA5-Mods 等からダウンロードした .zip / .rar をそのまま指定できます)");
        return;
      }
      try {
        const map = await parseArchiveFile(file);
        onLoaded(map, file.name);
      } catch (e) {
        onError(e instanceof Error ? e.message : "アーカイブの展開に失敗しました");
      }
    },
    [onLoaded, onError],
  );

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);
      if (disabled) return;

      const items = e.dataTransfer.items;
      const hasDirectoryEntry =
        items.length > 0 && typeof items[0]?.webkitGetAsEntry === "function" && items[0]?.webkitGetAsEntry()?.isDirectory;

      try {
        if (hasDirectoryEntry) {
          const map = await parseDroppedEntries(items);
          onLoaded(map, "dropped_folder");
          return;
        }
        await handleFiles(e.dataTransfer.files);
      } catch (err) {
        onError(err instanceof Error ? err.message : "ファイルの読み込みに失敗しました");
      }
    },
    [disabled, handleFiles, onLoaded, onError],
  );

  return (
    <div
      className={`border-2 border-dashed rounded-xl p-10 text-center transition-colors cursor-pointer ${
        isDragOver ? "border-blue-500 bg-blue-500/10" : "border-gray-700 hover:border-gray-500"
      } ${disabled ? "opacity-50 pointer-events-none" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragOver(true);
      }}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={handleDrop}
      onClick={() => inputRef.current?.click()}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".zip,.rar"
        className="hidden"
        onChange={(e) => e.target.files && handleFiles(e.target.files)}
      />
      <p className="text-gray-300 font-medium">ZIP / RAR をドラッグ&ドロップ、またはクリックして選択</p>
      <p className="text-gray-500 text-sm mt-2">
        フォルダのドラッグ&ドロップにも対応(.ydr / .ydd / .ytd / .ybn / .yld / .ymt / .meta などを含む展開済みフォルダ)
      </p>
      <p className="text-gray-600 text-xs mt-3">サーバーへのアップロードは行わず、すべてブラウザ内で処理します</p>
    </div>
  );
}
