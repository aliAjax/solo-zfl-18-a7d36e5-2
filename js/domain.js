// 领域核心：分桌求解、出席/替换、积分与破同分、导入校验
import { uid, mean } from "./util.js";

export const ROUND_STATUS = { DRAFT: "draft", PUBLISHED: "published", SETTLED: "settled" };

// ---------- 基础查询 ----------

export function seasonParticipants(state, season) {
  const ids = season.participantIds && season.participantIds.length ? season.participantIds : state.players.map((p) => p.id);
  return ids.map((id) => state.players.find((p) => p.id === id)).filter(Boolean);
}

export function roundSeats(state, roundId) {
  return state.seats.filter((s) => s.roundId === roundId).sort((a, b) => a.tableNo - b.tableNo || a.seatNo - b.seatNo);
}

export function seasonRounds(state, seasonId) {
  return state.rounds
    .filter((r) => r.seasonId === seasonId)
    .sort((a, b) => a.no - b.no || a.createdAt.localeCompare(b.createdAt));
}

export function activeSeats(seats) {
  return seats.filter((s) => s.attendance !== "absent");
}

function playerMap(state) {
  return new Map(state.players.map((p) => [p.id, p]));
}

// ---------- 出席与替换的“有效参赛者” ----------
// effective: { playerId, originalId, attendance }
// absent 不入场；late 视为暂未到场（不入座），到场后改 present 重排；
// substitution: out 被 in 替换，座位保留 originalId 记录。
export function effectiveEntries(state, season, round) {
  const overrides = round.attendance || {};
  const subs = round.substitutions || [];
  const outSet = new Map(subs.map((s) => [s.outPlayerId, s]));
  const entries = [];
  for (const p of seasonParticipants(state, season)) {
    const att = overrides[p.id] || "present";
    const sub = outSet.get(p.id);
    if (sub) {
      const subPlayer = state.players.find((x) => x.id === sub.inPlayerId);
      if (subPlayer) {
        entries.push({ playerId: sub.inPlayerId, originalId: p.id, attendance: "substitute" });
      }
      continue;
    }
    if (att === "absent" || att === "late") continue;
    entries.push({ playerId: p.id, originalId: null, attendance: att });
  }
  return entries;
}

// ---------- 历史同桌记录 ----------
export function priorPairMatrix(state, seasonId, excludeRoundId) {
  const pairs = new Set();
  for (const r of seasonRounds(state, seasonId)) {
    if (r.id === excludeRoundId || r.status === ROUND_STATUS.DRAFT) continue;
    const byTable = new Map();
    for (const s of roundSeats(state, r.id)) {
      if (s.attendance === "absent") continue;
      if (!byTable.has(s.tableNo)) byTable.set(s.tableNo, []);
      byTable.get(s.tableNo).push(s.playerId);
    }
    for (const members of byTable.values()) {
      for (let i = 0; i < members.length; i++)
        for (let j = i + 1; j < members.length; j++) {
          pairs.add(pairKey(members[i], members[j]));
        }
    }
  }
  return pairs;
}

function pairKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

// ---------- 桌容量规划 ----------
export function planSizes(total, minSize, maxSize, lockedCounts = {}) {
  if (total <= 0) return { error: "没有可入座的玩家" };
  if (minSize > maxSize) return { error: "桌人数下限大于上限" };
  const lockedTables = Object.keys(lockedCounts).map(Number);
  const minTables = lockedTables.length ? Math.max(...lockedTables) + 1 : 1;

  for (let k = Math.max(minTables, Math.ceil(total / maxSize)); k <= total; k++) {
    const base = Math.floor(total / k);
    if (base < minSize) break;
    const extra = total - base * k; // extra 张桌为 base+1
    const sizes = Array.from({ length: k }, (_, i) => base + (i < extra ? 1 : 0));
    const assignment = assignSizesToLocked(sizes, lockedCounts);
    if (assignment) return { sizes: assignment };
  }
  return {
    error:
      minTables > Math.ceil(total / maxSize)
        ? `锁座占用 ${minTables} 桌，但 ${total} 人无法在 ${minSize}-${maxSize} 人/桌内均衡`
        : `${total} 人无法分成每桌 ${minSize}-${maxSize} 人且桌差不超过 1`
  };
}

// 把容量（已降序）贪心分给锁人最多的锁定桌，再填回普通桌。lockedCounts 是以桌号为键的对象
function assignSizesToLocked(sizes, lockedCounts) {
  const lockedTables = Object.keys(lockedCounts).map(Number);
  if (!lockedTables.length) return sizes;
  const caps = [...sizes].sort((a, b) => b - a);
  const ordered = lockedTables.sort((a, b) => lockedCounts[b] - lockedCounts[a]);
  const final = new Array(sizes.length);
  const taken = new Set();
  for (const t of ordered) {
    const idx = caps.findIndex((cap, i) => !taken.has(i) && cap >= lockedCounts[t]);
    if (idx < 0) return null;
    taken.add(idx);
    final[t] = caps[idx];
  }
  const restCaps = caps.filter((_, i) => !taken.has(i));
  let ri = 0;
  for (let t = 0; t < final.length; t++) {
    if (final[t] === undefined) final[t] = restCaps[ri++];
  }
  return final;
}

// ---------- 分桌主算法（回溯 + MRV，硬约束阻断） ----------
export function seatRound(state, season, round) {
  const entries = effectiveEntries(state, season, round);
  const pmap = playerMap(state);
  const P = entries.length;
  const priorPairs = priorPairMatrix(state, season.id, round.id);

  const existing = roundSeats(state, round.id);
  const entryByPlayer = new Map(entries.map((e) => [e.playerId, e]));

  // 锁座：player 仍在有效名单中才保留；替换场景锁的是原报名人位置 => 锁随原始人
  const locks = []; // {tableNo, seatNo, entry}
  const lockedCounts = {};
  for (const s of existing) {
    if (!s.locked) continue;
    const entry = entryByPlayer.get(s.playerId) || entries.find((e) => e.originalId === s.playerId);
    if (!entry) continue;
    locks.push({ tableNo: s.tableNo, seatNo: s.seatNo, entry, oldSeat: s });
    lockedCounts[s.tableNo] = (lockedCounts[s.tableNo] || 0) + 1;
  }

  const plan = planSizes(P, season.minSize, season.maxSize, lockedCounts);
  if (plan.error) return { error: plan.error, code: "SIZE" };
  const sizes = plan.sizes;
  const tableCount = sizes.length;

  const tables = Array.from({ length: tableCount }, (_, t) => ({
    no: t,
    cap: sizes[t],
    members: [],
    factions: new Set(),
    skills: []
  }));
  for (const lk of locks) {
    const t = tables[lk.tableNo];
    const p = pmap.get(lk.entry.playerId);
    t.members.push(lk.entry);
    if (p?.factionId) t.factions.add(p.factionId);
    t.skills.push(p?.skill || 3);
  }

  const lockedPlayerIds = new Set(locks.map((l) => l.entry.playerId));
  const free = entries.filter((e) => !lockedPlayerIds.has(e.playerId));

  const NODE_BUDGET = 300000;
  const SOLUTION_CAP = 30;
  let nodes = 0;
  const pool = []; // { members: Entry[][], cost }
  const seenSolutions = new Set();

  function feasibleTables(entry) {
    return feasibleTablesIn(tables, entry, priorPairs, pmap);
  }

  function costOf(tablesArr) {
    // 熟练度均衡：各桌平均熟练度方差 + 桌内方差，越小越好
    let between = 0;
    let within = 0;
    const avgs = [];
    for (const t of tablesArr) {
      const m = mean(t.skills);
      avgs.push(m);
      for (const s of t.skills) within += (s - m) ** 2;
    }
    const grand = mean(avgs);
    for (const a of avgs) between += (a - grand) ** 2 * 2;
    return between + within * 0.25;
  }

  function dfs(depth) {
    if (++nodes > NODE_BUDGET || pool.length >= SOLUTION_CAP) return;
    if (depth === free.length) {
      const members = tables.map((t) => t.members.map((e) => e));
      const key = members.map((m) => m.map((e) => e.playerId).sort().join("|")).sort().join("#");
      if (!seenSolutions.has(key)) {
        seenSolutions.add(key);
        pool.push({ members, cost: costOf(tables) });
      }
      return;
    }
    // MRV：当前可选桌最少的玩家优先
    let pick = -1;
    let pickOpts = null;
    for (let i = depth; i < free.length; i++) {
      const opts = feasibleTables(free[i]);
      if (!opts.length) return; // 必死分支
      if (!pickOpts || opts.length < pickOpts.length) {
        pick = i;
        pickOpts = opts;
      }
    }
    [free[depth], free[pick]] = [free[pick], free[depth]];
    const entry = free[depth];
    const p = pmap.get(entry.playerId);
    // 优先放进当前最缺人、技能差异大的桌
    pickOpts.sort((a, b) => {
      const sa = mean([...a.skills, p?.skill || 3]);
      const sb = mean([...b.skills, p?.skill || 3]);
      return sa - sb || b.cap - b.members.length - (a.cap - a.members.length);
    });
    for (const t of pickOpts) {
      t.members.push(entry);
      if (p?.factionId) t.factions.add(p.factionId);
      t.skills.push(p?.skill || 3);
      dfs(depth + 1);
      t.skills.pop();
      if (p?.factionId) t.factions.delete(p.factionId);
      t.members.pop();
    }
    [free[depth], free[pick]] = [free[pick], free[depth]];
  }

  dfs(0);

  if (!pool.length) {
    return { error: diagnoseInfeasible(free, tables, pmap, priorPairs), code: "CONSTRAINT" };
  }

  // 一步前瞻：从多个可行布局里挑“下一轮仍可分桌”的，避免把后续赛程锁死；
  // 缺席/迟到/替换/带锁重排不前瞻（到场名单本来就会再变）。
  pool.sort((a, b) => a.cost - b.cost);
  const shouldLookAhead =
    priorPairs.size === 0 &&
    !locks.length &&
    Object.keys(round.attendance || {}).length === 0 &&
    !(round.substitutions || []).length;
  let selected = pool[0];
  let lookAheadWarning = null;
  if (shouldLookAhead) {
    const future = pool.find((sol) => nextRoundFeasible(sol.members, priorPairs, sizes, pmap, entries));
    if (future) selected = future;
    else lookAheadWarning = "本轮分桌可行，但会使下一轮无桌可排（建议调整名单或接受重复同桌豁免）";
  }

  // 生成 seat 实体；锁座保留原 seatNo，其余按桌内顺序填空位
  const seats = [];
  for (const lk of locks) {
    seats.push({ ...lk.oldSeat, tableNo: lk.tableNo, seatNo: lk.seatNo, playerId: lk.entry.playerId, originalPlayerId: lk.entry.originalId || lk.oldSeat.originalPlayerId || null, attendance: lk.entry.attendance });
  }
  const lockByTable = new Map(locks.map((l) => [l.tableNo + ":" + l.seatNo, l]));
  selected.members.forEach((members, tableNo) => {
    let seatNo = 1;
    for (const entry of members) {
      if (locks.some((l) => l.entry.playerId === entry.playerId)) continue;
      while (lockByTable.has(`${tableNo}:${seatNo}`)) seatNo++;
      seats.push({
        id: uid("seat"),
        roundId: round.id,
        tableNo,
        seatNo,
        playerId: entry.playerId,
        originalPlayerId: entry.originalId || null,
        attendance: entry.attendance,
        locked: false,
        rank: null,
        score: null
      });
      seatNo++;
    }
  });
  const warnings = [];
  if (lookAheadWarning) warnings.push(lookAheadWarning);
  if (nodes > NODE_BUDGET * 0.8) warnings.push("求解接近节点上限，可能不是最优均衡");
  return { seats, sizes, warnings };
}

/** 给定本轮布局，模拟把本轮同桌关系并入历史后，下一轮（同一名单、同容量）是否仍可分桌 */
function nextRoundFeasible(members, priorPairs, sizes, pmap, entries) {
  const futurePairs = new Set(priorPairs);
  for (const m of members) {
    for (let i = 0; i < m.length; i++) {
      for (let j = i + 1; j < m.length; j++) {
        futurePairs.add(pairKey(m[i].playerId, m[j].playerId));
      }
    }
  }
  const nextTables = sizes.map((cap, t) => ({ no: t, cap, members: [], factions: new Set(), skills: [] }));
  const remaining = [...entries];
  let n = 0;
  const BUDGET = 12000;
  function dfs2() {
    if (++n > BUDGET) return false;
    if (!remaining.length) return true;
    // MRV
    let pick = -1;
    let pickOpts = null;
    for (let i = 0; i < remaining.length; i++) {
      const opts = feasibleTablesIn(nextTables, remaining[i], futurePairs, pmap);
      if (!opts.length) return false;
      if (!pickOpts || opts.length < pickOpts.length) {
        pick = i;
        pickOpts = opts;
      }
    }
    const entry = remaining.splice(pick, 1)[0];
    const p = pmap.get(entry.playerId);
    for (const t of pickOpts) {
      t.members.push(entry);
      if (p?.factionId) t.factions.add(p.factionId);
      if (dfs2()) return true;
      if (p?.factionId) t.factions.delete(p.factionId);
      t.members.pop();
    }
    remaining.splice(pick, 0, entry);
    return false;
  }
  return dfs2();
}

function feasibleTablesIn(tablesArr, entry, pairs, pmap) {
  const p = pmap.get(entry.playerId);
  const out = [];
  for (const t of tablesArr) {
    if (t.members.length >= t.cap) continue;
    if (p?.factionId && t.factions.has(p.factionId)) continue;
    let repeat = false;
    for (const m of t.members) {
      if (pairs.has(pairKey(entry.playerId, m.playerId))) {
        repeat = true;
        break;
      }
    }
    if (repeat) continue;
    out.push(t);
  }
  return out;
}

function diagnoseInfeasible(free, tables, pmap, priorPairs) {
  const reasons = [];
  // 阵营人数 > 桌数
  const factionCount = new Map();
  for (const e of free) {
    const f = pmap.get(e.playerId)?.factionId;
    if (f) factionCount.set(f, (factionCount.get(f) || 0) + 1);
  }
  for (const [fid, n] of factionCount) {
    if (n > tables.length) {
      const fname = factionName(fid);
      reasons.push(`阵营「${fname}」有 ${n} 人到场但只有 ${tables.length} 桌（同阵营不可同桌）`);
    }
  }
  // 逐玩家：与所有候选桌成员都曾同桌 / 阵营冲突
  for (const e of free) {
    const p = pmap.get(e.playerId);
    const bad = [];
    for (const t of tables) {
      if (t.members.length >= t.cap) continue;
      if (p?.factionId && t.factions.has(p.factionId)) {
        bad.push(`第${t.no + 1}桌阵营冲突`);
        continue;
      }
      const mates = t.members.filter((m) => priorPairs.has(pairKey(e.playerId, m.playerId)));
      if (mates.length) bad.push(`第${t.no + 1}桌与${mates.map((m) => pmap.get(m.playerId)?.name).join("、")}曾同桌`);
    }
    if (bad.length === tables.length) reasons.push(`「${p?.name}」无处可去：${bad.join("；")}`);
  }
  return reasons.length ? reasons.join("；") : "硬约束无法同时满足（阵营互斥/避免重复同桌/桌容）";
}

function factionName(id) {
  return id; // UI 层会拿到 state，这里仅保底
}

// ---------- 赛果合法性 ----------
export function validateResults(seats, tableCount) {
  const errors = [];
  const byTable = new Map();
  for (const s of seats) {
    if (!byTable.has(s.tableNo)) byTable.set(s.tableNo, []);
    byTable.get(s.tableNo).push(s);
  }
  for (let t = 0; t < tableCount; t++) {
    const list = byTable.get(t) || [];
    for (const s of list) {
      const name = s.playerId;
      if (s.score === null || s.score === undefined || s.score === "") {
        errors.push({ tableNo: t, playerId: s.playerId, msg: `第${t + 1}桌有玩家未填比分` });
        continue;
      }
      if (!Number.isInteger(s.score) || s.score < 0) errors.push({ tableNo: t, playerId: s.playerId, msg: `第${t + 1}桌比分非法（需非负整数）` });
      if (!Number.isInteger(s.rank) || s.rank < 1) errors.push({ tableNo: t, playerId: s.playerId, msg: `第${t + 1}桌名次非法（需 ≥1 的整数，并列允许）` });
    }
    const ranks = list.map((s) => s.rank).filter((r) => Number.isInteger(r)).sort((a, b) => a - b);
    if (ranks.length === list.length && ranks.length) {
      if (ranks[0] !== 1) errors.push({ tableNo: t, msg: `第${t + 1}桌名次必须从 1 开始` });
      let seen = 0;
      for (let i = 0; i < ranks.length; i++) {
        if (i > 0 && ranks[i] > seen + 1) {
          errors.push({ tableNo: t, msg: `第${t + 1}桌名次 ${ranks[i]} 出现断档（并列后应顺延）` });
          break;
        }
        seen++;
        if (i === ranks.length - 1 || ranks[i + 1] !== ranks[i]) {
          // 该名次组结束，seen 已推进
        }
      }
    }
  }
  return errors;
}

// ---------- 单桌名次给分 ----------
export function resultPointsForTable(seatsAtTable, season) {
  const winners = seatsAtTable.filter((s) => s.rank === 1);
  const out = new Map();
  for (const s of seatsAtTable) {
    if (s.rank === 1) out.set(s.playerId, winners.length > 1 ? season.pointsDraw : season.pointsWin);
    else out.set(s.playerId, 0);
  }
  return out;
}

// ---------- 赛季积分榜（派生数据，每次全量重算） ----------
export function computeStandings(state, seasonId) {
  const season = state.seasons.find((s) => s.id === seasonId);
  if (!season) return [];
  const pmap = playerMap(state);
  const rounds = seasonRounds(state, seasonId).filter((r) => r.status === ROUND_STATUS.SETTLED);
  const penaltyByRound = new Map();
  for (const p of state.penalties.filter((x) => rounds.some((r) => r.id === x.roundId))) {
    if (!penaltyByRound.has(p.roundId)) penaltyByRound.set(p.roundId, new Map());
    const m = penaltyByRound.get(p.roundId);
    m.set(p.playerId, (m.get(p.playerId) || 0) + (p.points || 0));
  }

  const rows = new Map();
  const row = (pid) => {
    if (!rows.has(pid)) {
      rows.set(pid, {
        playerId: pid,
        name: pmap.get(pid)?.name || "（已删除玩家）",
        factionId: pmap.get(pid)?.factionId || "",
        appearances: 0,
        wins: 0,
        resultPoints: 0,
        score: 0,
        penalties: 0,
        h2hGross: new Map(), // 对每个同桌对手累计当轮自己的名次分
        opponentIds: []
      });
    }
    return rows.get(pid);
  };

  for (const r of rounds) {
    const seats = roundSeats(state, r.id).filter((s) => s.attendance !== "absent");
    const byTable = new Map();
    for (const s of seats) {
      if (!byTable.has(s.tableNo)) byTable.set(s.tableNo, []);
      byTable.get(s.tableNo).push(s);
    }
    const tablePoints = new Map();
    for (const list of byTable.values()) {
      for (const [pid, pts] of resultPointsForTable(list, season)) tablePoints.set(`${r.id}:${pid}`, pts);
    }
    for (const list of byTable.values()) {
      const pids = list.map((s) => s.playerId);
      for (const s of list) {
        const rr = row(s.playerId);
        const pts = tablePoints.get(`${r.id}:${s.playerId}`) || 0;
        rr.appearances++;
        rr.resultPoints += pts;
        rr.score += s.score || 0;
        if (s.rank === 1 && list.filter((x) => x.rank === 1).length === 1) rr.wins++;
        rr.penalties += penaltyByRound.get(r.id)?.get(s.playerId) || 0;
        for (const other of pids) {
          if (other === s.playerId) continue;
          rr.h2hGross.set(other, (rr.h2hGross.get(other) || 0) + pts);
          rr.opponentIds.push({ roundId: r.id, playerId: other });
        }
      }
    }
  }

  const totals = new Map([...rows.values()].map((r) => [r.playerId, r.resultPoints - r.penalties]));

  const finalRows = [...rows.values()].map((r) => ({
    playerId: r.playerId,
    name: r.name,
    factionId: r.factionId,
    appearances: r.appearances,
    wins: r.wins,
    resultPoints: r.resultPoints,
    penalties: r.penalties,
    total: r.resultPoints - r.penalties,
    score: r.score,
    buchholz: r.opponentIds.reduce((sum, o) => sum + (totals.get(o.playerId) || 0), 0),
    _h2hGross: r.h2hGross
  }));

  // 破同分：总积分 → 相互战绩（并列组内净名次分）→ 对手分 → 游戏总分 → 少处罚 → 姓名
  finalRows.sort((a, b) => b.total - a.total || b.buchholz - a.buchholz || b.score - a.score || a.penalties - b.penalties || a.name.localeCompare(b.name, "zh-CN"));
  // 相互战绩需要在并列组内重排：稳定地逐组插入比较
  const byTotal = new Map();
  for (const r of finalRows) {
    if (!byTotal.has(r.total)) byTotal.set(r.total, []);
    byTotal.get(r.total).push(r);
  }
  const out = [];
  for (const group of byTotal.values()) {
    if (group.length === 1) {
      out.push(group[0]);
      continue;
    }
    group.sort((a, b) => {
      const aNet = (a._h2hGross.get(b.playerId) || 0);
      const bNet = (b._h2hGross.get(a.playerId) || 0);
      const both = (a._h2hGross.has(b.playerId) ? 1 : 0) + (b._h2hGross.has(a.playerId) ? 1 : 0);
      if (both && aNet !== bNet) return bNet - aNet;
      return b.buchholz - a.buchholz || b.score - a.score || a.penalties - b.penalties || a.name.localeCompare(b.name, "zh-CN");
    });
    out.push(...group);
  }
  out.forEach((r, i) => {
    r.rank = i + 1;
    delete r._h2hGross;
  });
  return out;
}

// ---------- 补赛引用环检测 ----------
export function findRoundCycle(rounds) {
  const next = new Map();
  for (const r of rounds) if (r.derivedFromRoundId) next.set(r.id, r.derivedFromRoundId);
  for (const start of next.keys()) {
    const seen = new Set();
    let cur = start;
    const path = [];
    while (cur) {
      if (seen.has(cur)) return [...path.slice(path.indexOf(cur)), cur];
      seen.add(cur);
      path.push(cur);
      cur = next.get(cur);
    }
  }
  return null;
}

// ---------- 导入校验 ----------
export function validateImport(doc) {
  const errors = [];
  const warnings = [];
  const fail = (code, msg) => errors.push({ code, msg });

  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return { errors: [{ code: "SCHEMA", msg: "文件不是 JSON 对象" }], warnings };
  if (doc.schema !== "league-console/v1") fail("SCHEMA", "schema 标识不是 league-console/v1");
  for (const key of ["seasons", "players", "factions", "rounds", "seats", "penalties"]) {
    if (!Array.isArray(doc[key])) fail("SCHEMA", `字段 ${key} 缺失或不是数组`);
  }
  if (errors.length) return { errors, warnings };

  const ids = new Set();
  const checkId = (ent, kind) => {
    if (!ent || typeof ent.id !== "string") fail("SCHEMA", `${kind} 存在缺少 id 的记录`);
    else if (ids.has(ent.id)) fail("DUP_ID", `记录 id 重复：${ent.id}`);
    else ids.add(ent.id);
  };
  doc.factions.forEach((f) => checkId(f, "阵营"));
  doc.players.forEach((p) => checkId(p, "玩家"));
  doc.seasons.forEach((s) => checkId(s, "赛季"));
  doc.rounds.forEach((r) => checkId(r, "轮次"));
  doc.seats.forEach((s) => checkId(s, "座位"));
  doc.penalties.forEach((p) => checkId(p, "处罚"));

  const factionIds = new Set(doc.factions.map((f) => f.id));
  const playerIds = new Set(doc.players.map((p) => p.id));
  const seasonIds = new Set(doc.seasons.map((s) => s.id));
  const roundIds = new Set(doc.rounds.map((r) => r.id));

  // 阵营：空（中立玩家）只警告；引用了不存在的阵营 id 是硬错误
  doc.players.forEach((p) => {
    if (p.factionId === "" || p.factionId === null || p.factionId === undefined) {
      warnings.push({ code: "MISSING_FACTION", msg: `玩家「${p.name || p.id}」没有阵营（中立玩家，可继续导入）` });
    } else if (!factionIds.has(p.factionId)) {
      fail("MISSING_FACTION", `玩家「${p.name || p.id}」引用的阵营 ${p.factionId} 不存在`);
    }
  });

  // 重复参赛者：同一轮内同一报名人出现两次（考虑替换 originalPlayerId）
  const seatsByRound = new Map();
  for (const s of doc.seats) {
    if (!roundIds.has(s.roundId)) fail("DANGLING", `座位 ${s.id} 引用了不存在的轮次`);
    if (!playerIds.has(s.playerId)) fail("DANGLING", `座位 ${s.id} 的玩家 ${s.playerId} 不存在`);
    if (!seatsByRound.has(s.roundId)) seatsByRound.set(s.roundId, []);
    seatsByRound.get(s.roundId).push(s);
  }
  for (const [rid, list] of seatsByRound) {
    const seen = new Set();
    for (const s of list) {
      const key = s.originalPlayerId || s.playerId;
      if (seen.has(key)) {
        const round = doc.rounds.find((r) => r.id === rid);
        fail("DUPLICATE_ENTRY", `第 ${round?.name || rid} 轮中玩家 ${s.playerId} 重复参赛`);
      }
      seen.add(key);
    }
  }

  // 非法比分
  for (const s of doc.seats) {
    if (s.attendance === "absent") continue;
    if (s.score !== null && s.score !== undefined) {
      if (!Number.isInteger(s.score) || s.score < 0) fail("BAD_SCORE", `座位 ${s.id} 比分非法：${s.score}`);
    }
    if (s.rank !== null && s.rank !== undefined) {
      if (!Number.isInteger(s.rank) || s.rank < 1) fail("BAD_SCORE", `座位 ${s.id} 名次非法：${s.rank}`);
    }
  }

  // 循环引用（补赛链）
  const cycle = findRoundCycle(doc.rounds);
  if (cycle) {
    const names = cycle.map((id) => doc.rounds.find((r) => r.id === id)?.name || id).join(" → ");
    fail("CYCLE", `轮次补赛引用成环：${names}`);
  }
  for (const r of doc.rounds) {
    if (r.seasonId && !seasonIds.has(r.seasonId)) fail("DANGLING", `轮次 ${r.id} 引用了不存在的赛季`);
    if (r.derivedFromRoundId && !roundIds.has(r.derivedFromRoundId)) fail("DANGLING", `轮次 ${r.id} 的补赛来源不存在`);
  }
  for (const p of doc.penalties) {
    if (!roundIds.has(p.roundId)) fail("DANGLING", `处罚 ${p.id} 的轮次不存在`);
    if (!playerIds.has(p.playerId)) fail("DANGLING", `处罚 ${p.id} 的玩家不存在`);
    if (typeof p.points !== "number" || p.points < 0) fail("BAD_SCORE", `处罚 ${p.id} 分值非法`);
  }

  return { errors, warnings };
}
