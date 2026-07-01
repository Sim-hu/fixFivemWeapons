import type { GroupedAnalyzeResult } from "../lib/resource-builder";
import { ConflictResolver } from "./ConflictResolver";

interface GroupedResultViewProps {
  result: GroupedAnalyzeResult;
  selections: Map<string, string>;
  onSelect: (key: string, sourcePath: string) => void;
}

export function GroupedResultView({ result, selections, onSelect }: GroupedResultViewProps) {
  const totalConflicts = result.groups.reduce((n, g) => n + g.conflicts.length, 0);

  return (
    <div className="space-y-4">
      <div className="bg-gray-900/60 rounded-lg border border-gray-700 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-800 text-gray-400">
            <tr>
              <th className="text-left px-3 py-2 font-medium">出力リソース名</th>
              <th className="text-right px-3 py-2 font-medium">stream</th>
              <th className="text-right px-3 py-2 font-medium">data</th>
              <th className="text-right px-3 py-2 font-medium">競合</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800">
            {result.groups.map((g) => {
              const streamCount = g.resolved.filter((f) => f.resourcePath.startsWith("stream/")).length;
              const dataCount = g.resolved.filter((f) => f.resourcePath.startsWith("data/")).length;
              return (
                <tr key={g.groupKey}>
                  <td className="px-3 py-1.5 font-mono text-gray-200">{g.resourceName}</td>
                  <td className="px-3 py-1.5 text-right text-gray-400">{streamCount}</td>
                  <td className="px-3 py-1.5 text-right text-gray-400">{dataCount}</td>
                  <td className={`px-3 py-1.5 text-right ${g.conflicts.length > 0 ? "text-amber-400" : "text-gray-600"}`}>
                    {g.conflicts.length}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {totalConflicts > 0 && (
        <div className="space-y-3">
          {result.groups
            .filter((g) => g.conflicts.length > 0)
            .map((g) => (
              <ConflictResolver
                key={g.groupKey}
                conflicts={g.conflicts}
                selections={selections}
                onSelect={onSelect}
                keyPrefix={`${g.groupKey}::`}
                heading={`${g.resourceName} の競合 (${g.conflicts.length}件)`}
                description="このリソース内で同名だが中身が異なるファイルが見つかりました。採用するファイルを選んでください。"
              />
            ))}
        </div>
      )}
    </div>
  );
}
