import type { ConflictGroup } from "../lib/resource-builder";

interface ConflictResolverProps {
  conflicts: ConflictGroup[];
  selections: Map<string, string>;
  onSelect: (selectionKey: string, sourcePath: string) => void;
  keyPrefix?: string;
  heading?: string;
  description?: string;
}

export function ConflictResolver({
  conflicts,
  selections,
  onSelect,
  keyPrefix = "",
  heading = `同名ファイルの競合 (${conflicts.length}件)`,
  description = "FiveM の stream/ はフラットな名前空間のため、同名だが中身が異なるファイルは1つしか配置できません。採用するファイルを選んでください。",
}: ConflictResolverProps) {
  if (conflicts.length === 0) return null;

  return (
    <div className="bg-amber-900/20 border border-amber-700/50 rounded-lg p-4 space-y-4">
      <div>
        <h3 className="text-amber-300 font-semibold">{heading}</h3>
        <p className="text-amber-200/70 text-sm mt-1">{description}</p>
      </div>

      {conflicts.map((conflict) => {
        const selectionKey = `${keyPrefix}${conflict.resourcePath}`;
        return (
          <div key={selectionKey} className="bg-gray-900/60 rounded-lg p-3">
            <div className="font-mono text-sm text-gray-200 mb-2">{conflict.resourcePath}</div>
            <div className="space-y-1">
              {conflict.candidates.map((candidate) => (
                <label
                  key={candidate.sourcePath}
                  className="flex items-center gap-2 text-sm text-gray-300 hover:bg-gray-800 rounded px-2 py-1 cursor-pointer"
                >
                  <input
                    type="radio"
                    name={selectionKey}
                    checked={(selections.get(selectionKey) ?? conflict.candidates[0]?.sourcePath) === candidate.sourcePath}
                    onChange={() => onSelect(selectionKey, candidate.sourcePath)}
                  />
                  <span className="font-mono truncate flex-1">{candidate.sourcePath}</span>
                  <span className="text-gray-500 text-xs shrink-0">{formatSize(candidate.data.length)}</span>
                </label>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
