// 动作层：所有业务流转都经这里，保证审计与状态机
import { store, auditEntry, freshState } from "./store.js";
import { uid } from "./util.js";
import {
  ROUND_STATUS,
  seasonRounds,
  roundSeats,
  seatRound,
  validateResults,
  validateImport,
  findRoundCycle
} from "./domain.js";

const S = () => store.state;

function currentSeason() {
  return S().seasons.find((s) => s.id === S().selectedSeasonId) || null;
}

export function getSeason(id) {
  return S().seasons.find((s) => s.id === (id || S().selectedSeasonId)) || null;
}

// ---------- 赛季 ----------
export function createSeason(input) {
  return store.commit((d) => {
    const season = {
      id: uid("sea"),
      name: input.name.trim(),
      game: input.game.trim(),
      minSize: Math.max(2, Math.min(6, Number(input.minSize))),
      maxSize: Math.max(2, Math.min(8, Number(input.maxSize))),
      pointsWin: Number(input.pointsWin),
      pointsDraw: Number(input.pointsDraw),
      participantIds: input.participantIds || [],
      createdAt: new Date().toISOString()
    };
    if (season.minSize > season.maxSize) throw new Error("每桌下限不能大于上限");
    if (season.pointsDraw >= season.pointsWin) throw new Error("平局分必须小于胜局分");
    d.seasons.push(season);
    d.selectedSeasonId = season.id;
    return auditEntry("赛季创建", season.id, `${season.name}（${season.game}）${season.minSize}-${season.maxSize}人/桌`);
  });
}

export function updateSeasonParticipants(seasonId, participantIds) {
  return store.commit((d) => {
    const season = d.seasons.find((s) => s.id === seasonId);
    if (!season) throw new Error("赛季不存在");
    const used = new Set();
    for (const r of seasonRounds(d, seasonId)) {
      for (const seat of d.seats.filter((x) => x.roundId === r.id)) used.add(seat.originalPlayerId || seat.playerId);
    }
    const removed = [...used].filter((id) => !participantIds.includes(id));
    if (removed.length) {
      const names = removed.map((id) => d.players.find((p) => p.id === id)?.name || id).join("、");
      throw new Error(`不能移除已参赛玩家：${names}`);
    }
    season.participantIds = participantIds;
    return auditEntry("参赛者调整", season.id, `当前参赛者 ${participantIds.length} 人`);
  });
}

export function selectSeason(id) {
  store.commit((d) => {
    d.selectedSeasonId = id;
  }, { silent: true });
}

// ---------- 玩家与阵营 ----------
export function createFaction(name) {
  return store.commit((d) => {
    name = name.trim();
    if (!name) throw new Error("阵营名不能为空");
    if (d.factions.some((f) => f.name === name)) throw new Error("阵营已存在");
    const f = { id: uid("fac"), name, rev: 1 };
    d.factions.push(f);
    return auditEntry("阵营创建", f.id, name);
  });
}

export function createPlayer(input) {
  return store.commit((d) => {
    const name = input.name.trim();
    if (!name) throw new Error("玩家名不能为空");
    if (d.players.some((p) => p.name === name)) throw new Error("玩家重名");
    if (input.factionId && !d.factions.some((f) => f.id === input.factionId)) throw new Error("阵营不存在");
    const skill = Number(input.skill);
    if (![1, 2, 3, 4, 5].includes(skill)) throw new Error("熟练度需在 1-5");
    const player = { id: uid("ply"), name, factionId: input.factionId || "", skill, rev: 1 };
    d.players.push(player);
    return auditEntry("玩家创建", player.id, `${name}（熟练度 ${skill}）`);
  });
}

export function updatePlayer(id, patch) {
  return store.commit((d) => {
    const p = d.players.find((x) => x.id === id);
    if (!p) throw new Error("玩家不存在");
    if (patch.factionId && !d.factions.some((f) => f.id === patch.factionId)) throw new Error("阵营不存在");
    Object.assign(p, patch);
    return auditEntry("玩家修改", id, Object.keys(patch).join("、"));
  });
}

// ---------- 轮次与分桌 ----------
export function createRound(seasonId, name) {
  return store.commit((d) => {
    const season = d.seasons.find((s) => s.id === seasonId);
    if (!season) throw new Error("赛季不存在");
    const rounds = seasonRounds(d, seasonId);
    if (rounds.some((r) => r.status === ROUND_STATUS.DRAFT)) throw new Error("已有草稿轮次，请先发布或删除");
    const no = rounds.length + 1;
    const round = {
      id: uid("rnd"),
      seasonId,
      no,
      name: (name || `第 ${no} 轮`).trim(),
      status: ROUND_STATUS.DRAFT,
      attendance: {},
      substitutions: [],
      createdAt: new Date().toISOString()
    };
    d.rounds.push(round);
    const plan = seatRound(d, season, round);
    if (plan.error) throw new Error(plan.error);
    d.seats.push(...plan.seats);
    return auditEntry("轮次创建", round.id, `${season.name} ${round.name}，自动分 ${plan.sizes.length} 桌`);
  });
}

export function reseat(roundId) {
  return store.commit((d) => {
    const round = d.rounds.find((r) => r.id === roundId);
    if (!round) throw new Error("轮次不存在");
    if (round.status === ROUND_STATUS.SETTLED) throw new Error("已结算轮次不能重排，请先更正赛果");
    const season = d.seasons.find((s) => s.id === round.seasonId);
    const plan = seatRound(d, season, round);
    if (plan.error) throw new Error(plan.error);
    // 保留锁座，删除该轮其余座位
    const locked = d.seats.filter((s) => s.roundId === roundId && s.locked);
    d.seats = d.seats.filter((s) => s.roundId !== roundId);
    d.seats.push(...plan.seats);
    return auditEntry("分桌重排", round.id, `重排为 ${plan.sizes.length} 桌，锁座保留 ${locked.length} 个`);
  });
}

export function toggleLockSeat(seatId) {
  return store.commit((d) => {
    const seat = d.seats.find((s) => s.id === seatId);
    if (!seat) throw new Error("座位不存在");
    const round = d.rounds.find((r) => r.id === seat.roundId);
    if (round.status === ROUND_STATUS.SETTLED) throw new Error("已结算轮次不能改锁座");
    seat.locked = !seat.locked;
    return auditEntry(seat.locked ? "锁定座位" : "解除锁座", seatId, `第${seat.tableNo + 1}桌 ${seat.seatNo}号座`);
  });
}

export function setAttendance(roundId, playerId, status) {
  return store.commit((d) => {
    const round = d.rounds.find((r) => r.id === roundId);
    if (!round) throw new Error("轮次不存在");
    if (round.status === ROUND_STATUS.SETTLED) throw new Error("已结算轮次不能改出席");
    const season = d.seasons.find((s) => s.id === round.seasonId);
    round.attendance = round.attendance || {};
    if (status === "present") delete round.attendance[playerId];
    else round.attendance[playerId] = status;
    const plan = seatRound(d, season, round);
    if (plan.error) throw new Error(plan.error);
    d.seats = d.seats.filter((s) => s.roundId !== roundId);
    d.seats.push(...plan.seats);
    const label = { absent: "缺席", late: "迟到" }[status] || "恢复到场";
    return auditEntry(`出席变更·${label}`, roundId, playerLabel(d, playerId));
  });
}

export function substitutePlayer(roundId, outPlayerId, inPlayerId) {
  return store.commit((d) => {
    const round = d.rounds.find((r) => r.id === roundId);
    if (!round) throw new Error("轮次不存在");
    if (round.status === ROUND_STATUS.SETTLED) throw new Error("已结算轮次不能替换");
    const inPlayer = d.players.find((p) => p.id === inPlayerId);
    if (!inPlayer) throw new Error("替补玩家不存在");
    const seats = d.seats.filter((s) => s.roundId === roundId);
    const outSeat = seats.find((s) => (s.originalPlayerId || s.playerId) === outPlayerId);
    if (!outSeat) throw new Error("该玩家本轮没有座位");
    if (outSeat.locked) throw new Error("该座位已锁定，不能替换");
    if (seats.some((s) => s.playerId === inPlayerId)) throw new Error("替补玩家已在本桌名单中");
    round.substitutions = round.substitutions || [];
    round.substitutions = round.substitutions.filter((s) => s.outPlayerId !== outPlayerId);
    round.substitutions.push({ outPlayerId, inPlayerId });
    const season = d.seasons.find((s) => s.id === round.seasonId);
    const plan = seatRound(d, season, round);
    if (plan.error) throw new Error(plan.error);
    d.seats = d.seats.filter((s) => s.roundId !== roundId);
    d.seats.push(...plan.seats);
    return auditEntry("替补换人", roundId, `${playerLabel(d, outPlayerId)} → ${playerLabel(d, inPlayerId)}`);
  });
}

export function undoSubstitute(roundId, outPlayerId) {
  return store.commit((d) => {
    const round = d.rounds.find((r) => r.id === roundId);
    if (!round) throw new Error("轮次不存在");
    if (round.status === ROUND_STATUS.SETTLED) throw new Error("已结算轮次不能操作");
    round.substitutions = (round.substitutions || []).filter((s) => s.outPlayerId !== outPlayerId);
    const season = d.seasons.find((s) => s.id === round.seasonId);
    const plan = seatRound(d, season, round);
    if (plan.error) throw new Error(plan.error);
    d.seats = d.seats.filter((s) => s.roundId !== roundId);
    d.seats.push(...plan.seats);
    return auditEntry("撤销替补", roundId, playerLabel(d, outPlayerId));
  });
}

// ---------- 发布 / 结算 / 撤销 ----------
export function publishRound(roundId) {
  return store.commit((d) => {
    const round = d.rounds.find((r) => r.id === roundId);
    if (!round) throw new Error("轮次不存在");
    if (round.status !== ROUND_STATUS.DRAFT) throw new Error("只有草稿轮次可以发布（不能跳跃流转）");
    const seats = d.seats.filter((s) => s.roundId === roundId);
    if (!seats.length) throw new Error("没有分桌，无法发布");
    round.status = ROUND_STATUS.PUBLISHED;
    round.publishedAt = new Date().toISOString();
    return auditEntry("发布赛程", roundId, round.name);
  });
}

export function unpublishRound(roundId) {
  return store.commit((d) => {
    const round = d.rounds.find((r) => r.id === roundId);
    if (!round) throw new Error("轮次不存在");
    if (round.status !== ROUND_STATUS.PUBLISHED) throw new Error("只有已发布轮次可以撤销发布");
    round.status = ROUND_STATUS.DRAFT;
    delete round.publishedAt;
    return auditEntry("撤销发布", roundId, `${round.name} 退回草稿`);
  });
}

export function settleRound(roundId) {
  return store.commit((d) => {
    const round = d.rounds.find((r) => r.id === roundId);
    if (!round) throw new Error("轮次不存在");
    if (round.status !== ROUND_STATUS.PUBLISHED) throw new Error("只有已发布轮次可以结算（草稿必须先发布）");
    const seats = d.seats.filter((s) => s.roundId === roundId && s.attendance !== "absent");
    const tableCount = Math.max(...d.seats.filter((s) => s.roundId === roundId).map((s) => s.tableNo)) + 1;
    const errors = validateResults(seats, tableCount);
    if (errors.length) throw new Error(errors.map((e) => e.msg).join("；"));
    round.status = ROUND_STATUS.SETTLED;
    round.settledAt = new Date().toISOString();
    return auditEntry("结算轮次", roundId, round.name);
  });
}

// ---------- 赛果录入与更正 ----------
export function patchSeatResult(seatId, patch) {
  // 逐字录入：静默持久化（rev 仍推进，参与跨页合并），不刷 UI、不写审计
  return store.commit(
    (d) => {
      const seat = d.seats.find((s) => s.id === seatId);
      if (!seat) throw new Error("座位不存在");
      const round = d.rounds.find((r) => r.id === seat.roundId);
      if (round.status === ROUND_STATUS.DRAFT) throw new Error("草稿轮次请先发布再录比分");
      if ("score" in patch) seat.score = patch.score;
      if ("rank" in patch) seat.rank = patch.rank;
    },
    { silent: true }
  );
}

export function correctSeatResult(seatId, patch, before) {
  // 已结算轮次失焦时：若值确有变化，记一条更正审计（后续积分由派生层自动重算）
  return store.commit((d) => {
    const seat = d.seats.find((s) => s.id === seatId);
    if (!seat) throw new Error("座位不存在");
    const round = d.rounds.find((r) => r.id === seat.roundId);
    if (round.status !== ROUND_STATUS.SETTLED) return null;
    if ("score" in patch && before.score === patch.score && "rank" in patch && before.rank === patch.rank) return null;
    if ("score" in patch) seat.score = patch.score;
    if ("rank" in patch) seat.rank = patch.rank;
    const changes = [];
    if (before.score !== seat.score) changes.push(`比分 ${before.score ?? "∅"}→${seat.score ?? "∅"}`);
    if (before.rank !== seat.rank) changes.push(`名次 ${before.rank ?? "∅"}→${seat.rank ?? "∅"}`);
    if (!changes.length) return null;
    return auditEntry(
      "更正赛果",
      seatId,
      `${round.name} ${playerLabel(d, seat.originalPlayerId || seat.playerId)}：${changes.join("，")}；后续积分榜已重算`
    );
  });
}

export function addPenalty(roundId, playerId, points, reason) {
  return store.commit((d) => {
    const round = d.rounds.find((r) => r.id === roundId);
    if (!round) throw new Error("轮次不存在");
    const n = Number(points);
    if (!Number.isFinite(n) || n <= 0) throw new Error("处罚分值需为正数");
    const pen = { id: uid("pen"), roundId, playerId, points: n, reason: reason || "", createdAt: new Date().toISOString() };
    d.penalties.push(pen);
    const wasSettled = round.status === ROUND_STATUS.SETTLED;
    return auditEntry(wasSettled ? "结算后追加处罚（重算）" : "登记处罚", roundId, `${playerLabel(d, playerId)} -${n} 分`);
  });
}

export function removePenalty(penaltyId) {
  return store.commit((d) => {
    const pen = d.penalties.find((p) => p.id === penaltyId);
    if (!pen) throw new Error("处罚不存在");
    d.penalties = d.penalties.filter((p) => p.id !== penaltyId);
    return auditEntry("撤销处罚", penaltyId, `${playerLabel(d, pen.playerId)} ${pen.points} 分`);
  });
}

export function deleteRound(roundId) {
  return store.commit((d) => {
    const round = d.rounds.find((r) => r.id === roundId);
    if (!round) throw new Error("轮次不存在");
    if (round.status !== ROUND_STATUS.DRAFT) throw new Error("只有草稿轮次可以删除（已发布请先撤销发布）");
    d.seats = d.seats.filter((s) => s.roundId !== roundId);
    d.penalties = d.penalties.filter((p) => p.roundId !== roundId);
    d.rounds = d.rounds.filter((r) => r.id !== roundId);
    // 顺延轮号
    const rest = seasonRounds(d, round.seasonId);
    rest.forEach((r, i) => (r.no = i + 1));
    return auditEntry("删除轮次", roundId, round.name);
  });
}

// ---------- 导入（原子：失败不覆盖） ----------
export function importDocument(doc) {
  const report = validateImport(doc);
  if (report.errors.length) return { ok: false, ...report };
  const result = store.commit((d) => {
    const keepAudit = [...(d.audit || [])];
    const keepTombstones = [...(d.tombstones || [])];
    const clean = freshState();
    clean.selectedSeasonId = doc.seasons[0]?.id || "";
    clean.seasons = doc.seasons;
    clean.players = doc.players;
    clean.factions = doc.factions;
    clean.rounds = doc.rounds;
    clean.seats = doc.seats;
    clean.penalties = doc.penalties;
    clean.audit = keepAudit; // 审计日志跨导入保留
    clean.tombstones = keepTombstones;
    for (const key of Object.keys(d)) delete d[key];
    Object.assign(d, clean);
    return auditEntry(
      "导入数据",
      null,
      `${doc.seasons.length} 个赛季、${doc.players.length} 名玩家、${doc.rounds.length} 个轮次；旧业务数据整体替换，审计保留`
    );
  });
  return result.ok ? { ok: true, ...report } : result;
}

export function validateCurrent() {
  return validateImport({ schema: "league-console/v1", ...S() });
}

function playerLabel(d, id) {
  const p = d.players.find((x) => x.id === id);
  return p ? p.name : id;
}
