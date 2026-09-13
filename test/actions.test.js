// 动作层状态机 / 审计 / 更正重算测试
globalThis.window = { listeners: {}, addEventListener() {} };
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k)
};

const A = await import("../js/actions.js");
const { store } = await import("../js/store.js");
const { computeStandings, ROUND_STATUS } = await import("../js/domain.js");

let pass = 0;
let fail = 0;
function assert(cond, msg) {
  if (cond) pass++;
  else {
    fail++;
    console.error("✗", msg);
  }
}
function expectFail(result, msg) {
  assert(result && result.ok === false, msg);
}

// 准备：3 阵营各 3 名玩家（9 人，每桌 3 人，3 桌），保证第 2 轮仍有可行分桌
["红", "蓝", "金"].forEach((n) => A.createFaction(n));
const facs = () => store.state.factions;
const roster = [
  ["阿十", 5, "红"], ["小满", 4, "蓝"], ["柯北", 3, "金"],
  ["豆豆", 4, "红"], ["七喜", 5, "蓝"], ["阿澈", 3, "金"],
  ["年糕", 2, "红"], ["梅子", 5, "蓝"], ["闻笙", 4, "金"]
];
const ids = [];
for (const [name, skill, facName] of roster) {
  A.createPlayer({ name, skill, factionId: facs().find((f) => f.name === facName).id });
  ids.push(store.state.players.find((p) => p.name === name).id);
}
const [p1, p2, p3, p4, p5, p6] = ids;
A.createSeason({ name: "S1", game: "测试", minSize: 3, maxSize: 3, pointsWin: 3, pointsDraw: 1, participantIds: ids });
const sid = store.state.seasons[0].id;

// ---- 非法赛季参数阻断且不落数据 ----
const before = JSON.stringify(store.state.seasons.length);
expectFail(A.createSeason({ name: "坏", game: "x", minSize: 4, maxSize: 3, pointsWin: 3, pointsDraw: 1 }), "下限>上限要阻断");
expectFail(A.createSeason({ name: "坏", game: "x", minSize: 2, maxSize: 4, pointsWin: 1, pointsDraw: 1 }), "平局分≥胜局分要阻断");
assert(store.state.seasons.length === Number(before), "阻断后未写入赛季");

// ---- 流转不能跳跃：草稿不能直接结算 ----
A.createRound(sid, "第 1 轮");
const r1 = store.state.rounds.find((r) => r.no === 1);
expectFail(A.settleRound(r1.id), "草稿→结算必须阻断");
assert(store.state.rounds[0].status === ROUND_STATUS.DRAFT, "状态仍是草稿");

// 分桌 9 人 => 3 桌各 3
let seats = store.state.seats.filter((s) => s.roundId === r1.id);
const tables = new Set(seats.map((s) => s.tableNo));
assert(tables.size === 3 && seats.length === 9, "自动 3 桌 9 座");

// ---- 发布 → 撤销 → 再发布 ----
assert(A.publishRound(r1.id).ok, "发布成功");
expectFail(A.publishRound(r1.id), "重复发布阻断");
assert(A.unpublishRound(r1.id).ok, "撤销发布成功");
expectFail(A.unpublishRound(r1.id), "草稿态撤销阻断");
assert(A.publishRound(r1.id).ok, "撤销后可重新发布");

// 已发布轮次不能删
expectFail(A.deleteRound(r1.id), "已发布轮次不能直接删除（需先撤销）");

// ---- 录比分：未发完不能结算 ----
seats = store.state.seats.filter((s) => s.roundId === r1.id);
const byTable = [0, 1, 2].map((t) => seats.filter((s) => s.tableNo === t));
byTable[0].forEach((s, i) => A.patchSeatResult(s.id, { score: 10 - i, rank: i + 1 }));
byTable[1].forEach((s, i) => A.patchSeatResult(s.id, { score: 9 - i, rank: i + 1 }));
// 第三桌只填一个
A.patchSeatResult(byTable[2][0].id, { score: 9, rank: 1 });
expectFail(A.settleRound(r1.id), "未填完比分应阻断结算");
A.patchSeatResult(byTable[2][1].id, { score: 8, rank: 2 });
A.patchSeatResult(byTable[2][2].id, { score: 5, rank: 3 });
assert(A.settleRound(r1.id).ok, "比分完整后结算成功");
expectFail(A.settleRound(r1.id), "重复结算阻断");
expectFail(A.publishRound(r1.id), "已结算不能回发布");
expectFail(A.reseat(r1.id), "已结算不能重排");
expectFail(A.setAttendance(r1.id, p1, "absent"), "已结算不能改出席");
expectFail(A.deleteRound(r1.id), "已结算不能删除");

// ---- 处罚参与积分 ----
A.addPenalty(r1.id, p1, 2, "犯规");
let standings = computeStandings(store.state, sid);
const row = (id) => standings.find((x) => x.playerId === id);
assert(row(p1).penalties === 2 && row(p1).total === row(p1).resultPoints - 2, "处罚扣分计入总积分");

// ---- 更正旧赛果：审计 + 排名重算 ----
// 让第三桌某人从第 2 名改成与第一名并列
const tLastFirst = byTable[2][0];
const tLastSecond = byTable[2][1];
A.correctSeatResult(tLastSecond.id, { score: 9, rank: 1 }, { score: 8, rank: 2 });
A.correctSeatResult(tLastFirst.id, { score: 9, rank: 1 }, { score: 9, rank: 1 });
const auditTexts = store.state.audit.map((a) => a.action + " " + a.detail);
assert(auditTexts.some((t) => t.includes("更正赛果")), "更正写入审计");
assert(!auditTexts.some((t) => t.includes("9→9")), "无变化的更正不写审计");
standings = computeStandings(store.state, sid);
const changed = standings.find((x) => x.playerId === tLastSecond.playerId);
assert(changed.resultPoints === 1, `被更正者拿到平局分 1，实际 ${changed.resultPoints}`);

// 第二轮：已结算的后续轮次积分自动包含（“重算后续”）
A.createRound(sid, "第 2 轮");
const r2 = store.state.rounds.find((r) => r.no === 2);
assert(store.state.seats.filter((s) => s.roundId === r2.id).length === 9, "第 2 轮分桌成功（避免与第 1 轮同桌）");

// ---- 第二个草稿轮次阻断 ----
expectFail(A.createRound(sid, "第 3 轮草稿"), "已有草稿轮次时不能再建");
A.publishRound(r2.id);
seats = store.state.seats.filter((s) => s.roundId === r2.id);
const t2 = [0, 1, 2].map((t) => seats.filter((s) => s.tableNo === t));
// 第一桌制造真正断档名次 1,3,3（缺 2）应阻断结算
A.patchSeatResult(t2[0][0].id, { score: 9, rank: 1 });
A.patchSeatResult(t2[0][1].id, { score: 8, rank: 3 });
A.patchSeatResult(t2[0][2].id, { score: 7, rank: 3 });
t2[1].forEach((s, i) => A.patchSeatResult(s.id, { score: 9 - i, rank: i + 1 }));
t2[2].forEach((s, i) => A.patchSeatResult(s.id, { score: 9 - i, rank: i + 1 }));
expectFail(A.settleRound(r2.id), "名次断档（1,3,3）应阻断结算");
assert(store.state.rounds.find((r) => r.id === r2.id).status === ROUND_STATUS.PUBLISHED, "阻断后仍为已发布");
// 改回合法：并列第一 1,1,3（并列后顺延，合法）
A.patchSeatResult(t2[0][0].id, { score: 9, rank: 1 });
A.patchSeatResult(t2[0][1].id, { score: 9, rank: 1 });
A.patchSeatResult(t2[0][2].id, { score: 7, rank: 3 });
assert(A.settleRound(r2.id).ok, "并列第一（1,1,3）合法，可结算");
// 两轮后积分累加
standings = computeStandings(store.state, sid);
assert(standings.every((r) => r.appearances === 2), "每人出场 2 次");
assert(standings.reduce((sum, r) => sum + r.resultPoints, 0) >= 14, `两轮 3 桌胜/平名次分累计，实际 ${standings.reduce((s, r) => s + r.resultPoints, 0)}`);

// ---- 审计完整 ----
assert(store.state.audit.length >= 10, `审计条目充分，实际 ${store.state.audit.length}`);
assert(store.state.audit.every((a, i) => i === 0 || a.rev >= store.state.audit[i - 1].rev), "审计 rev 单调");

// ---- 已结算更正：非法值必须阻断并回滚 ----
const round1 = store.state.rounds.find((r) => r.no === 1);
const t0seats = store.state.seats
  .filter((s) => s.roundId === round1.id && s.tableNo === 0)
  .sort((a, b) => a.seatNo - b.seatNo);
const auditBefore = store.state.audit.length;
const snap = JSON.stringify(t0seats.map((s) => ({ id: s.id, score: s.score, rank: s.rank })));

// 负比分
let r = A.correctSeatResult(t0seats[0].id, { score: -9 }, { score: t0seats[0].score, rank: t0seats[0].rank });
expectFail(r, "更正为负比分被阻断");
// 零名次
r = A.correctSeatResult(t0seats[1].id, { rank: 0 }, { score: t0seats[1].score, rank: t0seats[1].rank });
expectFail(r, "更正为零名次被阻断");
// 缺失结果
r = A.correctSeatResult(t0seats[2].id, { score: null }, { score: t0seats[2].score, rank: t0seats[2].rank });
expectFail(r, "更正清空比分（缺失结果）被阻断");
// 名次断档：把第二个人从 2 改成 3（1,3,3）
r = A.correctSeatResult(t0seats[1].id, { rank: 3 }, { score: t0seats[1].score, rank: 2 });
expectFail(r, "更正造成名次断档被阻断");
// 全部回滚：座位值不变、未写审计
const snapAfter = JSON.stringify(
  store.state.seats.filter((s) => s.roundId === round1.id && s.tableNo === 0).sort((a, b) => a.seatNo - b.seatNo).map((s) => ({ id: s.id, score: s.score, rank: s.rank }))
);
assert(snap === snapAfter, "非法更正后原赛果完整保留（事务回滚）");
assert(store.state.audit.length === auditBefore, "非法更正不写审计");

// 合法更正：只改比分，名次不变 → 成功、写审计、积分榜仍可算
r = A.correctSeatResult(t0seats[0].id, { score: t0seats[0].score + 7 }, { score: t0seats[0].score, rank: t0seats[0].rank });
assert(r.ok, `合法更正应成功: ${JSON.stringify(r)}`);
assert(store.state.audit.some((a) => a.action === "更正赛果"), "合法更正写入审计");
const standingsAfter = computeStandings(store.state, sid);
assert(standingsAfter.length === 9 && standingsAfter.every((x) => Number.isFinite(x.total)), "更正后积分榜正常重算");

console.log(`\n${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
