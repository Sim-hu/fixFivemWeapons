import { readRSC7Header } from "./rsc7";
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
  { pattern: /(^|\/)weapon(?:animations|archetypes|components|pedpersonality|s)?\.meta$/i, type: "WEAPONINFO_FILE" },
  { pattern: /(^|\/)weapon(?:animations|archetypes|components|pedpersonality|s)?[^/]*\.meta$/i, type: "WEAPONINFO_FILE" },
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

export async function analyzeSourceFiles(
  sourceFiles: Map<string, Uint8Array>,
  sourceFileName: string,
): Promise<AnalyzeResult> {
  const issues: AnalyzeIssue[] = [];
  const grouped = new Map<string, { sourcePath: string; data: Uint8Array }[]>();

  for (const [rawPath, data] of sourceFiles) {
    const normalized = normalizeArchivePath(rawPath);
    if (!normalized || shouldExcludeFromResource(normalized)) continue;

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
        message: `中身が異なる${list.length}個のファイルが同名(${resourcePath})になります。FiveMの stream/ はフラットな名前空間のため1つしか配置できません。採用するファイルを選んでください。`,
      });
    }
  }

  resolved.sort((a, b) => a.resourcePath.localeCompare(b.resourcePath));

  const rootNameGuess =
    detectVehicleModelName(resolved) ?? sanitizeResourceName(sourceFileName.replace(/\.(zip|rpf)$/i, ""));

  return { resolved, conflicts, issues, rootNameGuess };
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
  return EXCLUDED_EXTENSIONS.has(getExtension(path)) || EXCLUDED_FILENAMES.has(getBaseName(path).toLowerCase());
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
