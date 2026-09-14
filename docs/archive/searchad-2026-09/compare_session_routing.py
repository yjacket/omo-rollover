"""Read historical OMO telemetry; never execute or resume historical tasks."""
import collections
import datetime
import json
from pathlib import Path
import statistics
import sys

sys.stdout.reconfigure(encoding="utf-8")
ROOT = Path("C:/Users/yjack/.omo/agent/sessions/--C--dev-searchad--")
SELECT = ["01a07cf9", "01a08c36", "01a091fa", "01a0926e", "01a092d1", "01a09678", "01a09716"]
results = []
for prefix in SELECT:
    path = next(ROOT.glob(f"*{prefix}*.jsonl"))
    rows = [json.loads(line) for line in path.open(encoding="utf-8")]
    main = collections.defaultdict(list)
    children = []
    seen = set()
    for line_no, row in enumerate(rows, 1):
        msg = row.get("message", {})
        if msg.get("role") == "assistant":
            end = datetime.datetime.fromisoformat(row["timestamp"].replace("Z", "+00:00")).timestamp()
            start = msg.get("timestamp", end * 1000) / 1000
            main[msg.get("provider", "?") + "/" + msg.get("model", "?")].append({
                "line": line_no, "start": start, "end": end,
                "seconds": end - start, "usage": msg.get("usage", {}),
                "error": msg.get("stopReason") in ("error", "aborted"),
            })
        for outer in row.get("details", []) if isinstance(row.get("details"), list) else []:
            if outer.get("customType") != "senpi-task.completion":
                continue
            for child in outer.get("details", []):
                stats = child.get("run_stats", {})
                key = (child.get("task_id"), child.get("status"), stats.get("runtime_ms"), stats.get("total_tokens"), stats.get("turns"))
                if key in seen:
                    continue
                seen.add(key)
                children.append({
                    "line": line_no, "timestamp": row["timestamp"],
                    **{k: child.get(k) for k in ("task_id", "name", "status", "category", "agent_type", "model", "duration_ms", "requested_model", "resolved_model", "error_message")},
                    "stats": stats,
                })
    summary = {"prefix": prefix, "path": str(path), "main": {}, "children": children}
    for model, calls in main.items():
        ok = [call for call in calls if not call["error"] and call["usage"].get("output", 0)]
        usage = {key: sum(call["usage"].get(key, 0) for call in calls) for key in ("input", "cacheRead", "cacheWrite", "output", "totalTokens")}
        durations = [call["seconds"] for call in ok if call["seconds"] >= 0]
        summary["main"][model] = {
            "calls": len(calls), "errors": sum(call["error"] for call in calls),
            "usage": usage, "response_seconds_sum": sum(durations),
            "median_response_seconds": statistics.median(durations) if durations else None,
            "p90_response_seconds": sorted(durations)[int((len(durations) - 1) * .9)] if durations else None,
            "max_response_seconds": max(durations, default=0),
            "output_per_response_second": sum(call["usage"].get("output", 0) for call in ok) / sum(durations) if sum(durations) else None,
        }
    results.append(summary)

output = Path(__file__).with_name("session-routing-metrics.json")
output.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
for result in results:
    print("SESSION", result["prefix"])
    for model, stat in result["main"].items():
        print("MAIN", model, "calls/err", stat["calls"], stat["errors"], "tokensM", round(stat["usage"]["totalTokens"] / 1e6, 2),
              "responseMin", round(stat["response_seconds_sum"] / 60, 1), "median/p90", round(stat["median_response_seconds"] or 0, 1), round(stat["p90_response_seconds"] or 0, 1),
              "out/sec", round(stat["output_per_response_second"] or 0, 1))
    groups = collections.defaultdict(list)
    for child in result["children"]:
        groups[(child["category"] or child["agent_type"] or "?", child["model"])].append(child)
    for (role, model), children in groups.items():
        sums = {key: sum(c["stats"].get(key, 0) for c in children) for key in ("runtime_ms", "generation_ms", "output_tokens", "total_tokens", "turns", "tool_calls")}
        print("CHILD", role, model, "runs", len(children), "err", sum(c["status"] != "completed" for c in children),
              "turn/tool", sums["turns"], sums["tool_calls"], "tokensM", round(sums["total_tokens"] / 1e6, 2),
              "runtimeMin", round(sums["runtime_ms"] / 60000, 1), "genMin", round(sums["generation_ms"] / 60000, 1),
              "reportedOut/sec", round(sums["output_tokens"] * 1000 / sums["generation_ms"], 1) if sums["generation_ms"] else None)
