import { useCallback, useMemo, useState } from "react";
import { zipSync } from "fflate";
import { DropZone } from "./components/DropZone";
import { IssueList } from "./components/IssueList";
import { ConflictResolver } from "./components/ConflictResolver";
import {
  analyzeSourceFiles,
  applyConflictResolutions,
  buildFxManifest,
  sanitizeResourceName,
  type AnalyzeResult,
} from "./lib/resource-builder";

function App() {
  const [sourceName, setSourceName] = useState("");
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AnalyzeResult | null>(null);
  const [selections, setSelections] = useState<Map<string, string>>(new Map());
  const [resourceName, setResourceName] = useState("");
  const [downloading, setDownloading] = useState(false);

  const reset = useCallback(() => {
    setError(null);
    setResult(null);
    setSelections(new Map());
  }, []);

  const handleLoaded = useCallback(
    async (sourceFiles: Map<string, Uint8Array>, name: string) => {
      reset();
      setAnalyzing(true);
      setSourceName(name);
      try {
        const analyzed = await analyzeSourceFiles(sourceFiles, name);
        setResult(analyzed);
        setResourceName(analyzed.rootNameGuess);
      } catch (e) {
        setError(e instanceof Error ? e.message : "解析に失敗しました");
      } finally {
        setAnalyzing(false);
      }
    },
    [reset],
  );

  const handleError = useCallback((message: string) => {
    reset();
    setError(message);
  }, [reset]);

  const handleSelect = useCallback((resourcePath: string, sourcePath: string) => {
    setSelections((prev) => {
      const next = new Map(prev);
      next.set(resourcePath, sourcePath);
      return next;
    });
  }, []);

  const unresolvedConflicts = useMemo(() => {
    if (!result) return 0;
    return result.conflicts.filter((c) => !selections.has(c.resourcePath)).length;
  }, [result, selections]);

  const errorCount = useMemo(
    () => result?.issues.filter((i) => i.severity === "error").length ?? 0,
    [result],
  );

  const handleDownload = useCallback(async () => {
    if (!result) return;
    setDownloading(true);
    try {
      await new Promise((r) => setTimeout(r, 0));
      const files = applyConflictResolutions(result, selections);
      const manifest = buildFxManifest(files);
      const rootName = sanitizeResourceName(resourceName || result.rootNameGuess);

      const zipInput: Record<string, Uint8Array> = {
        [`${rootName}/fxmanifest.lua`]: new TextEncoder().encode(manifest),
      };
      for (const file of files) {
        zipInput[`${rootName}/${file.resourcePath}`] = file.data;
      }

      const zipped = zipSync(zipInput);
      const blob = new Blob([zipped as Uint8Array<ArrayBuffer>], { type: "application/zip" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${rootName}_fivem_resource.zip`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setDownloading(false);
    }
  }, [result, selections, resourceName]);

  const streamCount = result?.resolved.filter((f) => f.resourcePath.startsWith("stream/")).length ?? 0;
  const dataCount = result?.resolved.filter((f) => f.resourcePath.startsWith("data/")).length ?? 0;

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <div className="max-w-4xl mx-auto px-4 py-8">
        <h1 className="text-2xl font-bold mb-2">FiveM Weapon Fixer</h1>
        <p className="text-gray-400 text-sm mb-6">
          GTA5-Mods 等で配布されている OpenIV 差し替え形式の武器 mod (fxmanifest.lua も stream/
          構造も無い生の .ydr / .ytd 一式) をアップロードすると、FiveM リソースとして読み込める形に自動変換します。
        </p>

        <DropZone disabled={analyzing} onLoaded={handleLoaded} onError={handleError} />

        {analyzing && <div className="mt-6 text-center text-gray-400">解析中...</div>}

        {error && (
          <div className="mt-6 bg-red-900/40 border border-red-700 rounded-lg p-4 text-red-300">{error}</div>
        )}

        {result && (
          <div className="mt-6 space-y-4">
            <div className="flex items-center gap-4 text-sm text-gray-400">
              <span className="font-mono">{sourceName}</span>
              <span>&middot;</span>
              <span>stream: {streamCount}</span>
              <span>&middot;</span>
              <span>data: {dataCount}</span>
              {errorCount > 0 && (
                <>
                  <span>&middot;</span>
                  <span className="text-red-400">除外: {errorCount}</span>
                </>
              )}
            </div>

            <div className="flex items-center gap-3">
              <label className="text-sm text-gray-400 shrink-0">リソース名</label>
              <input
                type="text"
                value={resourceName}
                onChange={(e) => setResourceName(e.target.value)}
                className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 font-mono focus:outline-none focus:border-blue-500"
              />
            </div>

            <ConflictResolver conflicts={result.conflicts} selections={selections} onSelect={handleSelect} />
            <IssueList issues={result.issues} />

            <button
              onClick={handleDownload}
              disabled={downloading || unresolvedConflicts > 0 || result.resolved.length + result.conflicts.length === 0}
              className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg text-sm font-medium transition-colors"
            >
              {downloading
                ? "作成中..."
                : unresolvedConflicts > 0
                  ? `競合を解決してください (残り${unresolvedConflicts}件)`
                  : "FiveM リソース ZIP をダウンロード"}
            </button>
          </div>
        )}

        <div className="mt-10 text-xs text-gray-600 space-y-1">
          <p>すべての処理はブラウザ内で完結し、サーバーへのアップロードは行いません。</p>
          <p>
            武器の「差し替え(replace)」mod を想定しています。stream/
            配下に元と同名のファイルを置くだけで既存アセットが自動的に上書きされる FiveM の仕組みを利用しています。
          </p>
        </div>
      </div>
    </div>
  );
}

export default App;
