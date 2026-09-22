// 交互：时间轴、点位平面图、冲突清单、例外审批表单与审批记录。
// 业务模型见 model.ts，判定逻辑见 rules.ts。

import { useEffect, useMemo, useRef, useState } from "react";
import {
  clearState,
  CONFLICT_META,
  Exemption,
  formatTime,
  FuseNode,
  initialState,
  loadState,
  parseTime,
  saveState,
  ShowState,
  uid,
} from "./model";
import {
  BlockingResult,
  computeBlocking,
  Conflict,
  EXPIRE_REASON_TEXT,
  evaluateAll,
  EffectiveStatus,
  SUBMIT_ISSUE_TEXT,
  SubmitIssue,
  nodeSignature,
  validateDraft,
} from "./rules";

const STATUS_LABEL: Record<EffectiveStatus, string> = {
  pending: "待审",
  active: "有效",
  expired: "失效",
  rejected: "驳回",
};

const SECTIONS = ["Intro 引子", "Chorus 主歌", "Finale 终场"];

export default function App() {
  const [state, setState] = useState<ShowState>(() => loadState());
  const [nowMs, setNowMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [draftConflict, setDraftConflict] = useState<Conflict | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const stateRef = useRef(state);
  stateRef.current = state;

  // 数据只写入浏览器本地
  useEffect(() => {
    saveState(state);
  }, [state]);

  // 时间轴播放：每 200ms 推进 200ms，到整场结束自动停止
  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => {
      setNowMs((t) => {
        const next = t + 200;
        if (next >= stateRef.current.showEndMs) {
          setPlaying(false);
          return stateRef.current.showEndMs;
        }
        return next;
      });
    }, 200);
    return () => window.clearInterval(timer);
  }, [playing]);

  const blocking: BlockingResult = useMemo(
    () => computeBlocking(state, nowMs),
    [state, nowMs]
  );
  const evaluated = useMemo(
    () => evaluateAll(state.exemptions, state.nodes, nowMs),
    [state, nowMs]
  );

  const blockedCount = blocking.blocked.length;
  const releasedCount = blocking.released.length;
  const pendingCount = evaluated.filter((e) => e.effective === "pending").length;

  function notify(msg: string) {
    setFlash(msg);
    window.setTimeout(() => setFlash((cur) => (cur === msg ? null : cur)), 3200);
  }

  /* ---------- 节点编辑：仅音乐点 / 发射角 / 安全距离变化会立即作为例外失效原因 ---------- */

  function patchNode(id: string, patch: Partial<FuseNode>) {
    setState((prev) => {
      const before = prev.nodes.find((n) => n.id === id);
      // 音乐点 / 发射角 / 安全距离是例外快照字段：变化后待审与已审批记录都会被
      // evaluateAll 立即推导为失效，阻塞随之恢复（审批状态保留，便于审计）。
      if (before) {
        const afterSig = nodeSignature({ ...before, ...patch });
        const beforeSig = nodeSignature(before);
        const drifted =
          beforeSig.musicCueMs !== afterSig.musicCueMs ||
          beforeSig.launchAngle !== afterSig.launchAngle ||
          beforeSig.safetyDistance !== afterSig.safetyDistance;
        if (drifted) {
          const affected = prev.exemptions.filter(
            (ex) =>
              ex.status !== "rejected" &&
              ex.nodeIds.includes(id) &&
              evaluateAll([ex], prev.nodes, nowMs)[0].effective !== "expired"
          ).length;
          if (affected > 0) {
            window.setTimeout(
              () =>
                notify(
                  `节点音乐点 / 发射角 / 安全距离已变化，${affected} 条例外立即失效并恢复阻塞`
                ),
              0
            );
          }
        }
      }
      return {
        ...prev,
        nodes: prev.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)),
      };
    });
  }

  /* ---------- 审批操作 ---------- */

  function submitExemption(
    conflict: Conflict,
    approver: string,
    reason: string,
    expiresAtText: string
  ): SubmitIssue | null {
    const issue = validateDraft(
      conflict,
      { approver, reason, expiresAtText },
      state,
      nowMs
    );
    if (issue) return issue;

    const related = state.nodes.filter((n) => conflict.nodeIds.includes(n.id));
    const snapshot: Exemption["snapshot"] = {};
    for (const n of related) snapshot[n.id] = nodeSignature(n);

    const ex: Exemption = {
      id: uid("ex"),
      conflictKey: conflict.key,
      kind: conflict.kind,
      title: conflict.title,
      nodeIds: [...conflict.nodeIds].sort(),
      applicant: "当前编排师",
      approver: approver.trim(),
      reason: reason.trim(),
      expiresAt: parseTime(expiresAtText)!,
      status: "pending",
      createdAt: Date.now(),
      snapshot,
    };
    setState((prev) => ({ ...prev, exemptions: [...prev.exemptions, ex] }));
    setDraftConflict(null);
    notify("例外申请已提交，等待安全负责人审批");
    return null;
  }

  function review(id: string, approve: boolean, note?: string) {
    setState((prev) => ({
      ...prev,
      exemptions: prev.exemptions.map((ex) =>
        ex.id === id
          ? {
              ...ex,
              status: approve ? "approved" : "rejected",
              reviewedAt: Date.now(),
              rejectNote: approve ? undefined : note ?? "安全负责人驳回",
            }
          : ex
      ),
    }));
    notify(approve ? "例外已审批通过并解除阻塞" : "例外申请已驳回，冲突继续阻塞");
  }

  function resetAll() {
    clearState();
    setState(initialState());
    setNowMs(0);
    setPlaying(false);
    notify("已恢复演示数据");
  }

  return (
    <main className="app">
      {flash && <div className="toast">{flash}</div>}

      <section className="hero">
        <p>hxyfront-62008 · 源提示词 10 · 数据仅存浏览器</p>
        <h1>烟花燃放脚本编排 · 风险例外审批</h1>
        <span>
          自动检测人员密集区、同点位间隔、引信越段三类冲突。人员密集区冲突不得例外；其余冲突可由安全负责人审批风险例外，
          例外在失效时刻前且节点音乐点 / 发射角 / 安全距离未变化时有效，只有有效例外能解除放行阻塞。
        </span>
      </section>

      <section className="metrics">
        <Metric label="点火节点" value={state.nodes.length} tone="blue" />
        <Metric
          label="放行阻塞冲突"
          value={blockedCount}
          tone={blockedCount ? "red" : "green"}
        />
        <Metric label="有效例外放行" value={releasedCount} tone="green" />
        <Metric label="待审批申请" value={pendingCount} tone="amber" />
      </section>

      <Timeline
        state={state}
        nowMs={nowMs}
        playing={playing}
        blocking={blocking}
        onTogglePlay={() => setPlaying((p) => !p)}
        onSeek={setNowMs}
      />

      <section className="workspace two-col">
        <SiteMap state={state} blocking={blocking} />
        <NodeEditor nodes={state.nodes} onPatch={patchNode} />
      </section>

      <ConflictPanel
        state={state}
        blocking={blocking}
        nowMs={nowMs}
        onApply={setDraftConflict}
      />

      <ApprovalPanel evaluated={evaluated} nodes={state.nodes} onReview={review} />

      <ShowPreview state={state} blocking={blocking} onReset={resetAll} />

      {draftConflict && (
        <ExemptionDialog
          conflict={draftConflict}
          state={state}
          nowMs={nowMs}
          onClose={() => setDraftConflict(null)}
          onSubmit={submitExemption}
        />
      )}
    </main>
  );
}

/* ---------------- 指标卡 ---------------- */

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "blue" | "red" | "green" | "amber";
}) {
  return (
    <article className={`metric metric-${tone}`}>
      <small>{label}</small>
      <strong>{value}</strong>
    </article>
  );
}

/* ---------------- 时间轴 ---------------- */

function Timeline({
  state,
  nowMs,
  playing,
  blocking,
  onTogglePlay,
  onSeek,
}: {
  state: ShowState;
  nowMs: number;
  playing: boolean;
  blocking: BlockingResult;
  onTogglePlay: () => void;
  onSeek: (ms: number) => void;
}) {
  const end = state.showEndMs;
  const activeKey = new Set(blocking.activeByKey.keys());
  const blockedKeys = new Set(blocking.blocked.map((c) => c.key));

  return (
    <section className="panel timeline-panel">
      <div className="heading">
        <div>
          <p>时间轴编排</p>
          <h2>整场时间线 · 当前 {formatTime(nowMs)}</h2>
        </div>
        <div className="timeline-controls">
          <button className="primary" onClick={onTogglePlay}>
            {playing ? "暂停" : "播放"}
          </button>
          <button onClick={() => onSeek(0)}>回到开场</button>
          <span className="end-label">整场结束 {formatTime(end)}</span>
        </div>
      </div>

      <div className="timeline-rows">
        {SECTIONS.map((section) => {
          const rows = state.nodes
            .filter((n) => n.section === section)
            .sort((a, b) => (parseTime(a.musicCue) ?? 0) - (parseTime(b.musicCue) ?? 0));
          return (
            <div className="tl-row" key={section}>
              <div className="tl-label">{section}</div>
              <div className="tl-track">
                {rows.map((n) => {
                  const start = parseTime(n.musicCue) ?? 0;
                  const conflictHere = blocking.conflicts.filter(
                    (c) => c.kind !== "crowd" && c.nodeIds.includes(n.id)
                  );
                  const crowdHere = blocking.conflicts.some(
                    (c) => c.kind === "crowd" && c.nodeIds.includes(n.id)
                  );
                  const isReleased = conflictHere.some((c) => activeKey.has(c.key));
                  const isBlocked =
                    crowdHere || conflictHere.some((c) => blockedKeys.has(c.key));
                  const cls = isBlocked
                    ? "tl-item blocked"
                    : isReleased
                      ? "tl-item released"
                      : "tl-item ok";
                  return (
                    <div
                      key={n.id}
                      className={cls}
                      style={{
                        left: `${(start / end) * 100}%`,
                        width: `${Math.max((n.duration / end) * 100, 1.6)}%`,
                      }}
                      title={`${n.pointName} ${n.model} · ${n.musicCue}${
                        isBlocked ? " · 阻塞" : isReleased ? " · 例外放行" : ""
                      }`}
                    >
                      <span>{n.pointName}</span>
                    </div>
                  );
                })}
                <div
                  className="tl-playhead"
                  style={{ left: `${(nowMs / end) * 100}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
      <input
        className="seek"
        type="range"
        min={0}
        max={end}
        step={100}
        value={nowMs}
        onChange={(e) => onSeek(Number(e.target.value))}
        aria-label="时间轴定位"
      />
    </section>
  );
}

/* ---------------- 点位平面图 ---------------- */

const FIELD_W = 100;
const FIELD_H = 60;

function SiteMap({
  state,
  blocking,
}: {
  state: ShowState;
  blocking: BlockingResult;
}) {
  const activeKey = new Set(blocking.activeByKey.keys());
  const blockedKeys = new Set(blocking.blocked.map((c) => c.key));

  const nodeState = (n: FuseNode): "ok" | "released" | "blocked" => {
    const crowd = blocking.conflicts.some(
      (c) => c.kind === "crowd" && c.nodeIds.includes(n.id)
    );
    if (crowd) return "blocked";
    const list = blocking.conflicts.filter((c) => c.nodeIds.includes(n.id));
    if (list.some((c) => blockedKeys.has(c.key))) return "blocked";
    if (list.some((c) => activeKey.has(c.key))) return "released";
    return "ok";
  };

  return (
    <section className="panel sitemap-panel">
      <div className="heading">
        <div>
          <p>燃放点位平面图</p>
          <h2>场地布局（米）</h2>
        </div>
      </div>
      <div className="legend">
        <span><i className="dot ok" />正常</span>
        <span><i className="dot released" />例外放行</span>
        <span><i className="dot blocked" />阻塞</span>
        <span><i className="zone-swatch" />人员密集区</span>
      </div>
      <svg className="sitemap" viewBox={`0 0 ${FIELD_W} ${FIELD_H}`} role="img" aria-label="燃放点位平面图">
        <rect x={0} y={0} width={FIELD_W} height={FIELD_H} className="field-bg" />
        {state.zones.map((z) => (
          <g key={z.id}>
            <circle
              cx={z.x}
              cy={FIELD_H - z.y}
              r={z.radius}
              className="crowd-zone"
            />
            <text x={z.x} y={FIELD_H - z.y} className="zone-label" textAnchor="middle">
              {z.name}
            </text>
          </g>
        ))}
        {state.nodes.map((n) => {
          const st = nodeState(n);
          return (
            <g key={n.id}>
              <circle
                cx={n.x}
                cy={FIELD_H - n.y}
                r={n.safetyDistance}
                className={`safety safety-${st}`}
              />
              <circle cx={n.x} cy={FIELD_H - n.y} r={1.4} className={`pin pin-${st}`} />
              <text x={n.x} y={FIELD_H - n.y - 2.4} className="pin-label" textAnchor="middle">
                {n.pointName}
              </text>
            </g>
          );
        })}
      </svg>
    </section>
  );
}

/* ---------------- 节点编辑 ---------------- */

function NodeEditor({
  nodes,
  onPatch,
}: {
  nodes: FuseNode[];
  onPatch: (id: string, patch: Partial<FuseNode>) => void;
}) {
  return (
    <section className="panel node-panel">
      <div className="heading">
        <div>
          <p>点火节点</p>
          <h2>安全参数调整</h2>
        </div>
      </div>
      <p className="panel-note">
        修改音乐点、发射角或安全距离后，关联节点上的有效例外立即失效并恢复阻塞。
      </p>
      <div className="node-list">
        {nodes
          .slice()
          .sort((a, b) => (parseTime(a.musicCue) ?? 0) - (parseTime(b.musicCue) ?? 0))
          .map((n) => (
            <div className="node-card" key={n.id}>
              <div className="node-card-head">
                <b>{n.pointName}</b>
                <span>{n.section} · {n.model}</span>
              </div>
              <div className="node-card-grid">
                <label>
                  <span>音乐点 mm:ss.SSS</span>
                  <input
                    value={n.musicCue}
                    onChange={(e) => onPatch(n.id, { musicCue: e.target.value })}
                  />
                </label>
                <label>
                  <span>发射角（度）</span>
                  <input
                    type="number"
                    value={n.launchAngle}
                    onChange={(e) =>
                      onPatch(n.id, { launchAngle: Number(e.target.value) })
                    }
                  />
                </label>
                <label>
                  <span>安全距离（米）</span>
                  <input
                    type="number"
                    value={n.safetyDistance}
                    onChange={(e) =>
                      onPatch(n.id, { safetyDistance: Number(e.target.value) })
                    }
                  />
                </label>
              </div>
            </div>
          ))}
      </div>
    </section>
  );
}

/* ---------------- 冲突清单 ---------------- */

function ConflictPanel({
  state,
  blocking,
  nowMs,
  onApply,
}: {
  state: ShowState;
  blocking: BlockingResult;
  nowMs: number;
  onApply: (c: Conflict) => void;
}) {
  const sorted = blocking.conflicts
    .slice()
    .sort((a, b) => {
      const rank = { crowd: 0, interval: 1, fuse: 2 } as const;
      if (rank[a.kind] !== rank[b.kind]) return rank[a.kind] - rank[b.kind];
      return a.key.localeCompare(b.key);
    });

  return (
    <section className="panel conflict-panel">
      <div className="heading">
        <div>
          <p>冲突时间提示</p>
          <h2>冲突清单（{sorted.length}）</h2>
        </div>
      </div>
      {sorted.length === 0 ? (
        <p className="empty-ok">当前编排未检测到冲突，可以放行整场。</p>
      ) : (
        <div className="table-wrap">
          <table className="conflict-table">
            <thead>
              <tr>
                <th>类型</th>
                <th>冲突</th>
                <th>说明</th>
                <th>状态</th>
                <th className="col-action">操作</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((c) => {
                const released = blocking.released.some((r) => r.key === c.key);
                const open = blocking.openByKey.get(c.key);
                return (
                  <tr key={c.key} className={released ? "row-released" : "row-blocked"}>
                    <td>
                      <span className={`kind kind-${c.kind}`}>
                        {CONFLICT_META[c.kind].label}
                      </span>
                    </td>
                    <td>{c.title}</td>
                    <td className="muted">{c.detail}</td>
                    <td>
                      {released ? (
                        <span className="state-tag released">
                          有效例外放行 · 至 {formatTime(blocking.activeByKey.get(c.key)!.expiresAt)}
                        </span>
                      ) : (
                        <span className="state-tag blocked">
                          {c.kind === "crowd" ? "阻塞（不得例外）" : "阻塞"}
                        </span>
                      )}
                    </td>
                    <td>
                      {c.kind === "crowd" ? (
                        <button disabled title={CONFLICT_META.crowd.hint}>
                          禁止例外
                        </button>
                      ) : released ? (
                        <button disabled>已放行</button>
                      ) : open ? (
                        <button disabled>
                          {open.status === "pending" ? "例外待审" : "已有有效例外"}
                        </button>
                      ) : (
                        <button
                          className="primary"
                          onClick={() => onApply(c)}
                          disabled={nowMs > state.showEndMs}
                        >
                          申请例外
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/* ---------------- 例外申请弹窗 ---------------- */

function ExemptionDialog({
  conflict,
  state,
  nowMs,
  onClose,
  onSubmit,
}: {
  conflict: Conflict;
  state: ShowState;
  nowMs: number;
  onClose: () => void;
  onSubmit: (
    c: Conflict,
    approver: string,
    reason: string,
    expiresAtText: string
  ) => SubmitIssue | null;
}) {
  const [approver, setApprover] = useState("");
  const [reason, setReason] = useState("");
  const [expires, setExpires] = useState(formatTime(state.showEndMs));
  const [error, setError] = useState<SubmitIssue | null>(null);

  return (
    <div className="modal-mask" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="heading">
          <div>
            <p>风险例外申请</p>
            <h2>{CONFLICT_META[conflict.kind].label} · {conflict.title}</h2>
          </div>
          <button onClick={onClose} aria-label="关闭">×</button>
        </div>
        <p className="muted">{conflict.detail}</p>
        <div className="form-stack">
          <label>
            <span>安全负责人（必填）</span>
            <input
              value={approver}
              placeholder="填写审批该例外的安全负责人姓名"
              onChange={(e) => setApprover(e.target.value)}
            />
          </label>
          <label>
            <span>风险放行理由（必填）</span>
            <textarea
              rows={3}
              value={reason}
              placeholder="说明现场防护措施与放行依据"
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <label>
            <span>失效时刻（mm:ss.SSS，不得晚于整场结束 {formatTime(state.showEndMs)}）</span>
            <input value={expires} onChange={(e) => setExpires(e.target.value)} />
          </label>
          <p className="muted small">
            提交后进入待审；审批通过且在失效时刻之前为有效。节点音乐点、发射角或安全距离一旦变化，例外立即失效。
            当前时间 {formatTime(nowMs)}。
          </p>
          {error && <p className="form-error">{SUBMIT_ISSUE_TEXT[error]}</p>}
        </div>
        <div className="modal-actions">
          <button onClick={onClose}>取消</button>
          <button
            className="primary"
            onClick={() => setError(onSubmit(conflict, approver, reason, expires))}
          >
            提交审批
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------------- 审批记录 ---------------- */

function ApprovalPanel({
  evaluated,
  nodes,
  onReview,
}: {
  evaluated: ReturnType<typeof evaluateAll>;
  nodes: FuseNode[];
  onReview: (id: string, approve: boolean, note?: string) => void;
}) {
  const [filter, setFilter] = useState<EffectiveStatus | "all">("all");
  const order: EffectiveStatus[] = ["pending", "active", "expired", "rejected"];
  const rows = evaluated
    .filter((e) => filter === "all" || e.effective === filter)
    .sort(
      (a, b) =>
        order.indexOf(a.effective) - order.indexOf(b.effective) ||
        b.exemption.createdAt - a.exemption.createdAt
    );

  return (
    <section className="panel approval-panel">
      <div className="heading">
        <div>
          <p>风险例外审批</p>
          <h2>审批记录（{evaluated.length}）</h2>
        </div>
        <div className="chips">
          {(["all", "pending", "active", "expired", "rejected"] as const).map((s) => (
            <button
              key={s}
              className={filter === s ? "chip-on" : ""}
              onClick={() => setFilter(s)}
            >
              {s === "all" ? "全部" : STATUS_LABEL[s]}
            </button>
          ))}
        </div>
      </div>
      {rows.length === 0 ? (
        <p className="empty-ok">暂无{filter === "all" ? "" : STATUS_LABEL[filter as EffectiveStatus]}记录。</p>
      ) : (
        <div className="approval-list">
          {rows.map(({ exemption: ex, effective, expireReason }) => (
            <article key={ex.id} className={`approval-card status-${effective}`}>
              <div className="approval-top">
                <div>
                  <span className={`kind kind-${ex.kind}`}>
                    {CONFLICT_META[ex.kind].label}
                  </span>
                  <h3>{ex.title}</h3>
                </div>
                <span className={`state-tag ${effective}`}>{STATUS_LABEL[effective]}</span>
              </div>
              <p className="muted">
                申请人 {ex.applicant} · 安全负责人 {ex.approver} · 失效时刻 {formatTime(ex.expiresAt)}
              </p>
              <p className="reason">理由：{ex.reason}</p>
              {effective === "expired" && expireReason && (
                <p className="expire-note">失效原因：{EXPIRE_REASON_TEXT[expireReason]}</p>
              )}
              {effective === "rejected" && ex.rejectNote && (
                <p className="expire-note reject">驳回说明：{ex.rejectNote}</p>
              )}
              <div className="node-sig">
                {ex.nodeIds.map((id) => {
                  const n = nodes.find((x) => x.id === id);
                  const snap = ex.snapshot[id];
                  const drift =
                    n &&
                    snap &&
                    (nodeSignature(n).musicCueMs !== snap.musicCueMs ||
                      nodeSignature(n).launchAngle !== snap.launchAngle ||
                      nodeSignature(n).safetyDistance !== snap.safetyDistance);
                  return (
                    <span key={id} className={drift ? "sig-drift" : ""}>
                      {n ? `${n.pointName} ${n.musicCue} / ${n.launchAngle}° / ${n.safetyDistance}m` : `节点 ${id} 已删除`}
                    </span>
                  );
                })}
              </div>
              {effective === "pending" && (
                <div className="modal-actions">
                  <button onClick={() => onReview(ex.id, false)}>驳回</button>
                  <button className="primary" onClick={() => onReview(ex.id, true)}>
                    审批通过
                  </button>
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

/* ---------------- 整场节目预览 ---------------- */

function ShowPreview({
  state,
  blocking,
  onReset,
}: {
  state: ShowState;
  blocking: BlockingResult;
  onReset: () => void;
}) {
  const released = new Set(blocking.released.map((c) => c.key));
  const blocked = new Set(blocking.blocked.map((c) => c.key));

  return (
    <section className="panel preview-panel">
      <div className="heading">
        <div>
          <p>整场节目预览</p>
          <h2>按节目段落核对放行</h2>
        </div>
        <button onClick={onReset}>恢复演示数据</button>
      </div>
      <div className="preview-grid">
        {SECTIONS.map((section) => {
          const rows = state.nodes
            .filter((n) => n.section === section)
            .sort((a, b) => (parseTime(a.musicCue) ?? 0) - (parseTime(b.musicCue) ?? 0));
          return (
            <div className="preview-col" key={section}>
              <h3>{section}</h3>
              {rows.map((n) => {
                const cs = blocking.conflicts.filter((c) => c.nodeIds.includes(n.id));
                const st = cs.some((c) => blocked.has(c.key))
                  ? "blocked"
                  : cs.some((c) => released.has(c.key))
                    ? "released"
                    : "ok";
                return (
                  <div key={n.id} className={`preview-row ${st}`}>
                    <b>{n.musicCue}</b>
                    <span>
                      {n.pointName} · {n.model} · {n.launchAngle}° · 安全 {n.safetyDistance}m
                    </span>
                    <em>
                      {st === "blocked" ? "阻塞" : st === "released" ? "例外放行" : "正常"}
                    </em>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
      <p className="panel-note">
        放行结论：{blocking.blocked.length === 0
          ? "无阻塞，整场可按脚本执行。"
          : `${blocking.blocked.length} 项冲突仍在阻塞（人员密集区不得例外），需先整改或完成审批。`}
      </p>
    </section>
  );
}
