// 真实浏览器走查：分桌、缺席替换、锁座、积分重算、非法流转、双页合并、撤销、导入回滚
// 运行：LD_LIBRARY_PATH=<本地库> node test/e2e/browser-walkthrough.mjs
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SHOTS = path.join(ROOT, "test/screenshots");
await mkdir(SHOTS, { recursive: true });

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };
const server = createServer(async (req, res) => {
  try {
    const url = req.url.split("?")[0];
    const file = path.join(ROOT, url === "/" ? "index.html" : url);
    if (!file.startsWith(ROOT)) return res.writeHead(403).end();
    const data = await readFile(file);
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(4173, r));

const results = [];
function check(name, cond, extra = "") {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? "✅" : "❌"} ${name}${extra && !cond ? ` — ${extra}` : ""}`);
}
const shot = async (page, name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto("http://localhost:4173/");
await page.waitForFunction(() => window.LEAGUE);

const $state = () => page.evaluate(() => window.LEAGUE.store.state);
const click = async (testid) => { await page.click(`[data-testid="${testid}"]`); await page.waitForTimeout(60); };
const gotoTab = async (name) => { await page.click(`#tabs button[data-tab="${name}"]`); await page.waitForTimeout(60); };

await gotoTab("round");

// ============ 1. 分桌（9 参赛者，3 阵营×2 + 3 无阵营，每桌 3-4）============
await shot(page, "01-seating");
let tableInfo = await page.evaluate(() =>
  [...document.querySelectorAll(".round-card .game-table")].map((t) => {
    const seats = [...t.querySelectorAll(".seat")];
    return { players: seats.map((li) => li.querySelector(".seat-name").textContent.trim()),
             factions: seats.map((li) => li.querySelector(".seat-faction").textContent.trim()) };
  })
);
check("分桌：自动生成 3 桌", tableInfo.length === 3, `实际 ${tableInfo.length}`);
check("分桌：每桌 3 人", tableInfo.every((t) => t.players.length === 3), JSON.stringify(tableInfo.map((t) => t.players.length)));
check("分桌：每桌阵营互斥", tableInfo.every((t) => {
  const f = t.factions.filter((x) => x !== "—");
  return new Set(f).size === f.length;
}));
check("分桌：9 人全部入座", tableInfo.reduce((n, t) => n + t.players.length, 0) === 9);

const roundId = (await $state()).rounds[0].id;

// ============ 2. 锁座不动（重排保留）============
const locked = await page.evaluate(() => {
  const seat = document.querySelector('.round-card .game-table[data-table="1"] .seat');
  return { seatId: seat.dataset.seat, tableNo: 1,
           name: seat.querySelector(".seat-name").textContent.trim(),
           seatNo: seat.querySelector(".seat-no").textContent.trim() };
});
await page.click('.game-table[data-table="1"] .seat .lock-btn');
await page.waitForTimeout(60);
await click("round-reseat");
let after = await page.evaluate((id) => {
  const st = window.LEAGUE.store.state.seats.find((x) => x.id === id);
  return { player: st.playerId, tableNo: st.tableNo, seatNo: st.seatNo, locked: st.locked };
}, locked.seatId);
const lockedPlayerName = await page.evaluate((pid) =>
  window.LEAGUE.store.state.players.find((p) => p.id === pid).name, after.player);
check("锁座：重排后桌号/座号/玩家不变", after.tableNo === 1 && String(after.seatNo) === locked.seatNo && lockedPlayerName === locked.name && after.locked,
  JSON.stringify({ locked, after, lockedPlayerName }));
await shot(page, "02-locked-seat");

// ============ 3. 缺席 + 人数失衡阻断（草稿期，开赛前编排）============
// 再锁第 3 桌一座，缺席一人 => 8 人却被锁在 3 桌 => 3/3/2 违反下限，阻断
await page.evaluate(() => document.querySelector('.round-card .game-table[data-table="2"] .seat .lock-btn').click());
await page.waitForTimeout(60);
const blockedToast = await page.evaluate(() => {
  const card = document.querySelector(".round-card");
  const row = [...card.querySelectorAll("details tbody tr")].find((tr) => tr.children[0].textContent.includes("年糕"));
  const sel = row.querySelector(".att-select");
  sel.value = "absent";
  sel.dispatchEvent(new Event("change", { bubbles: true }));
  return document.querySelector("#toast").textContent;
});
check("缺席失衡：8 人占 3 桌被阻断", /无法|阻断|失衡/.test(blockedToast), blockedToast);
let s = await $state();
check("缺席失衡：阻断后座位仍是 9 人布局", s.seats.filter((x) => x.roundId === roundId).length === 9);
await shot(page, "03-imbalance-blocked");

// 解锁全部（每次点击都会重绘，逐个重新查询）后 8 人可重排为 4/4
await page.evaluate(() => {
  let n = 0;
  while (document.querySelectorAll(".lock-btn.on").length && n < 10) {
    document.querySelector(".lock-btn.on").click();
    n++;
  }
});
await page.waitForTimeout(120);
await page.evaluate(() => {
  const card = document.querySelector(".round-card");
  const row = [...card.querySelectorAll("details tbody tr")].find((tr) => tr.children[0].textContent.includes("年糕"));
  const sel = row.querySelector(".att-select");
  sel.value = "absent"; sel.dispatchEvent(new Event("change", { bubbles: true }));
});
await page.waitForTimeout(100);
s = await $state();
const absentSeats = s.seats.filter((x) => x.roundId === roundId);
const absentTables = new Set(absentSeats.map((x) => x.tableNo));
check("缺席：缺席者不入座", !absentSeats.some((x) => x.playerId === s.players.find((p) => p.name === "年糕").id));
check("缺席：8 人重排为 2 桌 4/4", absentSeats.length === 8 && absentTables.size === 2 && [...absentTables].every((t) => absentSeats.filter((x) => x.tableNo === t).length === 4),
  `${absentSeats.length} 人 / ${absentTables.size} 桌`);

// 迟到到场恢复 9 人
await page.evaluate(() => {
  const card = document.querySelector(".round-card");
  const row = [...card.querySelectorAll("details tbody tr")].find((tr) => tr.children[0].textContent.includes("年糕"));
  const sel = row.querySelector(".att-select");
  sel.value = "present"; sel.dispatchEvent(new Event("change", { bubbles: true }));
});
await page.waitForTimeout(100);
s = await $state();
check("到场恢复：回到 9 人 3 桌", s.seats.filter((x) => x.roundId === roundId).length === 9);

// ============ 4. 替换 + 锁座保持，再撤销替换 ============
// 锁第 1 桌一个不是柯北的座位
await page.evaluate(() => {
  const card = document.querySelector(".round-card");
  const seat = [...card.querySelectorAll('.game-table[data-table="0"] .seat')]
    .find((li) => !li.querySelector(".seat-name").textContent.includes("柯北"));
  seat.querySelector(".lock-btn").click();
});
await page.waitForTimeout(60);
const subInfo = await page.evaluate(() => {
  const card = document.querySelector(".round-card");
  const row = [...card.querySelectorAll("details tbody tr")].find((tr) => tr.children[0].textContent.includes("柯北"));
  const sel = row.querySelector(".sub-select");
  const opt = [...sel.options].find((o) => o.textContent.includes("老K"));
  sel.value = opt.value; sel.dispatchEvent(new Event("change", { bubbles: true }));
  return { inPlayerId: opt.value };
});
await page.waitForTimeout(100);
s = await $state();
let rSeats = s.seats.filter((x) => x.roundId === roundId);
const subSeat = rSeats.find((x) => x.playerId === subInfo.inPlayerId);
check("替换：替补入座并记录原报名人", subSeat && subSeat.originalPlayerId === s.players.find((p) => p.name === "柯北").id, JSON.stringify(subSeat));
check("替换：被替换者不在座", !rSeats.some((x) => x.playerId === s.players.find((p) => p.name === "柯北").id));
check("替换重排：锁座仍在第 1 桌且锁定", rSeats.find((x) => x.locked)?.tableNo === 0);
await shot(page, "04-substitute");
// 撤销替换
await page.evaluate(() => {
  const card = document.querySelector(".round-card");
  const row = [...card.querySelectorAll("details tbody tr")].find((tr) => tr.children[0].textContent.includes("柯北"));
  row.querySelector('[data-action="undo-sub"]').click();
});
await page.waitForTimeout(100);
s = await $state();
check("撤销替换：柯北回到座位", s.seats.some((x) => x.roundId === roundId && x.playerId === s.players.find((p) => p.name === "柯北").id));

// ============ 5. 发布 / 撤销 / 非法跳跃 ============
await click("round-publish");
s = await $state();
check("发布：状态 published", s.rounds[0].status === "published");
check("发布：徽标显示已发布", (await page.textContent(".round-card .badge")).includes("已发布"));
await click("round-unpublish");
s = await $state();
check("撤销发布：回到 draft", s.rounds[0].status === "draft");
await click("round-publish");
s = await $state();
check("撤销后可重新发布", s.rounds[0].status === "published");
// 已发布轮不能删
const delPublished = await page.evaluate((rid) => window.LEAGUE.actions.deleteRound(rid), roundId);
check("非法流转：已发布轮不能直接删除", delPublished.ok === false);
// 草稿→结算跳跃
const jump = await page.evaluate((rid) => {
  const u = window.LEAGUE.actions.unpublishRound(rid);
  const st = window.LEAGUE.actions.settleRound(rid);
  return { unpublished: u.ok, settled: st.ok };
}, roundId);
check("非法流转：草稿→结算被阻断", jump.unpublished === true && jump.settled === false, JSON.stringify(jump));
s = await $state();
check("跳跃后仍是 draft", s.rounds[0].status === "draft");
// 回到发布态（赛程页点发布，再去赛果）
await page.click(`.round-card[data-round="${roundId}"] [data-action="publish"]`);
await page.waitForTimeout(80);

// ============ 6. 赛果：未录完阻断结算，录完结算 ============
await gotoTab("results");
await click("settle-here");
check("非法流转：未录完比分结算阻断", (await page.textContent("#toast")).includes("未填"));
s = await $state();
check("阻断后仍 published", s.rounds[0].status === "published");
const filled = await page.evaluate(() => {
  let n = 0;
  for (const t of document.querySelectorAll(".results-tables .game-table")) {
    [...t.querySelectorAll("tbody tr")].forEach((row, i) => {
      const sc = row.querySelector(".score-input"), rk = row.querySelector(".rank-input");
      sc.value = String(10 - i); sc.dispatchEvent(new Event("input", { bubbles: true }));
      rk.value = String(i + 1); rk.dispatchEvent(new Event("input", { bubbles: true }));
      n++;
    });
  }
  return n;
});
check("赛果：9 个座位全部录入", filled === 9, `实际 ${filled}`);
// 实时积分预览：第一名显示胜局分
const preview = await page.textContent('.pts-cell[data-rank-for]');
check("赛果：名次积分实时预览", /3/.test(preview), preview);
await shot(page, "05-results-filled");
await click("settle-here");
s = await $state();
check("结算：状态 settled", s.rounds[0].status === "settled", await page.textContent("#toast"));
// 已结算不能重排/改出席
check("已结算：重排被阻断", (await page.evaluate((rid) => window.LEAGUE.actions.reseat(rid), roundId)).ok === false);

// ============ 7. 积分榜 + 处罚 ============
await gotoTab("standings");
await shot(page, "06-standings");
let rows = await page.evaluate(() => [...document.querySelectorAll('[data-testid="standings-table"] tbody tr')].map((tr) => [...tr.children].map((td) => td.textContent.trim())));
check("积分榜：9 人", rows.length === 9);
check("积分榜：三个各桌第一均 3 分", rows.filter((r) => r[7] === "3").length === 3, rows.map((r) => r[7]).join(","));
const leader = rows[0][1];
await gotoTab("results");
await page.selectOption("#penaltyPlayer", { label: leader });
await page.fill("#penaltyPoints", "2");
await page.fill("#penaltyReason", "超时犯规");
await click("penalty-add");
await gotoTab("standings");
rows = await page.evaluate(() => [...document.querySelectorAll('[data-testid="standings-table"] tbody tr')].map((tr) => [...tr.children].map((td) => td.textContent.trim())));
const leaderRow = rows.find((r) => r[1] === leader);
check("处罚：3 − 2 = 1 并即时重算排名", leaderRow[7] === "1" && leaderRow[6] === "−2", JSON.stringify(leaderRow));

// ============ 8a. 非法更正：负分 / 零名次 / 缺失 / 断档，全部阻断并回滚 ============
await gotoTab("results");
await page.selectOption('[data-testid="results-round"]', { index: 0 });
await page.waitForTimeout(60);
const auditCount = () => page.evaluate(() => window.LEAGUE.store.state.audit.length);
const auditN0 = await auditCount();
const targetSeats = await page.evaluate(() => {
  const t = document.querySelector(".results-tables .game-table");
  return [...t.querySelectorAll("tbody tr")].map((tr) => {
    const score = tr.querySelector(".score-input");
    return { id: score.dataset.seat, name: tr.children[0].textContent.trim() };
  });
});
const correctViaUI = async (seatId, field, value) =>
  page.evaluate(({ seatId, field, value }) => {
    const input = document.querySelector(`.${field}-input[data-seat="${seatId}"]`);
    input.focus();
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.blur(); // blur 原生触发 focusout
    return document.querySelector("#toast").textContent;
  }, { seatId, field, value });
const seatInStore = (id) => page.evaluate((sid) => {
  const s = window.LEAGUE.store.state.seats.find((x) => x.id === sid);
  return { score: s.score, rank: s.rank };
}, id);

// 负比分（input 阶段即被拒，旧值保留）
const s0Before = await seatInStore(targetSeats[0].id);
let toastMsg = await correctViaUI(targetSeats[0].id, "score", "-5");
check("非法更正：负比分被阻断", /拒绝|比分必须|恢复/.test(toastMsg), toastMsg);
const s0After = await seatInStore(targetSeats[0].id);
check("非法更正：负比分回滚为原值", s0After.score === s0Before.score, `${s0Before.score}→${s0After.score}`);

// 零名次
const s1Before = await seatInStore(targetSeats[1].id);
toastMsg = await correctViaUI(targetSeats[1].id, "rank", "0");
check("非法更正：零名次被阻断", /拒绝|名次|恢复/.test(toastMsg), toastMsg);
const s1After = await seatInStore(targetSeats[1].id);
check("非法更正：零名次回滚为原值", s1After.rank === s1Before.rank, `${s1Before.rank}→${s1After.rank}`);

// 缺失结果：清空名次
const s2Before = await seatInStore(targetSeats[2].id);
toastMsg = await correctViaUI(targetSeats[2].id, "rank", "");
check("非法更正：缺失名次被阻断", /拒绝|未填|恢复/.test(toastMsg), toastMsg);
const s2After = await seatInStore(targetSeats[2].id);
check("非法更正：缺失名次回滚为原值", s2After.rank === s2Before.rank, `${s2Before.rank}→${s2After.rank}`);

// 名次断档：第 2 名改成 3（1,3,3）
toastMsg = await correctViaUI(targetSeats[1].id, "rank", "3");
check("非法更正：名次断档被阻断", /断档|拒绝|恢复/.test(toastMsg), toastMsg);
check("非法更正：断档回滚为原值", (await seatInStore(targetSeats[1].id)).rank === s1Before.rank);

// 没有任何更正审计产生
check("非法更正：不写入审计", (await auditCount()) === auditN0, `${auditN0}→${await auditCount()}`);
// 积分榜仍按原值正常显示
await gotoTab("standings");
rows = await page.evaluate(() => [...document.querySelectorAll('[data-testid="standings-table"] tbody tr')].map((tr) => [...tr.children].map((td) => td.textContent.trim())));
check("非法更正：积分榜仍正常（9 行、首行有总分）", rows.length === 9 && rows[0][7] !== "", JSON.stringify(rows[0]));
await shot(page, "07a-correction-blocked");

// ============ 8. 更正旧赛果（合法）→ 审计 + 重算 ============
await gotoTab("results");
await page.selectOption('[data-testid="results-round"]', { index: 0 });
await page.waitForTimeout(60);
const corrected = await page.evaluate(() => {
  const t = document.querySelector(".results-tables .game-table");
  const second = t.querySelectorAll("tbody tr")[1];
  const rk = second.querySelector(".rank-input");
  rk.focus(); rk.value = "1"; rk.dispatchEvent(new Event("input", { bubbles: true })); rk.blur();
  const aud = [...window.LEAGUE.store.state.audit].reverse().find((a) => a.action === "更正赛果");
  return { who: second.children[0].textContent.trim(), audit: aud?.detail || null };
});
await page.waitForTimeout(100);
check("合法更正：写入审计", !!corrected.audit, "无更正审计");
check("合法更正：详情含前后名次", /名次/.test(corrected.audit || ""), corrected.audit);
check("合法更正：审计条数增加", (await auditCount()) === auditN0 + 1, `${auditN0}→${await auditCount()}`);
await gotoTab("standings");
shot(page, "07-recalculated");
rows = await page.evaluate(() => [...document.querySelectorAll('[data-testid="standings-table"] tbody tr')].map((tr) => [...tr.children].map((td) => td.textContent.trim())));
const correctedRow = rows.find((r) => r[1] === corrected.who);
check("合法更正：该玩家拿到平局分 1（后续已重算）", correctedRow[5] === "1", JSON.stringify(correctedRow));

// ============ 9. 第 2 轮：不重复同桌自动分桌 ============
await gotoTab("round");
await page.fill("#roundName", "第 2 轮");
await click("round-create");
s = await $state();
const r2 = s.rounds.find((r) => r.no === 2);
check("第 2 轮：创建成功（避免与第 1 轮重复同桌）", !!r2, "无第 2 轮");
if (r2) {
  const r2seats = s.seats.filter((x) => x.roundId === r2.id);
  check("第 2 轮：9 人 3 桌", r2seats.length === 9 && new Set(r2seats.map((x) => x.tableNo)).size === 3, `${r2seats.length} 座`);
  // 验证确实没有重复同桌
  const pairRepeated = await page.evaluate((rid) => {
    const { store } = window.LEAGUE;
    const st = store.state;
    const pairs = (seats) => {
      const byT = new Map();
      seats.forEach((x) => { if (!byT.has(x.tableNo)) byT.set(x.tableNo, []); byT.get(x.tableNo).push(x.playerId); });
      const ps = new Set();
      for (const v of byT.values()) for (let i = 0; i < v.length; i++) for (let j = i + 1; j < v.length; j++) ps.add([v[i], v[j]].sort().join("|"));
      return ps;
    };
    const r1id = st.rounds.find((r) => r.no === 1).id;
    const p1 = pairs(st.seats.filter((x) => x.roundId === r1id));
    const p2 = pairs(st.seats.filter((x) => x.roundId === rid));
    return [...p2].filter((x) => p1.has(x));
  }, r2.id);
  check("第 2 轮：零重复同桌", pairRepeated.length === 0, `${pairRepeated.length} 对重复`);
}
await shot(page, "08-round2");

// ============ 10. 双页合并与冲突 ============
const pageB = await context.newPage();
await pageB.goto("http://localhost:4173/");
await pageB.waitForFunction(() => window.LEAGUE);
await pageB.waitForTimeout(300);

// 10a 各加不同玩家 → 自动合并
await gotoTab("people");
await pageB.click('#tabs button[data-tab="people"]');
await pageB.fill("#playerName", "页面B玩家");
await pageB.selectOption("#playerFaction", { index: 1 });
await pageB.click('[data-testid="player-add"]');
await pageB.waitForTimeout(150);
await page.fill("#playerName", "页面A玩家");
await page.selectOption("#playerFaction", { index: 2 });
await page.click('[data-testid="player-add"]');
await page.waitForTimeout(200);
s = await $state();
check("双页合并：两边新增玩家自动合流", s.players.some((p) => p.name === "页面A玩家") && s.players.some((p) => p.name === "页面B玩家"),
  s.players.map((p) => p.name).join(","));

// 10b 同实体双改 → 冲突，不静默覆盖
const commonId = await page.evaluate(() => window.LEAGUE.store.state.players.find((p) => p.name === "豆豆").id);
await page.evaluate((id) => {
  window.LEAGUE.store.beginIsolation();
  window.LEAGUE.actions.updatePlayer(id, { skill: 5 });
}, commonId);
await pageB.evaluate((id) => window.LEAGUE.actions.updatePlayer(id, { skill: 1 }), commonId);
await pageB.waitForTimeout(150);
await page.evaluate(() => {
  window.LEAGUE.store.endIsolation();
  window.LEAGUE.actions.createFaction("冲突探针阵营");
});
await page.waitForTimeout(200);
check("双页冲突：同玩家双改弹冲突条", await page.locator("#conflictBar").isVisible());
await shot(page, "09-conflict");
const storedWhilePending = await page.evaluate(() => JSON.parse(localStorage.getItem("league-console/v1")).players.find((p) => p.name === "豆豆").skill);
check("冲突未决：存储保持对端值，本地未静默覆盖", storedWhilePending === 1, `实际 ${storedWhilePending}`);
await page.click('[data-testid="keep-local"]');
await page.waitForTimeout(150);
const resolvedA = (await $state()).players.find((p) => p.name === "豆豆").skill;
const resolvedStored = await page.evaluate(() => JSON.parse(localStorage.getItem("league-console/v1")).players.find((p) => p.name === "豆豆").skill);
check("冲突解决：选本页 → 值为 5 并落盘", resolvedA === 5 && resolvedStored === 5, `${resolvedA}/${resolvedStored}`);
await pageB.reload();
await pageB.waitForFunction(() => window.LEAGUE);
check("对端刷新后同步解决结果", await pageB.evaluate(() => window.LEAGUE.store.state.players.find((p) => p.name === "豆豆").skill) === 5);

// 10c 对端改别的，本页刷新可见
await pageB.evaluate(() => {
  window.LEAGUE.store.commit((d) => {
    d.factions[0].name = d.factions[0].name + "·修订";
    return { id: "x1", at: new Date().toISOString(), action: "阵营改名", target: d.factions[0].id, detail: "对端修改", rev: 0 };
  });
});
await page.reload();
await page.waitForFunction(() => window.LEAGUE);
check("刷新合并：对端修改刷新可见", (await page.evaluate(() => window.LEAGUE.store.state.factions[0].name)).endsWith("·修订"));
await pageB.close();

// ============ 11. 导入回滚 ============
await gotoTab("io");
const beforeCount = (await $state()).players.length;
const round1Id = (await $state()).rounds.find((r) => r.no === 1).id;
const badDoc = await page.evaluate((rid) => {
  const s = window.LEAGUE.store.state;
  const doc = { schema: "league-console/v1", seasons: s.seasons, players: s.players.map((p) => ({ ...p })),
    factions: s.factions, rounds: s.rounds.map((r) => ({ ...r })), seats: s.seats.map((x) => ({ ...x })), penalties: s.penalties };
  const r1 = doc.seats.filter((x) => x.roundId === rid);
  doc.seats.push({ ...doc.seats[0], id: "dup_entry", seatNo: 99 });        // 重复参赛者
  doc.players[0] = { ...doc.players[0], factionId: "fac_does_not_exist" }; // 悬空阵营引用
  doc.seats[1] = { ...doc.seats[1], score: -42 };                          // 非法比分
  const seatedIds = new Set(r1.map((x) => x.playerId));
  const outsider = doc.players.find((p) => !seatedIds.has(p.id));
  doc.seats.push({ ...r1[0], id: "dup_pos", playerId: outsider.id, originalPlayerId: null, rank: 1, score: 5 }); // 同桌同座号重复
  doc.seats[2] = { ...doc.seats[2], rank: null, score: null };             // 已结算轮缺失结果
  doc.rounds[0] = { ...doc.rounds[0], derivedFromRoundId: doc.rounds[1].id };
  doc.rounds[1] = { ...doc.rounds[1], derivedFromRoundId: doc.rounds[0].id }; // 循环引用
  return doc;
}, round1Id);
const badPath = path.join(SHOTS, "bad-import.json");
await writeFile(badPath, JSON.stringify(badDoc));
await page.setInputFiles('[data-testid="import-file"]', badPath);
await page.waitForTimeout(150);
const report = await page.textContent('[data-testid="import-report"]');
for (const code of ["DUPLICATE_ENTRY", "DUPLICATE_SEAT", "MISSING_FACTION", "BAD_SCORE", "MISSING_RESULT", "CYCLE"]) {
  check(`导入报告：检出 ${code}`, report.includes(code), report.slice(0, 300));
}
const applyHandle = await page.$('[data-testid="import-apply"]');
check("失败导入：应用按钮禁用", !(await applyHandle.isEnabled()));
check("失败导入：现有数据不被覆盖（玩家数不变）", (await $state()).players.length === beforeCount, `${beforeCount}→${(await $state()).players.length}`);
check("失败导入：非法比分未入库", !(await $state()).seats.some((x) => x.score === -42));
check("失败导入：重复座号未入库", (await $state()).seats.filter((x) => x.id === "dup_pos").length === 0);
const round1Intact = await page.evaluate((rid) => {
  const list = window.LEAGUE.store.state.seats.filter((x) => x.roundId === rid);
  return list.length > 0 && list.every((x) => Number.isInteger(x.rank) && Number.isInteger(x.score));
}, round1Id);
check("失败导入：缺失结果未影响原赛果（第 1 轮结果仍完整）", round1Intact);
await shot(page, "10-import-blocked");

// 单独：名次断档导入（1,3,3）
const gapDoc = await page.evaluate((rid) => {
  const s = window.LEAGUE.store.state;
  const doc = { schema: "league-console/v1", seasons: s.seasons, players: s.players, factions: s.factions,
    rounds: s.rounds.map((r) => ({ ...r })), seats: s.seats.map((x) => ({ ...x })), penalties: s.penalties };
  const list = doc.seats.filter((x) => x.roundId === rid).sort((a, b) => a.tableNo - b.tableNo || a.seatNo - b.seatNo);
  list[0].rank = 1; list[1].rank = 3; list[2].rank = 3;
  return doc;
}, round1Id);
const gapPath = path.join(SHOTS, "gap-import.json");
await writeFile(gapPath, JSON.stringify(gapDoc));
await page.setInputFiles('[data-testid="import-file"]', gapPath);
await page.waitForTimeout(150);
const gapReport = await page.textContent('[data-testid="import-report"]');
check("导入报告：检出名次断档", gapReport.includes("断档") && gapReport.includes("BAD_SCORE"), gapReport.slice(0, 200));
check("断档导入：现有数据不变", (await $state()).players.length === beforeCount);

await page.setInputFiles('[data-testid="import-file"]', { name: "x.json", mimeType: "application/json", buffer: Buffer.from("{broken") });
await page.waitForTimeout(100);
check("导入：非法 JSON 被拦", (await page.textContent('[data-testid="import-report"]')).includes("不是合法 JSON"));

// 合法导出再导入
const exportDoc = await page.evaluate(() => {
  const s = window.LEAGUE.store.state;
  return { schema: "league-console/v1", seasons: s.seasons, players: s.players, factions: s.factions, rounds: s.rounds, seats: s.seats, penalties: s.penalties };
});
const goodPath = path.join(SHOTS, "good-import.json");
await writeFile(goodPath, JSON.stringify(exportDoc));
await page.setInputFiles('[data-testid="import-file"]', goodPath);
await page.waitForTimeout(150);
await page.click('[data-testid="import-apply"]');
await page.waitForTimeout(150);
check("合法导入：成功", (await page.textContent("#toast")).includes("导入成功"));
s = await $state();
check("合法导入：审计追加", s.audit.some((a) => a.action === "导入数据"));
check("合法导入：数据量一致", s.players.length === beforeCount && s.rounds.length === 2);
await shot(page, "11-import-ok");

// ============ 12. 审计留证 ============
await gotoTab("audit");
await shot(page, "12-audit");
const auditText = await page.textContent("#tab-audit");
for (const word of ["发布赛程", "撤销发布", "结算轮次", "更正赛果", "替补换人", "撤销替补", "追加处罚", "导入数据", "锁定座位", "出席变更"]) {
  check(`审计包含：${word}`, auditText.includes(word));
}

check("浏览器控制台无未捕获错误", errors.length === 0, errors.join(" | "));

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
await browser.close();
server.close();
process.exit(failed.length ? 1 : 0);
