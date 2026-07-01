import type { AnalyzeIssue } from "../lib/resource-builder";

export function IssueList({ issues }: { issues: AnalyzeIssue[] }) {
  if (issues.length === 0) return null;

  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");

  return (
    <div className="space-y-3">
      {errors.length > 0 && (
        <div className="bg-red-900/30 border border-red-700/50 rounded-lg p-4">
          <h3 className="text-red-300 font-semibold mb-2">エラー ({errors.length}件) — 除外されます</h3>
          <ul className="space-y-1 text-sm">
            {errors.map((issue, i) => (
              <li key={i} className="text-red-200/80">
                <span className="font-mono">{issue.path}</span>: {issue.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      {warnings.length > 0 && (
        <div className="bg-yellow-900/20 border border-yellow-700/40 rounded-lg p-4">
          <h3 className="text-yellow-300 font-semibold mb-2">警告 ({warnings.length}件)</h3>
          <ul className="space-y-1 text-sm">
            {warnings.map((issue, i) => (
              <li key={i} className="text-yellow-200/80">
                <span className="font-mono">{issue.path}</span>: {issue.message}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
