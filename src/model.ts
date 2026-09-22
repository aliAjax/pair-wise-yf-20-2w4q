// 业务模型层：类型定义、节目/点位/音乐点种子数据、时间工具与浏览器本地存储。
// 数据只保存在 localStorage，不引入任何服务端或外部依赖。

export type ConflictKind = "crowd" | "interval" | "overrun";

export type ExceptionStatus = "pending" | "approved" | "invalid" | "rejected";

export interface Segment {
  id: string;
  name: string;
  start: number; // ms
  end: number; // ms
  color: string;
}

export interface Position {
  id: string;
  name: string;
  x: number; // 平面图百分比坐标
  y: number;
}

export interface CrowdZone {
  id: string;
  name: string;
  x: number;
  y: number;
  r: number;
}

export interface FireNode {
  id: string;
  name: string;
  segmentId: string;
  positionId: string;
  model: string;
  caliber: number; // mm
  angle: number; // 发射角（度，0=垂直，相对水平基准）
  time: number; // 点火时间（音乐点，相对整场，ms）
  duration: number; // ms
  safetyDistance: number; // m
}

export interface RiskException {
  id: string;
  conflictId: string;
  kind: ConflictKind;
  nodeIds: string[]; // 例外绑定的节点，用于指纹失效判定
  fingerprint: string; // 提交/审批时刻的状态快照
  safetyOwner: string; // 安全负责人
  reason: string;
  expireAt: number; // 失效时刻（ms），不得晚于整场结束
  status: ExceptionStatus; // pending / approved / invalid(含超时与被改失效) / rejected
  createdAt: number;
  decidedAt?: number;
  decider?: string;
  rejectNote?: string;
  invalidReason?: "expired" | "modified";
}

export interface ShowState {
  nodes: FireNode[];
  exceptions: RiskException[];
}

export const SHOW_END = 240_000; // 整场结束 04:00.000
export const MIN_POSITION_INTERVAL = 2000; // 同点位最小点火间隔 ms
export const STORAGE_KEY = "fireworks-show-state-v1";

export const SEGMENTS: Segment[] = [
  { id: "seg-intro", name: "Intro 引子", start: 0, end: 60_000, color: "#1d4ed8" },
  { id: "seg-chorusa", name: "Chorus A 主歌", start: 60_000, end: 120_000, color: "#7c3aed" },
  { id: "seg-bridge", name: "Bridge 桥段", start: 120_000, end: 180_000, color: "#0891b2" },
  { id: "seg-finale", name: "Finale 终场", start: 180_000, end: SHOW_END, color: "#dc2626" },
];

export const POSITIONS: Position[] = [
  { id: "pos-a", name: "A·主舞台左", x: 24, y: 72 },
  { id: "pos-b", name: "B·主舞台右", x: 76, y: 72 },
  { id: "pos-c", name: "C·前场中心", x: 50, y: 30 },
  { id: "pos-d", name: "D·后场高架", x: 50, y: 88 },
];

export const CROWD_ZONES: CrowdZone[] = [
  { id: "zone-audience", name: "观众密集区", x: 50, y: 12, r: 20 },
  { id: "zone-vip", name: "VIP密集区", x: 14, y: 14, r: 10 },
];

export const NODE_SEED: FireNode[] = [
  {
    id: "n1",
    name: "引子开场扇形",
    segmentId: "seg-intro",
    positionId: "pos-a",
    model: "30mm扇形架",
    caliber: 30,
    angle: 78,
    time: 12_500,
    duration: 3000,
    safetyDistance: 35,
  },
  {
    id: "n2",
    name: "引子冷焰跟拍",
    segmentId: "seg-intro",
    positionId: "pos-d",
    model: "冷焰火",
    caliber: 12,
    angle: 90,
    time: 24_000,
    duration: 5000,
    safetyDistance: 15,
  },
  // n3 落于观众密集区：人员密集区冲突，不允许例外
  {
    id: "n3",
    name: "前场迎宾礼花",
    segmentId: "seg-chorusa",
    positionId: "pos-c",
    model: "75mm礼花弹",
    caliber: 75,
    angle: 62,
    time: 68_200,
    duration: 4000,
    safetyDistance: 60,
  },
  // n4 与 n5 同在 B 点位且间隔 1.8s < 2s：同点位间隔冲突
  {
    id: "n4",
    name: "右场连续礼花",
    segmentId: "seg-chorusa",
    positionId: "pos-b",
    model: "75mm礼花弹",
    caliber: 75,
    angle: 80,
    time: 70_000,
    duration: 4000,
    safetyDistance: 60,
  },
  {
    id: "n5",
    name: "主歌右场罗马烛",
    segmentId: "seg-chorusa",
    positionId: "pos-b",
    model: "罗马烛光",
    caliber: 25,
    angle: 80,
    time: 71_800,
    duration: 3500,
    safetyDistance: 30,
  },
  {
    id: "n6",
    name: "桥段高台冷焰",
    segmentId: "seg-bridge",
    positionId: "pos-d",
    model: "冷焰火",
    caliber: 12,
    angle: 90,
    time: 132_000,
    duration: 6000,
    safetyDistance: 15,
  },
  // n7 点火窗口越过桥段结束 180s：引信越段冲突
  {
    id: "n7",
    name: "桥段收尾扇形",
    segmentId: "seg-bridge",
    positionId: "pos-a",
    model: "50mm扇形架",
    caliber: 50,
    angle: 75,
    time: 176_500,
    duration: 9000,
    safetyDistance: 45,
  },
  {
    id: "n8",
    name: "终场齐射",
    segmentId: "seg-finale",
    positionId: "pos-b",
    model: "100mm礼花弹",
    caliber: 100,
    angle: 85,
    time: 210_000,
    duration: 5000,
    safetyDistance: 80,
  },
  // n9 与 n8 同点位间隔 1.9s：同点位间隔冲突
  {
    id: "n9",
    name: "终场补点齐射",
    segmentId: "seg-finale",
    positionId: "pos-b",
    model: "100mm礼花弹",
    caliber: 100,
    angle: 85,
    time: 211_900,
    duration: 5000,
    safetyDistance: 80,
  },
];

// ---- 时间工具 ----

export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** 毫秒 -> mm:ss.fff */
export function fmtTime(ms: number): string {
  const clamped = Math.max(0, Math.round(ms));
  const m = Math.floor(clamped / 60_000);
  const s = Math.floor((clamped % 60_000) / 1000);
  const f = clamped % 1000;
  return `${pad2(m)}:${pad2(s)}.${String(f).padStart(3, "0")}`;
}

/** mm:ss(.fff) -> 毫秒；非法返回 null */
export function parseTime(text: string): number | null {
  const m = /^(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?$/.exec(text.trim());
  if (!m) return null;
  const min = Number(m[1]);
  const sec = Number(m[2]);
  const frac = m[3] ? Number(m[3].padEnd(3, "0")) : 0;
  if (sec > 59) return null;
  return min * 60_000 + sec * 1000 + frac;
}

// ---- 存储 ----

export function loadState(): ShowState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as ShowState;
      if (Array.isArray(parsed.nodes) && Array.isArray(parsed.exceptions)) {
        return parsed;
      }
    }
  } catch {
    // 存储损坏时回退种子数据
  }
  return { nodes: NODE_SEED.map((n) => ({ ...n })), exceptions: [] };
}

export function saveState(state: ShowState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // 隐私模式等情况下静默失败
  }
}

export function resetState(): ShowState {
  const fresh: ShowState = {
    nodes: NODE_SEED.map((n) => ({ ...n })),
    exceptions: [],
  };
  saveState(fresh);
  return fresh;
}

let seq = 0;
export function genId(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq}`;
}
