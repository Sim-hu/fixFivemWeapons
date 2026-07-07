import { useCallback, useMemo, useState, type ChangeEvent } from "react";
import { zipSync } from "fflate";
import { DropZone } from "./components/DropZone";
import { IssueList } from "./components/IssueList";
import { ConflictResolver } from "./components/ConflictResolver";
import { GroupedResultView } from "./components/GroupedResultView";
import {
  analyzeSourceFiles,
  analyzeSourceFilesAsGroups,
  applyConflictResolutions,
  applyGroupConflictResolutions,
  buildFxManifest,
  sanitizeResourceName,
  type AnalyzeResult,
  type GroupedAnalyzeResult,
} from "./lib/resource-builder";
import {
  buildWeaponOutputFiles,
  detectReplaceWeapon,
  type ReplaceWeaponInfo,
  type WeaponOutputMode,
} from "./lib/weapon-addon-builder";

type Mode = "single" | "split";

function App() {
  const [sourceName, setSourceName] = useState("");
  const [rawSourceFiles, setRawSourceFiles] = useState<Map<string, Uint8Array> | null>(null);
  const [mode, setMode] = useState<Mode>("single");
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [singleResult, setSingleResult] = useState<AnalyzeResult | null>(null);
  const [singleSelections, setSingleSelections] = useState<Map<string, string>>(new Map());
  const [resourceName, setResourceName] = useState("");
  const [keepReplaceWeaponMode, setKeepReplaceWeaponMode] = useState(false);
  const [replaceWeaponInfo, setReplaceWeaponInfo] = useState<ReplaceWeaponInfo | null>(null);

  const [groupedResult, setGroupedResult] = useState<GroupedAnalyzeResult | null>(null);
  const [groupSelections, setGroupSelections] = useState<Map<string, string>>(new Map());

  const [downloading, setDownloading] = useState(false);

  const resetResults = useCallback(() => {
    setError(null);
    setSingleResult(null);
    setGroupedResult(null);
    setSingleSelections(new Map());
    setGroupSelections(new Map());
    setKeepReplaceWeaponMode(false);
    setReplaceWeaponInfo(null);
  }, []);

  const runAnalysis = useCallback(async (files: Map<string, Uint8Array>, name: string, targetMode: Mode) => {
    setAnalyzing(true);
    setError(null);
    try {
      if (targetMode === "single") {
        const analyzed = await analyzeSourceFiles(files, name);
        const replaceWeapon = detectReplaceWeapon(analyzed.resolved, analyzed.conflicts, name);
        setSingleResult(analyzed);
        setReplaceWeaponInfo(replaceWeapon);
        setResourceName(replaceWeapon?.suggestedAddonSlug ?? analyzed.rootNameGuess);
        setKeepReplaceWeaponMode(false);
      } else {
        const analyzed = await analyzeSourceFilesAsGroups(files);
        setGroupedResult(analyzed);
        setReplaceWeaponInfo(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "解析に失敗しました");
    } finally {
      setAnalyzing(false);
    }
  }, []);

  const handleLoaded = useCallback(
    async (sourceFiles: Map<string, Uint8Array>, name: string) => {
      resetResults();
      setRawSourceFiles(sourceFiles);
      setSourceName(name);
      await runAnalysis(sourceFiles, name, mode);
    },
    [resetResults, runAnalysis, mode],
  );

  const handleError = useCallback(
    (message: string) => {
      resetResults();
      setError(message);
    },
    [resetResults],
  );

  const handleModeChange = useCallback(
    async (newMode: Mode) => {
      setMode(newMode);
      if (!rawSourceFiles) return;
      if (newMode === "single" && singleResult) return;
      if (newMode === "split" && groupedResult) return;
      await runAnalysis(rawSourceFiles, sourceName, newMode);
    },
    [rawSourceFiles, sourceName, singleResult, groupedResult, runAnalysis],
  );

  const handleSingleSelect = useCallback((resourcePath: string, sourcePath: string) => {
    setSingleSelections((prev) => new Map(prev).set(resourcePath, sourcePath));
  }, []);

  const handleGroupSelect = useCallback((key: string, sourcePath: string) => {
    setGroupSelections((prev) => new Map(prev).set(key, sourcePath));
  }, []);

  const unresolvedSingleConflicts = useMemo(() => {
    if (!singleResult) return 0;
    return singleResult.conflicts.filter((c) => !singleSelections.has(c.resourcePath)).length;
  }, [singleResult, singleSelections]);

  const unresolvedGroupConflicts = useMemo(() => {
    if (!groupedResult) return 0;
    return groupedResult.groups.reduce(
      (n, g) => n + g.conflicts.filter((c) => !groupSelections.has(`${g.groupKey}::${c.resourcePath}`)).length,
      0,
    );
  }, [groupedResult, groupSelections]);

  const errorCount = useMemo(() => {
    const issues = mode === "single" ? singleResult?.issues : groupedResult?.issues;
    return issues?.filter((i) => i.severity === "error").length ?? 0;
  }, [mode, singleResult, groupedResult]);

  const visibleReplaceWeaponInfo = mode === "single" ? replaceWeaponInfo : null;
  const weaponOutputMode: WeaponOutputMode = keepReplaceWeaponMode ? "replace" : "addon";

  const handleDownloadSingle = useCallback(async () => {
    if (!singleResult) return;
    setDownloading(true);
    try {
      await new Promise((r) => setTimeout(r, 0));
      const rootName = sanitizeResourceName(resourceName || singleResult.rootNameGuess);
      const selectedFiles = applyConflictResolutions(singleResult, singleSelections);
      const files = buildWeaponOutputFiles(selectedFiles, {
        addonSlug: rootName,
        replaceWeapon: replaceWeaponInfo,
        weaponOutputMode,
      });
      const manifest = buildFxManifest(files);

      const zipInput: Record<string, Uint8Array> = {
        [`${rootName}/fxmanifest.lua`]: new TextEncoder().encode(manifest),
      };
      for (const file of files) {
        zipInput[`${rootName}/${file.resourcePath}`] = file.data;
      }

      downloadZip(zipInput, `${rootName}_fivem_resource.zip`);
    } finally {
      setDownloading(false);
    }
  }, [singleResult, singleSelections, resourceName, replaceWeaponInfo, weaponOutputMode]);

  const handleDownloadGroups = useCallback(async () => {
    if (!groupedResult) return;
    setDownloading(true);
    try {
      await new Promise((r) => setTimeout(r, 0));
      const resolvedGroups = applyGroupConflictResolutions(groupedResult.groups, groupSelections);

      const zipInput: Record<string, Uint8Array> = {};
      for (const group of resolvedGroups) {
        const manifest = buildFxManifest(group.files);
        zipInput[`${group.resourceName}/fxmanifest.lua`] = new TextEncoder().encode(manifest);
        for (const file of group.files) {
          zipInput[`${group.resourceName}/${file.resourcePath}`] = file.data;
        }
      }

      downloadZip(zipInput, "fivem_resources.zip");
    } finally {
      setDownloading(false);
    }
  }, [groupedResult, groupSelections]);

  const streamCount = singleResult?.resolved.filter((f) => f.resourcePath.startsWith("stream/")).length ?? 0;
  const dataCount = singleResult?.resolved.filter((f) => f.resourcePath.startsWith("data/")).length ?? 0;

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <div className="max-w-4xl mx-auto px-4 py-8">
        <h1 className="text-2xl font-bold mb-2">FiveM Weapon / Clothing Fixer</h1>
        <p className="text-gray-400 text-sm mb-6">
          GTA5-Mods 等で配布されている武器・服 mod (fxmanifest.lua も stream/ 構造も無い生の .ydr / .ydd /
          .ytd / .ymt / .meta 一式、または dlc.rpf に入った addon 形式) をアップロードすると、FiveM
          リソースとして読み込める形に自動変換します。dlc.rpf はネストした RPF も含めて自動展開します(暗号化 RPF
          は非対応)。
        </p>

        <div className="flex items-center gap-2 mb-4 text-sm">
          <span className="text-gray-500">出力形式:</span>
          <button
            onClick={() => handleModeChange("single")}
            className={`px-3 py-1.5 rounded-lg transition-colors ${
              mode === "single" ? "bg-blue-600 text-white" : "bg-gray-800 text-gray-400 hover:bg-gray-700"
            }`}
          >
            1つのリソースにまとめる
          </button>
          <button
            onClick={() => handleModeChange("split")}
            className={`px-3 py-1.5 rounded-lg transition-colors ${
              mode === "split" ? "bg-blue-600 text-white" : "bg-gray-800 text-gray-400 hover:bg-gray-700"
            }`}
          >
            フォルダ単位で別リソースに分割
          </button>
        </div>
        {mode === "split" && (
          <p className="text-gray-500 text-xs mb-4">
            複数の武器や衣装を1つの zip にまとめた配布物向け。各トップレベルフォルダを個別の FiveM
            リソースとして出力するため、フォルダ間で共有アタッチメント名や同名 drawable が中身違いで重複していても競合しません。
          </p>
        )}

        <DropZone disabled={analyzing} onLoaded={handleLoaded} onError={handleError} />

        {analyzing && <div className="mt-6 text-center text-gray-400">解析中...</div>}

        {error && (
          <div className="mt-6 bg-red-900/40 border border-red-700 rounded-lg p-4 text-red-300">{error}</div>
        )}

        {mode === "single" && singleResult && (
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
                onChange={(e: ChangeEvent<HTMLInputElement>) => setResourceName(e.target.value)}
                className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 font-mono focus:outline-none focus:border-blue-500"
              />
            </div>

            {visibleReplaceWeaponInfo && (
              <div className="bg-gray-900/60 border border-gray-700 rounded-lg p-3 text-sm text-gray-300 space-y-2">
                <label className="flex items-center gap-2 cursor-pointer w-fit">
                  <input
                    type="checkbox"
                    checked={keepReplaceWeaponMode}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => setKeepReplaceWeaponMode(e.target.checked)}
                    className="accent-blue-600"
                  />
                  <span>リプレイス形式のまま出力する</span>
                </label>
                <p className="text-xs text-gray-500">
                  {visibleReplaceWeaponInfo.weaponName} ({visibleReplaceWeaponInfo.modelBase}) の差し替え武器を検出しました。未チェックなら
                  stream名をリネームし、addon武器用の weapons.meta / weaponarchetypes.meta / weaponcomponents.meta を生成します。
                </p>
              </div>
            )}

            <ConflictResolver conflicts={singleResult.conflicts} selections={singleSelections} onSelect={handleSingleSelect} />
            <IssueList issues={singleResult.issues} />

            <button
              onClick={handleDownloadSingle}
              disabled={
                downloading || unresolvedSingleConflicts > 0 || singleResult.resolved.length + singleResult.conflicts.length === 0
              }
              className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg text-sm font-medium transition-colors"
            >
              {downloading
                ? "作成中..."
                : unresolvedSingleConflicts > 0
                  ? `競合を解決してください (残り${unresolvedSingleConflicts}件)`
                  : visibleReplaceWeaponInfo && !keepReplaceWeaponMode
                    ? "Add-on 武器リソース ZIP をダウンロード"
                    : "FiveM リソース ZIP をダウンロード"}
            </button>
          </div>
        )}

        {mode === "split" && groupedResult && (
          <div className="mt-6 space-y-4">
            <div className="flex items-center gap-4 text-sm text-gray-400">
              <span className="font-mono">{sourceName}</span>
              <span>&middot;</span>
              <span>{groupedResult.groups.length} リソースに分割</span>
              {errorCount > 0 && (
                <>
                  <span>&middot;</span>
                  <span className="text-red-400">除外: {errorCount}</span>
                </>
              )}
            </div>

            <GroupedResultView result={groupedResult} selections={groupSelections} onSelect={handleGroupSelect} />
            <IssueList issues={groupedResult.issues} />

            <button
              onClick={handleDownloadGroups}
              disabled={downloading || unresolvedGroupConflicts > 0 || groupedResult.groups.length === 0}
              className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg text-sm font-medium transition-colors"
            >
              {downloading
                ? "作成中..."
                : unresolvedGroupConflicts > 0
                  ? `競合を解決してください (残り${unresolvedGroupConflicts}件)`
                  : `${groupedResult.groups.length}個の FiveM リソースを ZIP でダウンロード`}
            </button>
          </div>
        )}

        <div className="mt-10 text-xs text-gray-600 space-y-1">
          <p>すべての処理はブラウザ内で完結し、サーバーへのアップロードは行いません。</p>
          <p>
            「差し替え(replace)」mod は既定では addon 武器として出力します。必要な場合は検出後に表示されるチェックで
            リプレイス形式のまま出力できます。「追加(addon)」mod は weapons.meta や服 addon 用の .ymt/.meta を data/
            に配置し fxmanifest.lua に data_file 宣言を自動追加しますが、配布ページ記載の別 mod
            (共有アタッチメント定義など)への依存は自動解決できないため、readme の説明も確認してください。
          </p>
        </div>
      </div>
    </div>
  );
}

function downloadZip(zipInput: Record<string, Uint8Array>, downloadName: string) {
  const zipped = zipSync(zipInput);
  const blob = new Blob([zipped as Uint8Array<ArrayBuffer>], { type: "application/zip" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = downloadName;
  a.click();
  URL.revokeObjectURL(url);
}

export default App;
