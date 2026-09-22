import { useEffect, useMemo, useRef, useState } from "react";
import "./styles.css";
import {
  CROWD_ZONES,
  FireNode,
  POSITIONS,
  RiskException,
  SEGMENTS,
  SHOW_END,
  ShowState,
  fmtTime,
  genId,
  loadState,
  parseTime,
  resetState,
  saveState,
} from "./model";
import {
  CONFLICT_LABEL,
  ConflictView,
  STATUS_LABEL,
  SubmitError,
  SUBMIT_ERROR_TEXT,
  approveException,
  buildConflictViews,
  displayStatus,
  findBlockingSubmission,
  fingerprintFor,
  invalidReasonText,
  reconcileExceptions,
  rejectException,
  releaseBlocked,
  validateSubmission,
} from "./rules";

const KIND_BADGE: Record<string, string> = {
  crowd: "badge badge-crowd",
  interval: "badge badge-interval",
  overrun: "badge badge-overrun",
};

const KIND_LABEL = CONFLICT_LABEL;

function usePersistentState(): [ShowState, React.Dispatch<React.SetStateAction<ShowState>>] {
  const [state, setState] = useState<ShowState>(loadState);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    saveState(state);
  }, [state]);
  return [state, setState];
}

/** 节点编辑后：立即对指纹失配的待审/有效例外做失效处理并持久化 */
function commitNodes(prev: ShowState, nodes: FireNode[]): ShowState {
  const candidate: ShowState = { ...prev, nodes };
  const exceptions = reconcileExceptions(candidate);
  return { nodes, exceptions };
}

function App() {
  const [state, setState] = usePersistentState();
  const [now, setNow] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [openForm, setOpenForm] = useState<string | null>(null);
  const [approver, setApprover] = useState("");
  const [recordFilter, setRecordFilter] = useState<"all" | RiskException["status"]>("all");

  const views = useMemo(() => buildConflictViews(state, now), [state, now]);
  const blocked = useMemo(() => releaseBlocked(state, now), [state, now]);
  const blockingCount = views.filter((v) => v.blocking).length;
  const activeCount = state.exceptions.filter(
    (ex) => displayStatus(ex, now) === "approved"
  ).length;

  const nodeConflict = useMemo(() => {
    const map = new Map<string, ConflictView>();
    for (const v of views) for (const id of v.nodeIds) if (!map.has(id)) map.set(id, v);
    return map;
  }, [views]);

  // 模拟时钟：驱动时间轴与超时失效
  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => {
      setNow((t) => {
        if (t >= SHOW_END) {
          setPlaying(false);
          return SHOW_END;
        }
        return Math.min(SHOW_END, t + 200);
      });
    }, 200);
    return () => window.clearInterval(timer);
  }, [playing]);

  const updateNode = (id: string, patch: Partial<FireNode>) => {
    setState((prev) => commitNodes(prev, prev.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n))));
  };

  const deleteNode = (id: string) => {
    const touchedConflict = views.some((v) => v.nodeIds.includes(id));
    setState((prev) => commitNodes(prev, prev.nodes.filter((n) => n.id !== id)));
    if (touchedConflict) setOpenForm(null);
  };

  const addNode = (node: FireNode) => {
    setState((prev) => commitNodes(prev, [...prev.nodes, node]));
  };

  const submitException = (
    view: ConflictView,
    owner: string,
    reason: string,
    expireText: string
  ): SubmitError | null => {
    const expireAt = parseTime(expireText);
    if (expireAt === null) return "MISSING_FIELDS";
    const error = validateSubmission(
      {
        conflictId: view.id,
        kind: view.kind,
        nodeIds: view.nodeIds,
        safetyOwner: owner,
        reason,
        expireAt,
      },
      state,
      now
    );
    if (error) return error;
    const record: RiskException = {
      id: genId("ex"),
      conflictId: view.id,
      kind: view.kind,
      nodeIds: view.nodeIds,
      fingerprint: fingerprintFor(view.nodeIds, state.nodes),
      safetyOwner: owner.trim(),
      reason: reason.trim(),
      expireAt,
      status: "pending",
      createdAt: Date.now(),
    };
    setState((prev) => ({ ...prev, exceptions: [...prev.exceptions, record] }));
    setOpenForm(null);
    return null;
  };

  const decide = (ex: RiskException, approve: boolean, note: string) => {
    setState((prev) => ({
      ...prev,
      exceptions: prev.exceptions.map((e) => {
        if (e.id !== ex.id) return e;
        // 审批时再次校验指纹：若审批期间节点已被改动，直接落为失效
        if (approve && fingerprintFor(e.nodeIds, prev.nodes) !== e.fingerprint) {
          return { ...e, status: "invalid", invalidReason: "modified" as const, decidedAt: Date.now() };
        }
        return approve
          ? approveException(e, prev.nodes, approver, Date.now())
          : rejectException(e, approver, note, Date.now());
      }),
    }));
  };

  const doReset = () => {
    if (!window.confirm("确定恢复种子数据并清空全部审批记录？")) return;
    setState(resetState());
    setNow(0);
    setPlaying(false);
    setOpenForm(null);
  };

  return (
    <main className="app">
      <header className="topbar panel">
        <div>
          <p className="eyebrow">hxyfront-62008 · 烟花燃放脚本编排</p>
          <h1>燃放风险例外审批台</h1>
          <span className="sub">冲突分三类：人员密集区（不可例外）、同点位间隔、引信越段；数据仅存于本浏览器。</span>
        </div>
        <div className="topbar-actions">
          <button className="ghost" onClick={doReset}>恢复种子数据</button>
        </div>
      </header>

      <section className={`gate ${blocked ? "gate-blocked" : "gate-open"}`}>
        <div>
          <strong>{blocked ? "⛔ 放行阻塞中" : "✅ 允许放行"}</strong>
          <p>
            {blocked
              ? `仍有 ${blockingCount} 项冲突未解除；只有「有效」例外可以解除阻塞，人员密集区冲突必须改点。`
              : "全部冲突均已由有效例外覆盖或已消除，可以按模拟时钟执行燃放。"}
          </p>
        </div>
        <div className="clock">
          <button className="ghost" onClick={() => setPlaying((p) => !p)}>
            {playing ? "暂停" : "播放"}
          </button>
          <button className="ghost" onClick={() => { setPlaying(false); setNow(0); }}>归零</button>
          <span className="clock-time">{fmtTime(now)}</span>
          <span className="clock-end">/ {fmtTime(SHOW_END)}</span>
        </div>
      </section>
      <input
        className="scrub"
        type="range"
        min={0}
        max={SHOW_END}
        step={100}
        value={now}
        onChange={(e) => { setPlaying(false); setNow(Number(e.target.value)); }}
      />

      <section className="metrics">
        <article><small>节目段落</small><strong>{SEGMENTS.length}</strong></article>
        <article><small>点火节点</small><strong>{state.nodes.length}</strong></article>
        <article className={blockingCount ? "metric-danger" : ""}><small>阻塞冲突</small><strong>{blockingCount}</strong></article>
        <article className="metric-ok"><small>有效例外</small><strong>{activeCount}</strong></article>
      </section>

      <section className="panel">
        <div className="heading"><div><p>时间轴编排</p><h2>段落 · 音乐点 · 点火窗口</h2></div></div>
        <Timeline nodes={state.nodes} now={now} nodeConflict={nodeConflict} onSeek={(t) => { setPlaying(false); setNow(t); }} />
      </section>

      <section className="panel">
        <div className="heading"><div><p>燃放点位平面图</p><h2>点位 · 密集区 · 发射角</h2></div></div>
        <SiteMap nodes={state.nodes} nodeConflict={nodeConflict} />
      </section>

      <div className="two-col">
        <section className="panel">
          <div className="heading">
            <div><p>冲突时间提示</p><h2>冲突清单与例外申请</h2></div>
          </div>
          {views.length === 0 && <p className="empty">当前编排无冲突。</p>}
          <div className="conflict-list">
            {views.map((v) => (
              <ConflictCard
                key={v.id}
                view={v}
                now={now}
                open={openForm === v.id}
                onToggle={() => setOpenForm((f) => (f === v.id ? null : v.id))}
                existing={findBlockingSubmission(v.id, state, now)}
                onSubmit={submitException}
              />
            ))}
          </div>
        </section>

        <section className="panel">
          <div className="heading">
            <div><p>审批记录</p><h2>待审 · 有效 · 失效 · 驳回</h2></div>
            <input
              className="approver"
              placeholder="审批人（安全值班）"
              value={approver}
              onChange={(e) => setApprover(e.target.value)}
            />
          </div>
          <RecordTabs filter={recordFilter} setFilter={setRecordFilter} exceptions={state.exceptions} now={now} />
          <div className="record-list">
            {state.exceptions
              .filter((ex) => recordFilter === "all" || displayStatus(ex, now) === recordFilter)
              .sort((a, b) => b.createdAt - a.createdAt)
              .map((ex) => (
                <RecordRow
                  key={ex.id}
                  ex={ex}
                  now={now}
                  onApprove={() => decide(ex, true, "")}
                  onReject={() => {
                    const note = window.prompt("驳回说明（将展示给申请人）", "现场条件不满足风险缓解要求");
                    if (note !== null) decide(ex, false, note);
                  }}
                />
              ))}
            {state.exceptions.length === 0 && <p className="empty">尚无例外申请。</p>}
          </div>
        </section>
      </div>

      <section className="panel">
        <div className="heading"><div><p>专业字段</p><h2>点火节点编排</h2></div></div>
        <NodeTable nodes={state.nodes} onUpdate={updateNode} onDelete={deleteNode} />
        <AddNodeForm onAdd={addNode} />
      </section>

      <footer className="footnote">
        修改节点音乐点、发射角或安全距离后，与之绑定的待审/有效例外立即失效并恢复阻塞；全部数据仅保存在浏览器 localStorage。
      </footer>
    </main>
  );
}

// ---------- 时间轴 ----------

function Timeline(props: {
  nodes: FireNode[];
  now: number;
  nodeConflict: Map<string, ConflictView>;
  onSeek: (t: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const pct = (t: number) => `${(t / SHOW_END) * 100}%`;
  const onTrackClick = (e: React.MouseEvent) => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    props.onSeek(Math.round(((e.clientX - rect.left) / rect.width) * SHOW_END));
  };
  const sorted = [...props.nodes].sort((a, b) => a.time - b.time);
  return (
    <div className="timeline">
      <div className="tl-segments">
        {SEGMENTS.map((s) => (
          <div
            key={s.id}
            className="tl-seg"
            style={{ left: pct(s.start), width: `${((s.end - s.start) / SHOW_END) * 100}%`, background: s.color }}
            title={`${s.name} ${fmtTime(s.start)}–${fmtTime(s.end)}`}
          >
            <span>{s.name}</span>
          </div>
        ))}
      </div>
      <div className="tl-track" ref={ref} onClick={onTrackClick}>
        {sorted.map((n) => {
          const v = props.nodeConflict.get(n.id);
          const cls = v ? (v.blocking ? "tick tick-block" : "tick tick-except") : "tick";
          return (
            <button
              key={n.id}
              className={cls}
              style={{ left: pct(n.time) }}
              title={`${n.name} · ${fmtTime(n.time)}${v ? ` · ${KIND_LABEL[v.kind]}${v.blocking ? "（阻塞）" : "（例外放行）"}` : ""}`}
              onClick={(e) => { e.stopPropagation(); props.onSeek(n.time); }}
            />
          );
        })}
        <div className="tl-playhead" style={{ left: pct(props.now) }} />
      </div>
    </div>
  );
}

// ---------- 点位图 ----------

function SiteMap(props: { nodes: FireNode[]; nodeConflict: Map<string, ConflictView> }) {
  return (
    <div className="sitemap-wrap">
      <svg viewBox="0 0 100 100" className="sitemap" role="img" aria-label="燃放点位平面图">
        {CROWD_ZONES.map((z) => (
          <g key={z.id}>
            <circle cx={z.x} cy={z.y} r={z.r} className="crowd-zone" />
            <text x={z.x} y={z.y + 1} textAnchor="middle" className="crowd-label">{z.name}</text>
          </g>
        ))}
        {POSITIONS.map((p) => (
          <g key={p.id}>
            <rect x={p.x - 3} y={p.y - 3} width={6} height={6} className="pos-rect" />
            <text x={p.x} y={p.y - 5} textAnchor="middle" className="pos-label">{p.name}</text>
          </g>
        ))}
        {props.nodes.map((n) => {
          const p = POSITIONS.find((x) => x.id === n.positionId);
          if (!p) return null;
          const v = props.nodeConflict.get(n.id);
          const cls = v ? (v.blocking ? "fire-dot fire-block" : "fire-dot fire-except") : "fire-dot";
          const rad = (n.angle * Math.PI) / 180;
          const dx = 5 * Math.cos(rad);
          const dy = -5 * Math.sin(rad);
          return (
            <g key={n.id}>
              <circle cx={p.x} cy={p.y} r={1.4} className={cls}>
                <title>{`${n.name} · 发射角${n.angle}° · 安全距离${n.safetyDistance}m${v ? ` · ${KIND_LABEL[v.kind]}${v.blocking ? "（阻塞）" : "（例外放行）"}` : ""}`}</title>
              </circle>
              <line x1={p.x} y1={p.y} x2={p.x + dx} y2={p.y + dy} className="angle-arrow" />
            </g>
          );
        })}
      </svg>
      <div className="legend">
        <span><i className="lg lg-normal" />正常</span>
        <span><i className="lg lg-except" />例外放行</span>
        <span><i className="lg lg-block" />阻塞</span>
        <span><i className="lg lg-zone" />人员密集区</span>
      </div>
    </div>
  );
}

// ---------- 冲突卡片 + 申请表单 ----------

function ConflictCard(props: {
  view: ConflictView;
  now: number;
  open: boolean;
  onToggle: () => void;
  existing?: RiskException;
  onSubmit: (v: ConflictView, owner: string, reason: string, expireText: string) => SubmitError | null;
}) {
  const { view } = props;
  const [owner, setOwner] = useState("");
  const [reason, setReason] = useState("");
  const [expireText, setExpireText] = useState(fmtTime(SHOW_END));
  const [error, setError] = useState<SubmitError | null>(null);

  const ex = view.activeException;
  return (
    <article className={`conflict ${view.blocking ? "is-blocking" : "is-except"}`}>
      <div className="conflict-head">
        <span className={KIND_BADGE[view.kind]}>{KIND_LABEL[view.kind]}</span>
        <strong>{view.title}</strong>
        <span className={`state-pill ${view.blocking ? "pill-block" : "pill-ok"}`}>
          {view.blocking ? "阻塞" : "例外放行"}
        </span>
      </div>
      <p className="conflict-detail">{view.detail}</p>
      {ex && (
        <p className="conflict-ex">
          有效例外：{ex.safetyOwner} 批准 · 失效时刻 {fmtTime(ex.expireAt)} · {ex.reason}
        </p>
      )}

      {!view.exceptionAllowed ? (
        <p className="no-exception">人员密集区风险不得申请例外，请调整点位或取消该节点。</p>
      ) : view.blocking ? (
        <>
          {props.existing && (
            <p className="dup-hint">
              已有{STATUS_LABEL[displayStatus(props.existing, props.now)]}例外
              {props.existing.status === "pending" ? "在审，不能重复提交" : "生效中，不能重复提交"}
            </p>
          )}
          <button className="ghost small" onClick={props.onToggle} disabled={Boolean(props.existing)}>
            {props.open ? "收起申请" : "申请风险例外"}
          </button>
          {props.open && !props.existing && (
            <form
              className="ex-form"
              onSubmit={(e) => {
                e.preventDefault();
                setError(props.onSubmit(view, owner, reason, expireText));
              }}
            >
              <label>
                <span>安全负责人 *</span>
                <input value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="如：周安全" />
              </label>
              <label>
                <span>例外理由 *</span>
                <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="风险缓解措施与现场条件" />
              </label>
              <label>
                <span>失效时刻 *（不晚于 {fmtTime(SHOW_END)}）</span>
                <input value={expireText} onChange={(e) => setExpireText(e.target.value)} placeholder="mm:ss.fff" />
              </label>
              {error && <p className="form-error">{SUBMIT_ERROR_TEXT[error]}</p>}
              <button className="primary small" type="submit">提交审批</button>
            </form>
          )}
        </>
      ) : null}
    </article>
  );
}

// ---------- 审批记录 ----------

function RecordTabs(props: {
  filter: "all" | RiskException["status"];
  setFilter: (f: "all" | RiskException["status"]) => void;
  exceptions: RiskException[];
  now: number;
}) {
  const tabs: Array<["all" | RiskException["status"], string]> = [
    ["all", "全部"],
    ["pending", "待审"],
    ["approved", "有效"],
    ["invalid", "失效"],
    ["rejected", "驳回"],
  ];
  return (
    <div className="tabs">
      {tabs.map(([key, label]) => {
        const count = key === "all"
          ? props.exceptions.length
          : props.exceptions.filter((e) => displayStatus(e, props.now) === key).length;
        return (
          <button
            key={key}
            className={`tab ${props.filter === key ? "tab-on" : ""}`}
            onClick={() => props.setFilter(key)}
          >
            {label} {count}
          </button>
        );
      })}
    </div>
  );
}

function RecordRow(props: {
  ex: RiskException;
  now: number;
  onApprove: () => void;
  onReject: () => void;
}) {
  const { ex } = props;
  const status = displayStatus(ex, props.now);
  const reason = invalidReasonText(ex, props.now);
  return (
    <article className={`record status-${status}`}>
      <div className="record-head">
        <span className={KIND_BADGE[ex.kind]}>{KIND_LABEL[ex.kind]}</span>
        <span className={`state-pill pill-${status}`}>{STATUS_LABEL[status]}</span>
        <time>{new Date(ex.createdAt).toLocaleString("zh-CN", { hour12: false })}</time>
      </div>
      <p className="record-line"><b>安全负责人：</b>{ex.safetyOwner}　<b>失效时刻：</b>{fmtTime(ex.expireAt)}</p>
      <p className="record-line"><b>理由：</b>{ex.reason}</p>
      {reason && <p className="record-invalid">{reason}</p>}
      {ex.status === "rejected" && <p className="record-reject"><b>驳回：</b>{ex.decider} — {ex.rejectNote}</p>}
      {ex.status === "approved" && ex.decider && (
        <p className="record-line dim">批准人：{ex.decider} · {new Date(ex.decidedAt ?? ex.createdAt).toLocaleString("zh-CN", { hour12: false })}</p>
      )}
      {ex.status === "pending" && (
        <div className="record-actions">
          <button className="primary small" onClick={props.onApprove}>批准有效</button>
          <button className="danger small" onClick={props.onReject}>驳回</button>
        </div>
      )}
    </article>
  );
}

// ---------- 节点表 ----------

function NodeTable(props: {
  nodes: FireNode[];
  onUpdate: (id: string, patch: Partial<FireNode>) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="table-scroll">
      <table className="node-table">
        <thead>
          <tr>
            <th>节点</th><th>段落</th><th>点位</th><th>型号</th><th>口径</th>
            <th>发射角</th><th>音乐点</th><th>时长(s)</th><th>安全距离(m)</th><th></th>
          </tr>
        </thead>
        <tbody>
          {[...props.nodes].sort((a, b) => a.time - b.time).map((n) => (
            <tr key={n.id}>
              <td><input value={n.name} onChange={(e) => props.onUpdate(n.id, { name: e.target.value })} /></td>
              <td>
                <select value={n.segmentId} onChange={(e) => props.onUpdate(n.id, { segmentId: e.target.value })}>
                  {SEGMENTS.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </td>
              <td>
                <select value={n.positionId} onChange={(e) => props.onUpdate(n.id, { positionId: e.target.value })}>
                  {POSITIONS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </td>
              <td><input className="thin" value={n.model} onChange={(e) => props.onUpdate(n.id, { model: e.target.value })} /></td>
              <td><input className="thin num" type="number" value={n.caliber} onChange={(e) => props.onUpdate(n.id, { caliber: Number(e.target.value) })} /></td>
              <td><input className="thin num" type="number" value={n.angle} onChange={(e) => props.onUpdate(n.id, { angle: Number(e.target.value) })} /></td>
              <td>
                <TimeField value={n.time} onCommit={(t) => props.onUpdate(n.id, { time: t })} />
              </td>
              <td><input className="thin num" type="number" step={0.1} value={n.duration / 1000} onChange={(e) => props.onUpdate(n.id, { duration: Math.round(Number(e.target.value) * 1000) })} /></td>
              <td><input className="thin num" type="number" value={n.safetyDistance} onChange={(e) => props.onUpdate(n.id, { safetyDistance: Number(e.target.value) })} /></td>
              <td><button className="ghost small" onClick={() => props.onDelete(n.id)}>删</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TimeField(props: { value: number; onCommit: (t: number) => void }) {
  const [text, setText] = useState(fmtTime(props.value));
  const [bad, setBad] = useState(false);
  useEffect(() => { setText(fmtTime(props.value)); setBad(false); }, [props.value]);
  return (
    <input
      className={`thin ${bad ? "bad-input" : ""}`}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        const t = parseTime(text);
        if (t === null) { setBad(true); setText(fmtTime(props.value)); }
        else props.onCommit(t);
      }}
    />
  );
}

function AddNodeForm(props: { onAdd: (n: FireNode) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("新节点");
  const [segmentId, setSegmentId] = useState(SEGMENTS[0].id);
  const [positionId, setPositionId] = useState(POSITIONS[0].id);
  const [timeText, setTimeText] = useState("00:00.000");
  if (!open) return <button className="ghost" onClick={() => setOpen(true)}>+ 新增点火节点</button>;
  return (
    <form
      className="add-form"
      onSubmit={(e) => {
        e.preventDefault();
        const t = parseTime(timeText);
        if (t === null) return;
        props.onAdd({
          id: genId("n"),
          name: name.trim() || "未命名节点",
          segmentId,
          positionId,
          model: "冷焰火",
          caliber: 12,
          angle: 90,
          time: t,
          duration: 3000,
          safetyDistance: 20,
        });
        setOpen(false);
      }}
    >
      <input placeholder="节点名称" value={name} onChange={(e) => setName(e.target.value)} />
      <select value={segmentId} onChange={(e) => setSegmentId(e.target.value)}>
        {SEGMENTS.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
      <select value={positionId} onChange={(e) => setPositionId(e.target.value)}>
        {POSITIONS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <input placeholder="音乐点 mm:ss.fff" value={timeText} onChange={(e) => setTimeText(e.target.value)} />
      <button className="primary small" type="submit">添加</button>
      <button className="ghost small" type="button" onClick={() => setOpen(false)}>取消</button>
    </form>
  );
}

export default App;
