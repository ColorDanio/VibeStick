import type { Config } from "./config.js";
import type { SessionRecord } from "./store.js";

/** One locally observed usage summary for a configured CLI. */
export interface UsageEntry {
  tool: string;
  name: string;
  sessions: number;
  active: number;
  /** Latest usable context percentage, or undefined when the adapter does not report it. */
  ctx_pct?: number;
  /** Sum of usable per-session costs observed in the local session store. */
  cost_usd?: number;
  /** Latest provider quota percentage observed in a local CLI log. */
  quota_pct?: number;
  /** Sum of cumulative token snapshots across locally discovered sessions. */
  tokens?: number;
  updated: number;
}

export interface UsagePayload {
  /** Unix epoch seconds of the newest local observation. */
  updated: number;
  /** Host collection cadence advertised to clients. */
  interval_s: 30;
  list: UsageEntry[];
}

const isMetric = (value: number | undefined): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const roundMoney = (value: number): number => Math.round(value * 100) / 100;

/**
 * Aggregate only metrics that a local adapter or session reader actually
 * supplied. Wrapper records intentionally use -1 for unknown values, so tools
 * backed only by process state disappear rather than showing a misleading
 * zero/unknown row.
 */
export function collectUsage(config: Config, records: SessionRecord[]): UsagePayload {
  const configured = new Map(config.tools.filter((tool) => !tool.hidden).map((tool) => [tool.id, tool]));
  const groups = new Map<string, { records: SessionRecord[]; cost: number; costs: number; tokens: number; tokenSnapshots: number; newest?: SessionRecord; newestCtx?: SessionRecord; newestQuota?: SessionRecord }>();

  for (const record of records) {
    const tool = configured.get(record.status.tool);
    if (!tool) continue;
    const hasContext = isMetric(record.status.ctx_pct);
    const hasCost = isMetric(record.status.cost_usd);
    const hasQuota = isMetric(record.status.quota_pct);
    const tokens = record.status.tokens;
    const hasTokens = isMetric(tokens);
    if (!hasContext && !hasCost && !hasQuota && !hasTokens) continue;
    const group = groups.get(tool.id) ?? { records: [], cost: 0, costs: 0, tokens: 0, tokenSnapshots: 0 };
    group.records.push(record);
    if (hasCost) {
      group.cost += record.status.cost_usd;
      group.costs += 1;
    }
    if (hasTokens) {
      group.tokens += tokens;
      group.tokenSnapshots += 1;
    }
    if (!group.newest || record.status.updated > group.newest.status.updated) group.newest = record;
    if (hasContext && (!group.newestCtx || record.status.updated > group.newestCtx.status.updated)) group.newestCtx = record;
    if (hasQuota && (!group.newestQuota || record.status.updated > group.newestQuota.status.updated)) group.newestQuota = record;
    groups.set(tool.id, group);
  }

  const list: UsageEntry[] = [];
  for (const [id, group] of groups) {
    const tool = configured.get(id);
    if (!tool || !group.newest) continue;
    const entry: UsageEntry = {
      tool: id,
      name: tool.name,
      sessions: group.records.length,
      active: group.records.filter((record) => ["running", "waiting"].includes(record.status.state)).length,
      updated: group.newest.status.updated,
    };
    if (group.newestCtx && isMetric(group.newestCtx.status.ctx_pct)) entry.ctx_pct = Math.max(0, Math.min(100, Math.round(group.newestCtx.status.ctx_pct)));
    if (group.costs > 0) entry.cost_usd = roundMoney(Math.max(0, group.cost));
    if (group.newestQuota && isMetric(group.newestQuota.status.quota_pct)) entry.quota_pct = Math.max(0, Math.min(100, Math.round(group.newestQuota.status.quota_pct)));
    if (group.tokenSnapshots > 0) entry.tokens = Math.round(Math.max(0, group.tokens));
    list.push(entry);
  }
  list.sort((left, right) => right.updated - left.updated || left.name.localeCompare(right.name));
  return {
    updated: list.reduce((newest, entry) => Math.max(newest, entry.updated), 0),
    interval_s: 30,
    list,
  };
}
