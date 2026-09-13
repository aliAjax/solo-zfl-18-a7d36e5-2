// 领域逻辑冒烟测试（Node 直接跑，不依赖 DOM）
import {
  seatRound,
  computeStandings,
  validateImport,
  validateResults,
  planSizes,
  ROUND_STATUS
} from "../js/domain.js";

let pass = 0;
let fail = 0;
function assert(cond, msg) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.error("✗", msg);
  }
}

// ---- planSizes ----
assert(JSON.stringify(planSizes(10, 3, 4).sizes) === JSON.stringify([4, 3, 3]), "10人 3-4 桌 => 4,3,3");
assert(JSON.stringify(planSizes(9, 3, 4).sizes) === JSON.stringify([3, 3, 3]), "9人 => 3,3,3");
assert(planSizes(8, 3, 4).sizes.every((x) => x >= 3), "8人不出现 2 人桌");
assert(!!planSizes(4, 3, 4, { 2: 1 }).error, "锁到第3桌但只有4人应阻断");
assert(planSizes(7, 3, 4, { 1: 1 }).sizes[1] >= 3, "锁桌容量分配合法");

// ---- 构造数据 ----
const FACTIONS = [
  { id: "fA", name: "红" },
  { id: "fB", name: "蓝" },
  { id: "fC", name: "金" }
];
const ALL_PLAYERS = [
  { id: "p1", name: "甲", factionId: "fA", skill: 5 },
  { id: "p2", name: "乙", factionId: "fB", skill: 4 },
  { id: "p3", name: "丙", factionId: "fC", skill: 3 },
  { id: "p4", name: "丁", factionId: "fA", skill: 2 },
  { id: "p5", name: "戊", factionId: "fB", skill: 5 },
  { id: "p6", name: "己", factionId: "fC", skill: 4 },
  { id: "p7", name: "庚", factionId: "", skill: 3 },
  { id: "p8", name: "辛", factionId: "fA", skill: 1 },
  { id: "p9", name: "壬", factionId: "fB", skill: 5 },
  { id: "pX", name: "替补", factionId: "fC", skill: 3 }
];

function mkState(participantIds) {
  const season = {
    id: "s1", name: "测试赛", game: "X", minSize: 3, maxSize: 4,
    pointsWin: 3, pointsDraw: 1, participantIds
  };
  return { factions: FACTIONS, players: ALL_PLAYERS, seasons: [season], rounds: [], seats: [], penalties: [], audit: [] };
}

function tablesOf(seats) {
  const m = new Map();
  seats.forEach((s) => {
    if (!m.has(s.tableNo)) m.set(s.tableNo, []);
    m.get(s.tableNo).push(s.playerId);
  });
  return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([, ids]) => ids);
}

const nine = ALL_PLAYERS.slice(0, 9).map((p) => p.id);
const pmap = new Map(ALL_PLAYERS.map((p) => [p.id, p]));

// ---- 初次分桌：阵营互斥 + 均衡 ----
let state = mkState(nine);
const r1 = { id: "r1", seasonId: "s1", no: 1, status: ROUND_STATUS.DRAFT, attendance: {}, substitutions: [] };
state.rounds.push(r1);
const plan1 = seatRound(state, state.seasons[0], r1);
assert(!plan1.error, `初次分桌应成功: ${plan1.error || ""}`);
for (const t of tablesOf(plan1.seats)) {
  const facs = t.map((id) => pmap.get(id).factionId).filter(Boolean);
  assert(new Set(facs).size === facs.length, "同阵营不同桌");
  assert(t.length >= 3 && t.length <= 4, "桌容 3-4");
}
assert(plan1.seats.length === 9, "9 人都入座");

// ---- 缺席 + 锁座导致人数失衡：用 2/2/2/4 阵营分布的 10 人名单 ----
const BALANCED = [
  { id: "a1", name: "A1", factionId: "fA", skill: 4 }, { id: "a2", name: "A2", factionId: "fA", skill: 3 },
  { id: "b1", name: "B1", factionId: "fB", skill: 5 }, { id: "b2", name: "B2", factionId: "fB", skill: 2 },
  { id: "c1", name: "C1", factionId: "fC", skill: 4 }, { id: "c2", name: "C2", factionId: "fC", skill: 3 },
  { id: "n1", name: "N1", factionId: "", skill: 5 }, { id: "n2", name: "N2", factionId: "", skill: 1 },
  { id: "n3", name: "N3", factionId: "", skill: 4 }, { id: "n4", name: "N4", factionId: "", skill: 2 }
];
state = {
  factions: FACTIONS,
  players: [...ALL_PLAYERS, ...BALANCED.filter((p) => !ALL_PLAYERS.some((q) => q.id === p.id))],
  seasons: [{ id: "s1", name: "均衡赛", game: "X", minSize: 3, maxSize: 4, pointsWin: 3, pointsDraw: 1, participantIds: BALANCED.map((p) => p.id) }],
  rounds: [], seats: [], penalties: [], audit: []
};
const rb = { id: "rb", seasonId: "s1", no: 1, status: ROUND_STATUS.DRAFT, attendance: {}, substitutions: [] };
state.rounds.push(rb);
const planB = seatRound(state, state.seasons[0], rb);
assert(!planB.error, `10 人分桌成功: ${planB.error || ""}`);
assert(planB.sizes.slice().sort((a, b) => a - b).join(",") === "3,3,4", "10 人 => 4,3,3");
// 锁住第 3 桌一个座位；两名无阵营玩家缺席 => 8 人本可 4,4，但锁座逼出第 3 桌 => 3,3,2 违反下限，阻断
const lockB = planB.seats.find((s) => s.tableNo === 2);
lockB.locked = true;
state.seats = planB.seats;
rb.attendance = { n3: "absent", n4: "absent" };
const blockedPlan = seatRound(state, state.seasons[0], rb);
assert(!!blockedPlan.error, "锁座占 3 桌但 8 人无法 3 桌均衡时应阻断（人数失衡）");
// 解锁后 8 人 2 桌 4,4
state.seats = state.seats.map((s) => ({ ...s, locked: false }));
const plan8 = seatRound(state, state.seasons[0], rb);
assert(!plan8.error, `8 人重排应成功: ${plan8.error || ""}`);
assert(plan8.sizes.slice().sort((a, b) => a - b).join(",") === "4,4", "8 人 => 4,4");
assert(!plan8.seats.some((s) => ["n3", "n4"].includes(s.playerId)), "缺席者不入座");

// ---- 迟到到场 + 锁座不动：9 人名单加一名无阵营 pY，pY 迟到后 9 人正好 3,3,3 ----
state = mkState(nine);
state.players = [...state.players, { id: "pY", name: "外援", factionId: "", skill: 2 }];
state.seasons[0].participantIds = [...nine, "pY"];
const rl = { id: "rl", seasonId: "s1", no: 1, status: ROUND_STATUS.DRAFT, attendance: {}, substitutions: [] };
state.rounds.push(rl);
const planL0 = seatRound(state, state.seasons[0], rl);
const lockMe = planL0.seats.find((s) => s.tableNo === 1);
lockMe.locked = true;
state.seats = planL0.seats;
rl.attendance = { pY: "late" };
const planLocked = seatRound(state, state.seasons[0], rl);
assert(!planLocked.error, `9 人带锁第 2 桌重排应成功: ${planLocked.error || ""}`);
const kept = planLocked.seats.find((s) => s.playerId === lockMe.playerId);
assert(kept && kept.tableNo === 1 && kept.seatNo === lockMe.seatNo, "锁座桌号座号都不动");
assert(!planLocked.seats.some((s) => s.playerId === "pY"), "迟到者暂不入座");
assert(planLocked.sizes.join(",") === "3,3,3", `9 人 3,3,3，实际 ${planLocked.sizes}`);

// ---- 替换：p3 被替补 pX 替换（9 人），锁座保持 ----
state = mkState(nine);
const r1s = { id: "r1s", seasonId: "s1", no: 1, status: ROUND_STATUS.DRAFT, attendance: {}, substitutions: [] };
state.rounds.push(r1s);
const planS0 = seatRound(state, state.seasons[0], r1s);
const lockS = planS0.seats.find((s) => s.tableNo === 0);
lockS.locked = true;
state.seats = planS0.seats;
r1s.substitutions = [{ outPlayerId: "p3", inPlayerId: "pX" }];
const planSub = seatRound(state, state.seasons[0], r1s);
assert(!planSub.error, `替换重排成功: ${planSub.error || ""}`);
assert(planSub.seats.some((s) => s.playerId === "pX" && s.originalPlayerId === "p3"), "替补带 originalPlayerId");
assert(!planSub.seats.some((s) => s.playerId === "p3"), "被替换者不在座");
const lockKeptAfterSub = planSub.seats.find((s) => s.playerId === lockS.playerId);
assert(lockKeptAfterSub && lockKeptAfterSub.tableNo === 0 && lockKeptAfterSub.seatNo === lockS.seatNo, "替换重排后锁座仍不动");

// ---- 重复同桌阻断：全员历史上同过桌，再次分桌失败 ----
state = mkState(nine);
state.rounds = [{ id: "h1", seasonId: "s1", no: 1, status: ROUND_STATUS.SETTLED, attendance: {}, substitutions: [] }];
state.seats = nine.map((pid, i) => ({
  id: `hs${i}`, roundId: "h1", tableNo: 0, seatNo: i + 1, playerId: pid,
  rank: ((i % 3) + 1), score: 10 - i, locked: false, attendance: "present", originalPlayerId: null
}));
const r2 = { id: "r2", seasonId: "s1", no: 2, status: ROUND_STATUS.DRAFT, attendance: {}, substitutions: [] };
state.rounds.push(r2);
const planRepeat = seatRound(state, state.seasons[0], r2);
assert(!!planRepeat.error, "全员曾同桌时再次分桌应被阻断（重复同桌）");

// ---- 积分：胜 3、平 1、处罚扣分、破同分 ----
state = mkState(nine);
state.rounds = [{ id: "q1", seasonId: "s1", no: 1, status: ROUND_STATUS.SETTLED }];
state.seats = [
  { id: "a", roundId: "q1", tableNo: 0, seatNo: 1, playerId: "p1", rank: 1, score: 20 },
  { id: "b", roundId: "q1", tableNo: 0, seatNo: 2, playerId: "p2", rank: 2, score: 12 },
  { id: "c", roundId: "q1", tableNo: 0, seatNo: 3, playerId: "p3", rank: 2, score: 11 },
  { id: "d", roundId: "q1", tableNo: 1, seatNo: 1, playerId: "p4", rank: 1, score: 18 },
  { id: "e", roundId: "q1", tableNo: 1, seatNo: 2, playerId: "p5", rank: 1, score: 18 },
  { id: "f", roundId: "q1", tableNo: 1, seatNo: 3, playerId: "p6", rank: 3, score: 5 },
  { id: "g", roundId: "q1", tableNo: 2, seatNo: 1, playerId: "p7", rank: 1, score: 9 },
  { id: "h", roundId: "q1", tableNo: 2, seatNo: 2, playerId: "p8", rank: 2, score: 8 },
  { id: "i", roundId: "q1", tableNo: 2, seatNo: 3, playerId: "p9", rank: 3, score: 7 }
];
state.penalties = [{ id: "z1", roundId: "q1", playerId: "p1", points: 1, reason: "迟到" }];
let standings = computeStandings(state, "s1");
const byId = Object.fromEntries(standings.map((r) => [r.playerId, r]));
assert(byId.p1.total === 2, `p1 胜 3 扣 1 = 2，实际 ${byId.p1.total}`);
assert(byId.p4.total === 1 && byId.p5.total === 1, "并列第一各得平局分 1");
assert(byId.p2.total === 0, "第二名 0 分");
assert(byId.p4.buchholz === byId.p5.buchholz, "并列者对手分一致");
assert(standings[0].playerId === "p7", `榜首应是全胜无处罚 p7，实际 ${standings[0].playerId}`);

// ---- 更正旧赛果后排名变化（派生层全量重算）----
const seatP7 = state.seats.find((s) => s.playerId === "p7");
const seatP8 = state.seats.find((s) => s.playerId === "p8");
seatP7.rank = 2;
seatP7.score = 6;
seatP8.rank = 1;
seatP8.score = 15;
standings = computeStandings(state, "s1");
assert(standings[0].playerId === "p8", `更正后榜首应为 p8，实际 ${standings[0].playerId}`);

// ---- 破同分：同总分先看相互战绩，再看对手分 ----
state = mkState(["p1", "p2", "p3", "p4", "p5", "p6"]);
state.seasons[0].participantIds = ["p1", "p2", "p3", "p4", "p5", "p6"];
state.rounds = [
  { id: "w1", seasonId: "s1", no: 1, status: ROUND_STATUS.SETTLED },
  { id: "w2", seasonId: "s1", no: 2, status: ROUND_STATUS.SETTLED }
];
// w1: p1>p2, p3>p4, p5>p6；w2: p1>p3, p2>p5, p4>p6（无重复同桌）
state.seats = [
  { roundId: "w1", tableNo: 0, seatNo: 1, playerId: "p1", rank: 1, score: 10 },
  { roundId: "w1", tableNo: 0, seatNo: 2, playerId: "p2", rank: 2, score: 8 },
  { roundId: "w1", tableNo: 1, seatNo: 1, playerId: "p3", rank: 1, score: 9 },
  { roundId: "w1", tableNo: 1, seatNo: 2, playerId: "p4", rank: 2, score: 7 },
  { roundId: "w1", tableNo: 2, seatNo: 1, playerId: "p5", rank: 1, score: 9 },
  { roundId: "w1", tableNo: 2, seatNo: 2, playerId: "p6", rank: 2, score: 6 },
  { roundId: "w2", tableNo: 0, seatNo: 1, playerId: "p1", rank: 1, score: 10 },
  { roundId: "w2", tableNo: 0, seatNo: 2, playerId: "p3", rank: 2, score: 8 },
  { roundId: "w2", tableNo: 1, seatNo: 1, playerId: "p2", rank: 1, score: 10 },
  { roundId: "w2", tableNo: 1, seatNo: 2, playerId: "p5", rank: 2, score: 8 },
  { roundId: "w2", tableNo: 2, seatNo: 1, playerId: "p4", rank: 1, score: 9 },
  { roundId: "w2", tableNo: 2, seatNo: 2, playerId: "p6", rank: 2, score: 6 }
];
standings = computeStandings(state, "s1");
// 总分：p1=6，p2/p3/p4/p5=3，p6=0
// 对手分：p2 对 p1(6)+p5(3)=9、p3 对 p1(6)+p4(3)=9；p4=3、p5=3
const idx = Object.fromEntries(standings.map((r, i) => [r.playerId, i]));
assert(standings[0].playerId === "p1", "两胜 p1 居首");
assert(standings[5].playerId === "p6", "两负 p6 垫底");
assert(Math.max(idx.p2, idx.p3) === 2 && Math.min(idx.p2, idx.p3) === 1, `p2/p3 对手分 9 应占 2-3 位：${JSON.stringify(idx)}`);
assert(Math.max(idx.p4, idx.p5) === 4 && Math.min(idx.p4, idx.p5) === 3, `p4/p5 对手分 3 应占 4-5 位：${JSON.stringify(idx)}`);
assert(idx.p2 < idx.p5, "p2 与 p5 同总分且直接交手 p2 胜，p2 应在 p5 前");

// ---- 赛果校验：缺失 / 非法值 / 断档 / 重复座号 ----
const seat = (t, n, pid, rank, score) => ({ tableNo: t, seatNo: n, playerId: pid, rank, score });
let errs = validateResults([seat(0, 1, "a", 1, 10), seat(0, 2, "b", 2, 8), seat(0, 3, "c", 2, 8)], 1);
assert(errs.length === 0, `并列第二(1,2,2)合法: ${JSON.stringify(errs)}`);
errs = validateResults([seat(0, 1, "a", 1, 10), seat(0, 2, "b", 1, 10), seat(0, 3, "c", 3, 7)], 1);
assert(errs.length === 0, `并列第一(1,1,3)合法: ${JSON.stringify(errs)}`);
errs = validateResults([seat(0, 1, "a", 1, 10), seat(0, 2, "b", 3, 8), seat(0, 3, "c", 3, 7)], 1);
assert(errs.some((e) => e.msg.includes("断档")), "名次 1,3,3 断档被检出");
errs = validateResults([seat(0, 1, "a", 0, 10), seat(0, 2, "b", 1, 8)], 1);
assert(errs.some((e) => /名次 0 非法|名次必须从 1/.test(e.msg)), "零名次被检出");
errs = validateResults([seat(0, 1, "a", 1, -5), seat(0, 2, "b", 2, 8)], 1);
assert(errs.some((e) => e.msg.includes("比分 -5")), "负比分被检出");
errs = validateResults([seat(0, 1, "a", null, 10), seat(0, 2, "b", 1, 8)], 1, { requireResults: true });
assert(errs.some((e) => e.msg.includes("未填")), "已结算但缺名次被检出");
errs = validateResults([seat(0, 1, "a", 1, null), seat(0, 2, "b", 2, 8)], 1, { requireResults: true });
assert(errs.some((e) => e.msg.includes("未填")), "已结算但缺比分被检出");
errs = validateResults([seat(0, 1, "a", null, null), seat(0, 2, "b", 1, 8)], 1, { requireResults: false });
assert(errs.length === 0, `非结算态允许空结果: ${JSON.stringify(errs)}`);
errs = validateResults([seat(0, 1, "a", 1, 9), seat(0, 1, "b", 2, 8)], 1);
assert(errs.some((e) => e.msg.includes("重复占用")), "同桌同座号重复被检出");

// ---- 导入校验 ----
const baseDoc = () => ({
  schema: "league-console/v1",
  factions: [{ id: "f1", name: "A" }],
  players: [{ id: "u1", name: "X", factionId: "f1", skill: 3 }],
  seasons: [{ id: "s1", participantIds: ["u1"], minSize: 2, maxSize: 4, pointsWin: 3, pointsDraw: 1 }],
  rounds: [{ id: "r1", seasonId: "s1", no: 1, status: "settled" }],
  seats: [{ id: "t1", roundId: "r1", tableNo: 0, seatNo: 1, playerId: "u1", rank: 1, score: 5 }],
  penalties: []
});
let rep = validateImport(baseDoc());
assert(rep.errors.length === 0, `干净文档应通过: ${JSON.stringify(rep.errors)}`);

const dup = baseDoc();
dup.seats.push({ id: "t2", roundId: "r1", tableNo: 0, seatNo: 2, playerId: "u1", rank: 1, score: 4 });
rep = validateImport(dup);
assert(rep.errors.some((e) => e.code === "DUPLICATE_ENTRY"), "重复参赛者被检出");

const noFac = baseDoc();
noFac.players[0] = { ...noFac.players[0], factionId: "" };
rep = validateImport(noFac);
assert(rep.errors.length === 0 && rep.warnings.some((e) => e.code === "MISSING_FACTION"), "空阵营=中立，仅警告不阻断");
const danglingFac = baseDoc();
danglingFac.players[0] = { ...danglingFac.players[0], factionId: "f_ghost" };
rep = validateImport(danglingFac);
assert(rep.errors.some((e) => e.code === "MISSING_FACTION"), "悬空阵营引用是硬错误");

const badScore = baseDoc();
badScore.seats[0] = { ...badScore.seats[0], score: -3 };
rep = validateImport(badScore);
assert(rep.errors.some((e) => e.code === "BAD_SCORE"), "非法比分被检出");

const missingResult = baseDoc();
missingResult.seats[0] = { ...missingResult.seats[0], rank: null, score: null };
rep = validateImport(missingResult);
assert(rep.errors.some((e) => e.code === "MISSING_RESULT"), "已结算轮缺失比分/名次被检出");

const zeroRank = baseDoc();
zeroRank.seats[0] = { ...zeroRank.seats[0], rank: 0 };
rep = validateImport(zeroRank);
assert(rep.errors.some((e) => e.code === "BAD_SCORE"), "导入文件零名次被检出");

const dupSeat = baseDoc();
dupSeat.factions.push({ id: "f2", name: "B" });
dupSeat.players.push({ id: "u2", name: "Y", factionId: "f2", skill: 2 });
dupSeat.seats.push({ id: "t9", roundId: "r1", tableNo: 0, seatNo: 1, playerId: "u2", rank: 1, score: 5 });
rep = validateImport(dupSeat);
assert(rep.errors.some((e) => e.code === "DUPLICATE_SEAT"), "同桌同座号重复被检出");

const draftMissing = baseDoc();
draftMissing.rounds[0] = { ...draftMissing.rounds[0], status: "draft" };
draftMissing.seats[0] = { ...draftMissing.seats[0], rank: null, score: null };
rep = validateImport(draftMissing);
assert(rep.errors.length === 0, `草稿轮允许缺结果: ${JSON.stringify(rep.errors)}`);

const cyc = baseDoc();
cyc.rounds = [
  { id: "r1", seasonId: "s1", no: 1, status: "settled", derivedFromRoundId: "r2" },
  { id: "r2", seasonId: "s1", no: 2, status: "settled", derivedFromRoundId: "r1" }
];
rep = validateImport(cyc);
assert(rep.errors.some((e) => e.code === "CYCLE"), "循环引用被检出");

const broken = baseDoc();
delete broken.rounds;
rep = validateImport(broken);
assert(rep.errors.some((e) => e.code === "SCHEMA"), "结构破损被检出");

console.log(`\n${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
