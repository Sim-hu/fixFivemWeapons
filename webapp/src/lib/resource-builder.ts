import { readRSC7Header } from "./rsc7";
import { isRPF7, isEncryptedRPF, extractAllFiles } from "./rpf-parser";
import {
  STREAM_EXTENSIONS,
  DATA_EXTENSIONS,
  EXCLUDED_EXTENSIONS,
  EXCLUDED_FILENAMES,
  KNOWN_RSC_VERSIONS,
  getExtension,
  getBaseName,
} from "./types";

const META_DATA_FILE_TYPES: Array<{ pattern: RegExp; type: string }> = [
  { pattern: /(^|\/)handling\.meta$/i, type: "HANDLING_FILE" },
  { pattern: /(^|\/)vehicles\.meta$/i, type: "VEHICLE_METADATA_FILE" },
  { pattern: /(^|\/)carcols\.meta$/i, type: "CARCOLS_FILE" },
  { pattern: /(^|\/)carvariations\.meta$/i, type: "VEHICLE_VARIATION_FILE" },
  { pattern: /(^|\/)vehiclelayouts\.meta$/i, type: "VEHICLE_LAYOUTS_FILE" },
  { pattern: /(^|\/)contentunlocks\.meta$/i, type: "CONTENT_UNLOCKING_META" },
  { pattern: /(^|\/)dlctext\.meta$/i, type: "DLC_TEXT_FILE" },
  // weapon 系の meta はそれぞれ別の data_file タイプが必要。まとめて
  // WEAPONINFO_FILE として登録すると weaponarchetypes.meta (モデル名/txd名の
  // 対応表) が読み込まれず、「装備アニメーションはするがモデルが見えない」
  // 症状になる。より具体的なパターンを先に評価する必要がある。
  { pattern: /(^|\/)weaponcomponents[^/]*\.meta$/i, type: "WEAPONCOMPONENTSINFO_FILE" },
  { pattern: /(^|\/)weaponarchetypes[^/]*\.meta$/i, type: "WEAPON_METADATA_FILE" },
  { pattern: /(^|\/)weaponanimations[^/]*\.meta$/i, type: "WEAPON_ANIMATIONS_FILE" },
  { pattern: /(^|\/)weapon(?:pedpersonality)?s?[^/]*\.meta$/i, type: "WEAPONINFO_FILE" },
  { pattern: /(^|\/)pedpersonality\.meta$/i, type: "PED_PERSONALITY_FILE" },
  { pattern: /(^|\/)peds\.meta$/i, type: "PED_METADATA_FILE" },
  { pattern: /(^|\/)shop_vehicle\.meta$/i, type: "VEHICLE_SHOP_DLC_FILE" },
];

export interface CandidateFile {
  sourcePath: string;
  data: Uint8Array;
  hash: string;
}

export interface ResolvedFile {
  resourcePath: string;
  sourcePath: string;
  data: Uint8Array;
}

export interface ConflictGroup {
  resourcePath: string;
  candidates: CandidateFile[];
}

export interface AnalyzeIssue {
  severity: "error" | "warning";
  path: string;
  message: string;
}

export interface AnalyzeResult {
  resolved: ResolvedFile[];
  conflicts: ConflictGroup[];
  issues: AnalyzeIssue[];
  rootNameGuess: string;
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// GTA5-Mods の addon 系 mod は dlc.rpf (中に weapons.rpf 等をネストして含む
// DLC パック) のまま配布されることが多い。展開しないと中の .ydr/.ytd/.meta に
// 届かず、RPF アーカイブそのものを stream/ に置いてしまう致命的な誤配置になる。
function expandArchives(sourceFiles: Map<string, Uint8Array>, issues: AnalyzeIssue[]): Map<string, Uint8Array> {
  const expanded = new Map<string, Uint8Array>();

  for (const [rawPath, data] of sourceFiles) {
    const normalized = normalizeArchivePath(rawPath);
    if (!normalized) continue;

    if (getExtension(normalized) === "rpf") {
      if (!isRPF7(data)) {
        issues.push({
          severity: "error",
          path: normalized,
          message: "RPF7ヘッダーが不正です(壊れているか対応していない形式)。展開できないため除外されます。",
        });
        continue;
      }
      if (isEncryptedRPF(data)) {
        issues.push({
          severity: "error",
          path: normalized,
          message:
            "暗号化(AES/NG)された RPF は非対応です。OpenIV/CodeWalker 等で復号・展開してから中身のファイルをアップロードし直してください。",
        });
        continue;
      }
      try {
        const inner = extractAllFiles(data);
        for (const [innerPath, innerData] of inner) {
          expanded.set(`${normalized}/${innerPath}`, innerData);
        }
      } catch (e) {
        issues.push({
          severity: "error",
          path: normalized,
          message: `RPFの展開に失敗しました: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
      continue;
    }

    expanded.set(normalized, data);
  }

  return expanded;
}

// stream/data 分類・RSC7 検証・重複解決の共通ロジック。単一リソースモードと
// フォルダ分割モードの両方から使う。
async function buildAnalyzeResult(
  files: Map<string, Uint8Array>,
  issues: AnalyzeIssue[],
): Promise<{ resolved: ResolvedFile[]; conflicts: ConflictGroup[] }> {
  const grouped = new Map<string, { sourcePath: string; data: Uint8Array }[]>();

  for (const [normalized, data] of files) {
    if (shouldExcludeFromResource(normalized)) continue;

    const ext = getExtension(normalized);

    if (STREAM_EXTENSIONS.has(ext)) {
      const header = readRSC7Header(data);
      if (!header) {
        issues.push({
          severity: "error",
          path: normalized,
          message:
            "RSC7ヘッダーが見つかりません(壊れているか、RAGEバイナリではない可能性があります)。このファイルはリソースから除外されます。",
        });
        continue;
      }
      const knownVersions = KNOWN_RSC_VERSIONS[ext];
      if (knownVersions && !knownVersions.includes(header.version)) {
        issues.push({
          severity: "warning",
          path: normalized,
          message: `RSC7バージョンが一般的な値(${knownVersions.join(" / ")})と異なります(実際の値: ${header.version})。古い/新しいツールでエクスポートされた可能性があります。`,
        });
      }
    }

    const resourcePath = getFiveMResourcePath(normalized);
    const list = grouped.get(resourcePath) ?? [];
    list.push({ sourcePath: normalized, data });
    grouped.set(resourcePath, list);
  }

  const resolved: ResolvedFile[] = [];
  const conflicts: ConflictGroup[] = [];

  for (const [resourcePath, list] of grouped) {
    if (list.length === 1) {
      const only = list[0]!;
      resolved.push({ resourcePath, sourcePath: only.sourcePath, data: only.data });
      continue;
    }

    const withHash: CandidateFile[] = await Promise.all(
      list.map(async (f) => ({ ...f, hash: await sha256Hex(f.data) })),
    );
    const uniqueHashes = new Set(withHash.map((f) => f.hash));

    if (uniqueHashes.size === 1) {
      // 中身が完全一致なので実害なし。1つに統合するだけ。
      resolved.push({
        resourcePath,
        sourcePath: withHash[0]!.sourcePath,
        data: withHash[0]!.data,
      });
    } else {
      conflicts.push({ resourcePath, candidates: withHash });
      issues.push({
        severity: "warning",
        path: resourcePath,
        message: `中身が異なる${list.length}個のファイルが同名(${resourcePath})になります。FiveMの stream/ はフラットな名前空間のため1つしか配置できません。採用するファイルを選ぶか、フォルダ単位で別リソースに分割してください。`,
      });
    }
  }

  resolved.sort((a, b) => a.resourcePath.localeCompare(b.resourcePath));
  return { resolved, conflicts };
}

export async function analyzeSourceFiles(
  sourceFiles: Map<string, Uint8Array>,
  sourceFileName: string,
): Promise<AnalyzeResult> {
  const issues: AnalyzeIssue[] = [];
  const expandedFiles = expandArchives(sourceFiles, issues);

  const normalizedFiles = new Map<string, Uint8Array>();
  for (const [rawPath, data] of expandedFiles) {
    const normalized = normalizeArchivePath(rawPath);
    if (normalized) normalizedFiles.set(normalized, data);
  }

  const { resolved, conflicts } = await buildAnalyzeResult(normalizedFiles, issues);

  const rootNameGuess =
    detectVehicleModelName(resolved) ?? sanitizeResourceName(sourceFileName.replace(/\.(zip|rpf)$/i, ""));

  return { resolved, conflicts, issues, rootNameGuess };
}

// --- フォルダ単位で複数リソースに分割するモード ---
// GTA5-Mods の武器コレクション (例: 20種類の武器を1つの zip にまとめたもの) は
// 各武器フォルダが同じ名前の共有アタッチメント (サプレッサー等) を少しずつ違う
// 中身で持っていることが多く、単一リソースに統合しようとすると大量の競合が
// 発生して手動解決が非現実的になる。フォルダ単位でそれぞれ独立した FiveM
// リソースとして出力すれば、各グループ内で重複しない限り競合は発生しない。

// stream/data の中間パスなど、武器名グルーピングの手がかりにならない
// 構造的なディレクトリ名を除外して、意味のある最初のセグメントを探す。
const STRUCTURAL_SEGMENTS = new Set([
  "stream",
  "data",
  "meta",
  "metas",
  "ai",
  "x64",
  "models",
  "cdimages",
  "common",
  "anim",
  "levels",
  "props",
  "weapons",
]);

function isStructuralSegment(segment: string): boolean {
  const lower = segment.toLowerCase();
  return STRUCTURAL_SEGMENTS.has(lower) || lower.endsWith(".rpf");
}

// ZIP やフォルダドロップは "ggc-weapons/" や "GGC-Weapons-main/" のような、
// 武器名とは無関係な単一のコンテナフォルダを先頭に含むことが多い。全ファイルが
// 共通して持つ先頭セグメントを検出し、意味のある構造名 (stream 等) に
// たどり着くまで読み飛ばす段数を返す。
function countCommonContainerDepth(paths: string[]): number {
  let depth = 0;
  while (depth < 5) {
    const seen = new Set<string>();
    let allDeepEnough = true;
    for (const p of paths) {
      const segs = p.split("/");
      if (segs.length <= depth + 1) {
        allDeepEnough = false;
        break;
      }
      seen.add(segs[depth]!.toLowerCase());
    }
    if (!allDeepEnough || seen.size !== 1) break;
    if (isStructuralSegment([...seen][0]!)) break;
    depth++;
  }
  return depth;
}

function guessGroupKey(normalizedPath: string, skipSegments = 0): string {
  const segments = normalizedPath.split("/").slice(skipSegments, -1);
  for (const seg of segments) {
    if (isStructuralSegment(seg)) continue;
    return seg;
  }
  return "(root)";
}

export interface ResourceGroupResult {
  groupKey: string;
  resourceName: string;
  resolved: ResolvedFile[];
  conflicts: ConflictGroup[];
}

export interface GroupedAnalyzeResult {
  groups: ResourceGroupResult[];
  issues: AnalyzeIssue[];
}

export async function analyzeSourceFilesAsGroups(
  sourceFiles: Map<string, Uint8Array>,
): Promise<GroupedAnalyzeResult> {
  const issues: AnalyzeIssue[] = [];
  const expandedFiles = expandArchives(sourceFiles, issues);

  const normalizedEntries: { path: string; data: Uint8Array }[] = [];
  for (const [rawPath, data] of expandedFiles) {
    const normalized = normalizeArchivePath(rawPath);
    if (normalized) normalizedEntries.push({ path: normalized, data });
  }

  const containerDepth = countCommonContainerDepth(normalizedEntries.map((f) => f.path));

  const byGroup = new Map<string, Map<string, Uint8Array>>();
  for (const { path: normalized, data } of normalizedEntries) {
    const groupKey = guessGroupKey(normalized, containerDepth);
    const bucket = byGroup.get(groupKey) ?? new Map<string, Uint8Array>();
    bucket.set(normalized, data);
    byGroup.set(groupKey, bucket);
  }

  const usedNames = new Set<string>();
  const groups: ResourceGroupResult[] = [];
  for (const [groupKey, files] of byGroup) {
    const groupIssues: AnalyzeIssue[] = [];
    const { resolved, conflicts } = await buildAnalyzeResult(files, groupIssues);
    if (resolved.length === 0 && conflicts.length === 0) continue;

    for (const issue of groupIssues) issues.push({ ...issue, path: `${groupKey}/${issue.path}` });

    let resourceName = sanitizeResourceName(groupKey);
    while (usedNames.has(resourceName)) resourceName = `${resourceName}_2`;
    usedNames.add(resourceName);

    groups.push({ groupKey, resourceName, resolved, conflicts });
  }

  groups.sort((a, b) => a.groupKey.localeCompare(b.groupKey));
  return { groups, issues };
}

export function applyGroupConflictResolutions(
  groups: ResourceGroupResult[],
  selections: Map<string, string>, // `${groupKey}::${resourcePath}` -> 選択された sourcePath
): { groupKey: string; resourceName: string; files: ResolvedFile[] }[] {
  return groups.map((group) => {
    const files = [...group.resolved];
    for (const conflict of group.conflicts) {
      const key = `${group.groupKey}::${conflict.resourcePath}`;
      const chosenSourcePath = selections.get(key) ?? conflict.candidates[0]?.sourcePath;
      const chosen = conflict.candidates.find((c) => c.sourcePath === chosenSourcePath) ?? conflict.candidates[0];
      if (chosen) {
        files.push({ resourcePath: conflict.resourcePath, sourcePath: chosen.sourcePath, data: chosen.data });
      }
    }
    files.sort((a, b) => a.resourcePath.localeCompare(b.resourcePath));
    return { groupKey: group.groupKey, resourceName: group.resourceName, files };
  });
}

export function applyConflictResolutions(
  result: AnalyzeResult,
  selections: Map<string, string>, // resourcePath -> 選択された sourcePath
): ResolvedFile[] {
  const files = [...result.resolved];
  for (const conflict of result.conflicts) {
    const chosenSourcePath = selections.get(conflict.resourcePath) ?? conflict.candidates[0]?.sourcePath;
    const chosen = conflict.candidates.find((c) => c.sourcePath === chosenSourcePath) ?? conflict.candidates[0];
    if (chosen) {
      files.push({ resourcePath: conflict.resourcePath, sourcePath: chosen.sourcePath, data: chosen.data });
    }
  }
  files.sort((a, b) => a.resourcePath.localeCompare(b.resourcePath));
  return files;
}

export function buildFxManifest(files: ResolvedFile[]): string {
  const dataFiles = files.filter((f) => f.resourcePath.startsWith("data/"));
  const ytypFiles = files.filter((f) => f.resourcePath.toLowerCase().endsWith(".ytyp"));

  const lines = [
    "fx_version 'cerulean'",
    "game 'gta5'",
    "",
    "author 'Generated by FiveM Weapon Fixer'",
    "description 'Auto-repackaged FiveM stream resource'",
  ];

  if (dataFiles.length > 0) {
    lines.push("", "files {");
    for (const f of dataFiles) lines.push(`  '${escapeLuaString(f.resourcePath)}',`);
    lines.push("}");
  }

  for (const f of ytypFiles) {
    lines.push(`data_file 'DLC_ITYP_REQUEST' '${escapeLuaString(f.resourcePath)}'`);
  }

  const seen = new Set<string>();
  for (const f of dataFiles) {
    const type = getDataFileType(f.resourcePath);
    if (!type) continue;
    const line = `data_file '${type}' '${escapeLuaString(f.resourcePath)}'`;
    if (!seen.has(line)) {
      seen.add(line);
      lines.push(line);
    }
  }

  lines.push("");
  return lines.join("\n");
}

function isVehicleResource(files: ResolvedFile[]): boolean {
  return files.some((f) => /(^|\/)(vehicles|handling|carcols|carvariations)\.meta$/i.test(f.resourcePath));
}

function detectVehicleModelName(files: ResolvedFile[]): string | null {
  if (!isVehicleResource(files)) return null;
  const counts = new Map<string, number>();
  for (const f of files) {
    if (getExtension(f.resourcePath) !== "yft") continue;
    const base = getBaseName(f.resourcePath).replace(/\.yft$/i, "");
    const model = base.replace(/[_+]hi$/i, "").trim();
    if (!model) continue;
    counts.set(model, (counts.get(model) ?? 0) + 1);
  }
  if (counts.size === 0) return null;

  let bestName: string | null = null;
  let bestCount = -1;
  for (const [name, count] of counts) {
    if (count > bestCount || (count === bestCount && bestName !== null && name.length < bestName.length)) {
      bestName = name;
      bestCount = count;
    }
  }
  return bestName ? sanitizeResourceName(bestName) : null;
}

export function sanitizeResourceName(name: string): string {
  const normalized = name
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  return normalized || "fivem_resource";
}

function normalizeArchivePath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/(?:^|\/)\.\.(?=\/|$)/g, "")
    .split("/")
    .filter(Boolean)
    .join("/");
}

function shouldExcludeFromResource(path: string): boolean {
  const ext = getExtension(path);
  if (EXCLUDED_EXTENSIONS.has(ext)) return true;
  if (EXCLUDED_FILENAMES.has(getBaseName(path).toLowerCase())) return true;
  // stream/data のどちらにも属さない拡張子 (readme.txt 等の同梱ファイル) は
  // FiveM リソースとして無意味なので混入させない。
  if (!STREAM_EXTENSIONS.has(ext) && !DATA_EXTENSIONS.has(ext)) return true;
  return false;
}

// FiveM リソースは stream/ と data/ のフラット構造を取る。DLC RPF の
// 深いネストパスは basename だけ残して平坦化する。
function getFiveMResourcePath(path: string): string {
  const ext = getExtension(path);
  const base = getBaseName(path);
  if (STREAM_EXTENSIONS.has(ext)) return `stream/${base}`;
  if (DATA_EXTENSIONS.has(ext)) return `data/${base}`;
  return `stream/${base}`;
}

function getDataFileType(path: string): string | null {
  for (const { pattern, type } of META_DATA_FILE_TYPES) {
    if (pattern.test(path)) return type;
  }
  return null;
}

function escapeLuaString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

export { isVehicleResource };
