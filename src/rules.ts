// 判定：冲突检测、风险例外的生效/失效推导与放行阻塞计算。纯逻辑，无 UI、无副作用。

import {
  ApprovalStatus,
  ConflictKind,
  CrowdZone,
  Exemption,
  FuseNode,
  FUSE_SEGMENT,
  MIN_SAME_POINT_GAP,
  NodeSignature,
  parseTime,
  ShowState,
} from "./model";

export interface Conflict {
  /** 冲突指纹：同指纹在数据变化前后始终代表同一个冲突 */
  key: string;
  kind: ConflictKind;
  /** 参与冲突的节点 id（crowd 类只有一个） */
  nodeIds: string[];
  title: string;
  detail: string;
  /** 人员密集区冲突不得例外；其余可申请风险例外 */
  exemptable: boolean;
}

export function nodeSignature(node: FuseNode): NodeSignature {
  return {
    musicCueMs: parseTime(node.musicCue) ?? 0,
    launchAngle: node.launchAngle,
    safetyDistance: node.safetyDistance,
  };
}

function signatureMatches(ex: Exemption, nodes: FuseNode[]): boolean {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const id of Object.keys(ex.snapshot)) {
    const node = byId.get(id);
    if (!node) return false; // 相关节点已删除
    const cur = nodeSignature(node);
    const old = ex.snapshot[id];
    if (
      cur.musicCueMs !== old.musicCueMs ||
      cur.launchAngle !== old.launchAngle ||
      cur.safetyDistance !== old.safetyDistance
    ) {
      return false;
    }
  }
  return true;
}

function makeKey(kind: ConflictKind, ids: string[]): string {
  return `${kind}|${[...ids].sort().join("|")}`;
}

/* ---------------- 冲突检测 ---------------- */

function detectCrowdConflicts(
  nodes: FuseNode[],
  zones: CrowdZone[]
): Conflict[] {
  const out: Conflict[] = [];
  for (const n of nodes) {
    for (const z of zones) {
      const d = Math.hypot(n.x - z.x, n.y - z.y);
      // 安全距离覆盖到密集区边缘即视为侵入
      if (d - z.radius < n.safetyDistance) {
        out.push({
          key: makeKey("crowd", [n.id, z.id]),
          kind: "crowd",
          nodeIds: [n.id],
          title: `${n.pointName}「${n.model}」侵入${z.name}`,
          detail: `${n.pointName}距${z.name}中心 ${d.toFixed(1)}m，安全距离要求 ${n.safetyDistance}m（密集区半径 ${z.radius}m）`,
          exemptable: false,
        });
      }
    }
  }
  return out;
}

function detectIntervalConflicts(nodes: FuseNode[]): Conflict[] {
  const byPoint = new Map<string, FuseNode[]>();
  for (const n of nodes) {
    const list = byPoint.get(n.pointName) ?? [];
    list.push(n);
    byPoint.set(n.pointName, list);
  }
  const out: Conflict[] = [];
  for (const [point, list] of byPoint) {
    const sorted = [...list].sort(
      (a, b) =>
        (parseTime(a.musicCue) ?? 0) - (parseTime(b.musicCue) ?? 0)
    );
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      const gap =
        (parseTime(cur.musicCue) ?? 0) - (parseTime(prev.musicCue) ?? 0);
      if (gap < MIN_SAME_POINT_GAP) {
        out.push({
          key: makeKey("interval", [prev.id, cur.id]),
          kind: "interval",
          nodeIds: [prev.id, cur.id],
          title: `${point}同点位间隔 ${(gap / 1000).toFixed(2)}s`,
          detail: `${prev.musicCue}「${prev.model}」与 ${cur.musicCue}「${cur.model}」间隔不足 ${MIN_SAME_POINT_GAP / 1000} 秒`,
          exemptable: true,
        });
      }
    }
  }
  return out;
}

function detectFuseConflicts(nodes: FuseNode[]): Conflict[] {
  const byLine = new Map<string, FuseNode[]>();
  for (const n of nodes) {
    const list = byLine.get(n.fuseLine) ?? [];
    list.push(n);
    byLine.set(n.fuseLine, list);
  }
  const out: Conflict[] = [];
  for (const [line, list] of byLine) {
    const sorted = [...list].sort((a, b) => a.fuseOffset - b.fuseOffset);
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      if (Math.floor(prev.fuseOffset / FUSE_SEGMENT) ===
          Math.floor(cur.fuseOffset / FUSE_SEGMENT)) {
        // 同点位间隔冲突已覆盖同一位置的连放，这里不重复报引信越段
        if (prev.pointName === cur.pointName) continue;
        out.push({
          key: makeKey("fuse", [prev.id, cur.id]),
          kind: "fuse",
          nodeIds: [prev.id, cur.id],
          title: `${line} 引信越段（${prev.pointName}↔${cur.pointName}）`,
          detail: `${prev.pointName}位于引信 ${prev.fuseOffset}ms、${cur.pointName}位于 ${cur.fuseOffset}ms，同处一个 ${FUSE_SEGMENT / 1000} 秒分段`,
          exemptable: true,
        });
      }
    }
  }
  return out;
}

export function detectConflicts(state: ShowState): Conflict[] {
  return [
    ...detectCrowdConflicts(state.nodes, state.zones),
    ...detectIntervalConflicts(state.nodes),
    ...detectFuseConflicts(state.nodes),
  ];
}

/* ---------------- 例外状态推导 ---------------- */

/**
 * 审批记录的实际状态：
 *  - rejected            -> 驳回（终态）
 *  - approved + 条件满足  -> 有效（可解除阻塞）
 *  - approved + 条件破坏  -> 失效（超时 / 节点音乐点·发射角·安全距离变化 / 节点删除）
 *  - pending             -> 待审；条件已破坏则同样显示为失效，不再进入审批
 */
export type EffectiveStatus = "pending" | "active" | "expired" | "rejected";

export interface EffectiveExemption {
  exemption: Exemption;
  effective: EffectiveStatus;
  expireReason?: "timeout" | "changed" | "deleted";
}

export function evaluateExemption(
  ex: Exemption,
  nodes: FuseNode[],
  nowMs: number
): EffectiveExemption {
  if (ex.status === "rejected") return { exemption: ex, effective: "rejected" };

  const nodeExists = ex.nodeIds.every((id) => nodes.some((n) => n.id === id));
  if (!nodeExists) {
    return { exemption: ex, effective: "expired", expireReason: "deleted" };
  }
  if (!signatureMatches(ex, nodes)) {
    return { exemption: ex, effective: "expired", expireReason: "changed" };
  }
  if (nowMs >= ex.expiresAt) {
    return { exemption: ex, effective: "expired", expireReason: "timeout" };
  }
  if (ex.status === "pending") {
    return { exemption: ex, effective: "pending" };
  }
  return { exemption: ex, effective: "active" };
}

export function evaluateAll(
  exemptions: Exemption[],
  nodes: FuseNode[],
  nowMs: number
): EffectiveExemption[] {
  return exemptions.map((ex) => evaluateExemption(ex, nodes, nowMs));
}

export const EXPIRE_REASON_TEXT: Record<NonNullable<EffectiveExemption["expireReason"]>, string> = {
  timeout: "已到失效时刻",
  changed: "音乐点 / 发射角 / 安全距离已变化",
  deleted: "关联点火节点已删除",
};

/* ---------------- 阻塞计算 ---------------- */

export interface BlockingResult {
  conflicts: Conflict[];
  /** 冲突 -> 有效例外（仅 active 可解除阻塞） */
  activeByKey: Map<string, Exemption>;
  blocked: Conflict[];
  released: Conflict[];
  /** 冲突指纹 -> 已存在的待审/有效记录（用于阻止重复提交） */
  openByKey: Map<string, Exemption>;
}

export function computeBlocking(state: ShowState, nowMs: number): BlockingResult {
  const conflicts = detectConflicts(state);
  const evaluated = evaluateAll(state.exemptions, state.nodes, nowMs);

  const activeByKey = new Map<string, Exemption>();
  const openByKey = new Map<string, Exemption>();
  for (const ee of evaluated) {
    if (ee.effective === "active") activeByKey.set(ee.exemption.conflictKey, ee.exemption);
    // 待审与有效都属于"未结案的申请"，同一冲突不能重复提交
    if (ee.effective === "active" || ee.effective === "pending") {
      openByKey.set(ee.exemption.conflictKey, ee.exemption);
    }
  }

  const blocked: Conflict[] = [];
  const released: Conflict[] = [];
  for (const c of conflicts) {
    // 人员密集区不得例外；只有有效例外可以解除放行阻塞
    if (!c.exemptable || !activeByKey.has(c.key)) blocked.push(c);
    else released.push(c);
  }
  return { conflicts, activeByKey, blocked, released, openByKey };
}

/* ---------------- 提交校验 ---------------- */

export type SubmitIssue =
  | "crowd-forbidden"
  | "duplicate"
  | "missing-approver"
  | "missing-reason"
  | "bad-expiry"
  | "expiry-after-show";

export const SUBMIT_ISSUE_TEXT: Record<SubmitIssue, string> = {
  "crowd-forbidden": "人员密集区冲突依法禁止例外",
  duplicate: "该冲突已有待审或有效的例外申请",
  "missing-approver": "请填写安全负责人",
  "missing-reason": "请填写风险放行理由",
  "bad-expiry": "失效时刻格式应为 mm:ss.SSS",
  "expiry-after-show": "失效时刻不得晚于整场结束",
};

export interface DraftInput {
  approver: string;
  reason: string;
  expiresAtText: string;
}

export function validateDraft(
  conflict: Conflict,
  draft: DraftInput,
  state: ShowState,
  nowMs: number
): SubmitIssue | null {
  if (conflict.kind === "crowd") return "crowd-forbidden";
  if (computeBlocking(state, nowMs).openByKey.has(conflict.key)) return "duplicate";
  if (!draft.approver.trim()) return "missing-approver";
  if (!draft.reason.trim()) return "missing-reason";
  const expiresAt = parseTime(draft.expiresAtText);
  if (expiresAt === null) return "bad-expiry";
  if (expiresAt > state.showEndMs) return "expiry-after-show";
  return null;
}

export function isApproved(status: ApprovalStatus): boolean {
  return status === "approved";
}
