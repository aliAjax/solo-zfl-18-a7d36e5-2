// UI 层：渲染与事件分发
import { $, $$, esc, download, intOrNull } from "./util.js";
import { store } from "./store.js";
import * as A from "./actions.js";
import {
  ROUND_STATUS,
  seasonParticipants,
  seasonRounds,
  roundSeats,
  computeStandings,
  validateImport,
  seatRound
} from "./domain.js";

let activeTab = "season";
let resultsRoundId = "";
let stagedImport = null;

// ---------- 提示 ----------
let toastTimer;
function toast(msg, kind = "ok") {
  const el = $("#toast");
  el.textContent = msg;
  el.className = `toast ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 3200);
}
function handle(result, okMsg) {
  if (result?.ok === false) {
    toast((result.errors || ["操作失败"]).join("；"), "err");
    return false;
  }
  if (result?.conflicts?.length) {
    toast("与另一页面的修改冲突，请在顶部选择保留版本", "warn");
    return false;
  }
  if (okMsg) toast(okMsg);
  render();
  return true;
}
function run(fn, okMsg) {
  try {
    return handle(fn(), okMsg);
  } catch (err) {
    toast(err.message, "err");
    return false;
  }
}

// ---------- 赛季 ----------
function renderSeason() {
  const s = store.state;
  const season = s.seasons.find((x) => x.id === s.selectedSeasonId);
  const participants = season ? seasonParticipants(s, season) : [];
  return `
    <div class="grid-2">
      <div class="panel">
        <h2>新建赛季</h2>
        <form id="seasonForm" class="form">
          <label>赛季名称 <input id="seasonName" required placeholder="例：2026 秋季联赛" /></label>
          <label>比赛游戏 <input id="seasonGame" required placeholder="例：璀璨宝石" /></label>
          <div class="split">
            <label>每桌最少 <input id="seasonMin" type="number" min="2" max="6" value="3" /></label>
            <label>每桌最多 <input id="seasonMax" type="number" min="2" max="8" value="4" /></label>
          </div>
          <div class="split">
            <label>胜局分 <input id="seasonWinPts" type="number" value="3" /></label>
            <label>平局分 <input id="seasonDrawPts" type="number" value="1" /></label>
          </div>
          <button class="primary" type="submit" data-testid="season-create">创建赛季</button>
        </form>
      </div>
      <div class="panel">
        <h2>赛季列表</h2>
        <select id="seasonSelect" data-testid="season-select">
          ${s.seasons.map((x) => `<option value="${x.id}" ${x.id === s.selectedSeasonId ? "selected" : ""}>${esc(x.name)}（${esc(x.game)}）</option>`).join("")}
        </select>
        ${
          season
            ? `<div class="season-detail">
                 <p>${esc(season.game)} · 每桌 ${season.minSize}-${season.maxSize} 人 · 胜 ${season.pointsWin} 分 / 平 ${season.pointsDraw} 分</p>
                 <h3>参赛者勾选（${participants.length} 人）</h3>
                 <div class="check-grid" id="participantGrid">
                   ${s.players
                     .map(
                       (p) => `<label class="check"><input type="checkbox" class="participant-check" data-player="${p.id}" ${
                         participants.some((x) => x.id === p.id) ? "checked" : ""
                       } /> ${esc(p.name)} <small>${esc(s.factions.find((f) => f.id === p.factionId)?.name || "无阵营")} · 熟练${p.skill}</small></label>`
                     )
                     .join("") || "<p class='empty'>先在「玩家与阵营」里添加玩家</p>"}
                 </div>
               </div>`
            : `<p class="empty">还没有赛季。</p>`
        }
      </div>
    </div>`;
}

// ---------- 玩家与阵营 ----------
function renderPeople() {
  const s = store.state;
  return `
    <div class="grid-2">
      <div class="panel">
        <h2>阵营</h2>
        <form id="factionForm" class="inline-form">
          <input id="factionName" required placeholder="阵营名，例：红雀会" />
          <button class="primary" type="submit" data-testid="faction-add">添加阵营</button>
        </form>
        <ul class="chip-list">
          ${s.factions.map((f) => `<li class="chip" data-faction="${f.id}">${esc(f.name)} <small>${s.players.filter((p) => p.factionId === f.id).length}人</small></li>`).join("") || "<li class='empty'>暂无阵营</li>"}
        </ul>
        <h2 style="margin-top:18px">新增玩家</h2>
        <form id="playerForm" class="form">
          <label>昵称 <input id="playerName" required placeholder="例：阿十" /></label>
          <div class="split">
            <label>熟练度
              <select id="playerSkill">
                <option value="1">1 新手</option><option value="2">2</option>
                <option value="3" selected>3 一般</option><option value="4">4</option>
                <option value="5">5 老手</option>
              </select>
            </label>
            <label>阵营
              <select id="playerFaction">
                <option value="">（无阵营）</option>
                ${s.factions.map((f) => `<option value="${f.id}">${esc(f.name)}</option>`).join("")}
              </select>
            </label>
          </div>
          <button class="primary" type="submit" data-testid="player-add">添加玩家</button>
        </form>
      </div>
      <div class="panel">
        <h2>玩家名册（${s.players.length}）</h2>
        <table class="data-table">
          <thead><tr><th>昵称</th><th>熟练度</th><th>阵营</th><th></th></tr></thead>
          <tbody>
            ${s.players
              .map(
                (p) => `<tr class="player-row" data-player="${p.id}">
                  <td>${esc(p.name)}</td>
                  <td><select class="skill-edit" data-testid="skill-edit">${[1, 2, 3, 4, 5]
                    .map((n) => `<option value="${n}" ${n === p.skill ? "selected" : ""}>${n}</option>`)
                    .join("")}</select></td>
                  <td><select class="faction-edit">
                    <option value="">无</option>
                    ${s.factions.map((f) => `<option value="${f.id}" ${f.id === p.factionId ? "selected" : ""}>${esc(f.name)}</option>`).join("")}
                  </select></td>
                  <td><small class="rev-tag">rev ${p.rev || 1}</small></td>
                </tr>`
              )
              .join("") || "<tr><td colspan='4' class='empty'>暂无玩家</td></tr>"}
          </tbody>
        </table>
      </div>
    </div>`;
}

// ---------- 赛程与桌次 ----------
const STATUS_LABEL = { draft: "草稿", published: "已发布", settled: "已结算" };

function renderRound() {
  const s = store.state;
  const season = s.seasons.find((x) => x.id === s.selectedSeasonId);
  if (!season) return wrapEmpty("先在「赛季」页创建并选择一个赛季");
  const participants = seasonParticipants(s, season);
  if (!participants.length) return wrapEmpty("该赛季还没有参赛者，请在赛季页勾选");
  const rounds = seasonRounds(s, season.id);

  return `
    <div class="panel">
      <div class="panel-head">
        <h2>${esc(season.name)} · 赛程</h2>
        <form id="roundCreateForm" class="inline-form">
          <input id="roundName" placeholder="轮次名（可空）" />
          <button class="primary" type="submit" data-testid="round-create">新建轮次并自动分桌</button>
        </form>
      </div>
      <p class="hint">规则：每桌 ${season.minSize}-${season.maxSize} 人且桌差 ≤ 1；同阵营不同桌；尽量熟练度均衡；已发布过的同桌组合不会再次同桌（重复同桌阻断）。</p>
      <div class="round-list">
        ${rounds.map((r) => renderRoundCard(s, season, r)).join("") || "<p class='empty'>还没有轮次。</p>"}
      </div>
    </div>`;
}

function renderRoundCard(s, season, round) {
  const seats = roundSeats(s, round.id);
  const byTable = new Map();
  seats.forEach((st) => {
    if (!byTable.has(st.tableNo)) byTable.set(st.tableNo, []);
    byTable.get(st.tableNo).push(st);
  });
  const participants = seasonParticipants(s, season);
  const att = round.attendance || {};
  const subs = round.substitutions || [];
  const canEdit = round.status !== "settled";
  const actions = `
    <div class="round-actions">
      ${round.status === "draft" ? `<button data-action="publish" data-testid="round-publish">发布赛程</button>` : ""}
      ${round.status === "published" ? `<button data-action="unpublish" data-testid="round-unpublish">撤销发布</button>` : ""}
      ${round.status === "published" ? `<button class="primary" data-action="settle" data-testid="round-settle">结算</button>` : ""}
      ${canEdit ? `<button data-action="reseat" data-testid="round-reseat">重排（保留锁座）</button>` : ""}
      ${round.status === "draft" ? `<button class="danger" data-action="delete">删除轮次</button>` : ""}
      <a class="linkbtn" href="#" data-action="go-results">去录赛果 →</a>
    </div>`;
  return `
    <article class="round-card" data-round="${round.id}">
      <div class="round-head">
        <h3>${esc(round.name)} <span class="badge ${round.status}">${STATUS_LABEL[round.status]}</span></h3>
        ${actions}
      </div>
      <div class="round-controls">
        <details ${Object.keys(att).length || subs.length ? "open" : ""}>
          <summary>迟到 / 缺席 / 替换</summary>
          <table class="data-table compact">
            <thead><tr><th>报名玩家</th><th>出席</th><th>替补（替换为）</th><th></th></tr></thead>
            <tbody>
              ${participants
                .map((p) => {
                  const sub = subs.find((x) => x.outPlayerId === p.id);
                  const status = att[p.id] || (sub ? "substitute" : "present");
                  const usedIns = new Set(subs.map((x) => x.inPlayerId));
                  return `<tr data-player="${p.id}">
                    <td>${esc(p.name)}</td>
                    <td><select class="att-select" data-testid="attendance">
                      <option value="present" ${status === "present" ? "selected" : ""}>到场</option>
                      <option value="late" ${status === "late" ? "selected" : ""}>迟到（暂不入座）</option>
                      <option value="absent" ${status === "absent" ? "selected" : ""}>缺席</option>
                      ${sub ? `<option value="substitute" selected>已被替换</option>` : ""}
                    </select></td>
                    <td><select class="sub-select" ${!canEdit ? "disabled" : ""}>
                      <option value="">（不替换）</option>
                      ${s.players
                        .filter((q) => q.id !== p.id && !participants.some((x) => x.id === q.id) && (!usedIns.has(q.id) || sub?.inPlayerId === q.id))
                        .map((q) => `<option value="${q.id}" ${sub?.inPlayerId === q.id ? "selected" : ""}>${esc(q.name)}</option>`)
                        .join("")}
                    </select></td>
                    <td>${sub ? `<button data-action="undo-sub">撤销替换</button>` : ""}</td>
                  </tr>`;
                })
                .join("")}
            </tbody>
          </table>
        </details>
      </div>
      <div class="tables">
        ${[...byTable.keys()]
          .sort()
          .map((t) => {
            const list = byTable.get(t).sort((a, b) => a.seatNo - b.seatNo);
            const avg = (list.reduce((sum, x) => sum + (s.players.find((p) => p.id === x.playerId)?.skill || 0), 0) / list.length).toFixed(1);
            return `<div class="game-table" data-table="${t}">
              <header>第 ${t + 1} 桌 <small>${list.length}人 · 均熟练 ${avg}</small></header>
              <ul class="seat-list">
                ${list
                  .map((st) => {
                    const p = s.players.find((x) => x.id === st.playerId);
                    const f = s.factions.find((x) => x.id === p?.factionId);
                    const isSub = !!st.originalPlayerId;
                    const orig = isSub ? s.players.find((x) => x.id === st.originalPlayerId) : null;
                    return `<li class="seat ${st.locked ? "locked" : ""}" data-seat="${st.id}">
                      <span class="seat-no">${st.seatNo}</span>
                      <span class="seat-name">${esc(p?.name || "?")}${isSub ? ` <small>替 ${esc(orig?.name || "")}</small>` : ""}</span>
                      <span class="seat-faction">${esc(f?.name || "—")}</span>
                      <span class="seat-skill">熟练 ${p?.skill ?? "-"}</span>
                      <button class="lock-btn ${st.locked ? "on" : ""}" data-action="lock" ${!canEdit ? "disabled" : ""} data-testid="lock-seat" title="锁定后重排不动此座">${st.locked ? "🔒已锁" : "🔓"}</button>
                    </li>`;
                  })
                  .join("")}
              </ul>
            </div>`;
          })
          .join("")}
      </div>
    </article>`;
}

function wrapEmpty(msg) {
  return `<div class="panel"><p class="empty">${esc(msg)}</p></div>`;
}

// ---------- 赛果 ----------
function renderResults() {
  const s = store.state;
  const season = s.seasons.find((x) => x.id === s.selectedSeasonId);
  if (!season) return wrapEmpty("先选择赛季");
  const rounds = seasonRounds(s, season.id).filter((r) => r.status !== "draft");
  if (!rounds.length) return wrapEmpty("还没有已发布的轮次");
  if (!resultsRoundId || !rounds.some((r) => r.id === resultsRoundId)) resultsRoundId = rounds[rounds.length - 1].id;
  const round = rounds.find((r) => r.id === resultsRoundId);
  const seats = roundSeats(s, round.id);
  const byTable = new Map();
  seats.forEach((st) => {
    if (!byTable.has(st.tableNo)) byTable.set(st.tableNo, []);
    byTable.get(st.tableNo).push(st);
  });
  const penalties = s.penalties.filter((p) => p.roundId === round.id);
  const readOnly = round.status === "settled";

  return `
    <div class="panel">
      <div class="panel-head">
        <h2>赛果录入</h2>
        <select id="resultsRound" data-testid="results-round">
          ${rounds.map((r) => `<option value="${r.id}" ${r.id === round.id ? "selected" : ""}>${esc(r.name)}（${STATUS_LABEL[r.status]}）</option>`).join("")}
        </select>
      </div>
      ${readOnly ? `<p class="hint warn-hint">该轮已结算。现在修改属于<b>更正旧赛果</b>，会写入审计日志并立即重算之后各轮积分榜。</p>` : `<p class="hint">每桌填写游戏分（非负整数）与名次（1 起，并列填同名次）。全部合法后才能结算。</p>`}
      <div class="tables results-tables">
        ${[...byTable.keys()].sort().map((t) => {
          const list = byTable.get(t).sort((a, b) => a.seatNo - b.seatNo);
          return `<div class="game-table" data-table="${t}">
            <header>第 ${t + 1} 桌</header>
            <table class="data-table compact">
              <thead><tr><th>玩家</th><th>游戏分</th><th>名次</th><th>当轮积分</th></tr></thead>
              <tbody>
                ${list
                  .map((st) => {
                    const p = s.players.find((x) => x.id === st.playerId);
                    return `<tr>
                      <td>${esc(p?.name || "?")}</td>
                      <td><input class="score-input" data-seat="${st.id}" data-testid="score-input" type="number" min="0" step="1" value="${st.score ?? ""}" ${st.attendance === "absent" ? "disabled" : ""} /></td>
                      <td><input class="rank-input" data-seat="${st.id}" data-testid="rank-input" type="number" min="1" step="1" value="${st.rank ?? ""}" ${st.attendance === "absent" ? "disabled" : ""} /></td>
                      <td class="pts-cell" data-rank-for="${st.id}">—</td>
                    </tr>`;
                  })
                  .join("")}
              </tbody>
            </table>
          </div>`;
        }).join("")}
      </div>
      <h3 style="margin-top:16px">处罚</h3>
      <form id="penaltyForm" class="inline-form">
        <select id="penaltyPlayer">
          ${seats.map((st) => `<option value="${st.playerId}">${esc(s.players.find((p) => p.id === st.playerId)?.name || "")}</option>`).join("")}
        </select>
        <input id="penaltyPoints" type="number" min="1" value="1" style="max-width:110px" title="扣几分" />
        <input id="penaltyReason" placeholder="原因（可选）" />
        <button type="submit" data-testid="penalty-add">登记处罚</button>
      </form>
      <ul class="chip-list">
        ${penalties
          .map(
            (p) => `<li class="chip danger">${esc(s.players.find((x) => x.id === p.playerId)?.name || "")} −${p.points} ${esc(p.reason || "")}
              <button class="mini" data-action="del-penalty" data-penalty="${p.id}">撤销</button></li>`
          )
          .join("") || "<li class='empty'>暂无处罚</li>"}
      </ul>
      <div class="round-actions" style="margin-top:14px">
        ${round.status === "published" ? `<button class="primary" data-action="settle-here" data-testid="settle-here">校验并结算本轮</button>` : ""}
        ${round.status === "settled" ? `<span class="badge settled">已结算 · ${(round.settledAt || "").slice(0, 10)}</span>` : ""}
      </div>
    </div>`;
}

// ---------- 积分榜 ----------
function renderStandings() {
  const s = store.state;
  const season = s.seasons.find((x) => x.id === s.selectedSeasonId);
  if (!season) return wrapEmpty("先选择赛季");
  const rows = computeStandings(s, season.id);
  const settledRounds = seasonRounds(s, season.id).filter((r) => r.status === "settled");
  return `
    <div class="panel">
      <div class="panel-head"><h2>${esc(season.name)} · 积分榜</h2><span class="hint">已结算 ${settledRounds.length} 轮</span></div>
      <table class="data-table standings" data-testid="standings-table">
        <thead><tr><th>名次</th><th>玩家</th><th>阵营</th><th>出场</th><th>胜</th><th>名次分</th><th>处罚</th><th>总积分</th><th>对手分</th><th>游戏分</th></tr></thead>
        <tbody>
          ${rows
            .map(
              (r) => `<tr>
                <td><b>${r.rank}</b></td>
                <td>${esc(r.name)}</td>
                <td>${esc(s.factions.find((f) => f.id === r.factionId)?.name || "—")}</td>
                <td>${r.appearances}</td><td>${r.wins}</td>
                <td>${r.resultPoints}</td><td class="neg">${r.penalties ? "−" + r.penalties : ""}</td>
                <td><b>${r.total}</b></td><td>${r.buchholz}</td><td>${r.score}</td>
              </tr>`
            )
            .join("") || "<tr><td colspan='10' class='empty'>还没有结算轮次</td></tr>"}
        </tbody>
      </table>
      <p class="hint">破同分顺序：总积分 → 并列者相互战绩 → 对手分（Buchholz）→ 游戏总分 → 处罚少者。</p>
    </div>`;
}

// ---------- 审计 ----------
function renderAudit() {
  const s = store.state;
  return `
    <div class="panel">
      <h2>审计日志（${s.audit.length}）</h2>
      <table class="data-table compact">
        <thead><tr><th>#</th><th>时间</th><th>动作</th><th>对象</th><th>详情</th></tr></thead>
        <tbody>
          ${[...s.audit].reverse().map((a) => `<tr>
            <td>${a.rev}</td><td class="nowrap">${fmt(a.at)}</td><td>${esc(a.action)}</td><td><small>${esc(a.target || "")}</small></td><td>${esc(a.detail)}</td>
          </tr>`).join("") || "<tr><td colspan='5' class='empty'>暂无操作记录</td></tr>"}
        </tbody>
      </table>
    </div>`;
}

// ---------- 导入导出 ----------
function renderIO() {
  const s = store.state;
  const report = s.__lastImportReport;
  return `
    <div class="grid-2">
      <div class="panel">
        <h2>导出</h2>
        <p class="hint">导出赛季、玩家、阵营、轮次、座位与处罚（JSON）。</p>
        <button class="primary" id="exportBtn" data-testid="export-btn">导出全部数据</button>
      </div>
      <div class="panel">
        <h2>导入</h2>
        <p class="hint">导入前会完整校验：<b>重复参赛者、缺失阵营、非法比分、循环引用</b>等。任何一项失败都不会改动现有数据。</p>
        <input type="file" id="importFile" accept="application/json,.json" data-testid="import-file" />
        <div id="importReport" class="import-report" data-testid="import-report"></div>
        <div class="round-actions"><button class="primary" id="importApplyBtn" data-testid="import-apply" disabled>校验通过，应用导入</button></div>
      </div>
    </div>`;
}

function fmt(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// ---------- 渲染调度 ----------
const RENDERERS = {
  season: renderSeason,
  people: renderPeople,
  round: renderRound,
  results: renderResults,
  standings: renderStandings,
  audit: renderAudit,
  io: renderIO
};

function render() {
  $("#statSeasons").textContent = store.state.seasons.length;
  $("#statPlayers").textContent = store.state.players.length;
  $("#statRounds").textContent = store.state.rounds.length;
  const panel = $(`#tab-${activeTab}`);
  panel.innerHTML = RENDERERS[activeTab]();
  renderConflictBar();
  if (activeTab === "results") refreshPointsPreview();
}

function renderConflictBar() {
  const bar = $("#conflictBar");
  const conflicts = store.pendingConflicts;
  if (!conflicts.length) {
    bar.classList.add("hidden");
    bar.innerHTML = "";
    return;
  }
  const labels = { players: "玩家", seasons: "赛季", rounds: "轮次", seats: "座位", factions: "阵营", penalties: "处罚" };
  bar.classList.remove("hidden");
  bar.innerHTML = `
    <b>检测到与另一个页面的并发修改（${conflicts.length} 处冲突，未静默覆盖）：</b>
    <div class="conflict-list">
      ${conflicts
        .map((c, i) => {
          const name = (x) => x?.name || x?.id || "（已删除）";
          return `<div class="conflict-row" data-i="${i}" data-type="${c.type}" data-id="${c.id}">
            <span>${labels[c.type] || c.type}：${esc(name(c.local))} / ${esc(name(c.remote))}</span>
            <button data-side="local" data-testid="keep-local">保留本页修改</button>
            <button data-side="remote" data-testid="keep-remote">采用对端版本</button>
          </div>`;
        })
        .join("")}
    </div>`;
}

// ---------- 事件 ----------
$("#tabs").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-tab]");
  if (!btn) return;
  activeTab = btn.dataset.tab;
  $$("#tabs button").forEach((b) => b.classList.toggle("active", b === btn));
  $$(".tab-panel").forEach((p) => p.classList.add("hidden"));
  $(`#tab-${activeTab}`).classList.remove("hidden");
  render();
});

// 赛季页
document.body.addEventListener("submit", (e) => {
  const id = e.target.id;
  if (id === "seasonForm") {
    e.preventDefault();
    run(
      () =>
        A.createSeason({
          name: $("#seasonName").value,
          game: $("#seasonGame").value,
          minSize: $("#seasonMin").value,
          maxSize: $("#seasonMax").value,
          pointsWin: $("#seasonWinPts").value,
          pointsDraw: $("#seasonDrawPts").value
        }),
      "赛季已创建并自动分桌就绪"
    );
  }
  if (id === "factionForm") {
    e.preventDefault();
    run(() => A.createFaction($("#factionName").value), "阵营已添加");
  }
  if (id === "playerForm") {
    e.preventDefault();
    run(
      () => A.createPlayer({ name: $("#playerName").value, skill: $("#playerSkill").value, factionId: $("#playerFaction").value }),
      "玩家已添加"
    );
  }
  if (id === "roundCreateForm") {
    e.preventDefault();
    run(() => A.createRound(store.state.selectedSeasonId, $("#roundName").value), "轮次已创建并完成分桌");
  }
  if (id === "penaltyForm") {
    e.preventDefault();
    run(
      () => A.addPenalty(resultsRoundId, $("#penaltyPlayer").value, $("#penaltyPoints").value, $("#penaltyReason").value),
      "处罚已登记，积分榜已重算"
    );
  }
});

// 进入赛果输入框时记录改前值（结算态失焦时用于更正审计）
document.body.addEventListener("focusin", (e) => {
  if (e.target.matches(".score-input, .rank-input")) {
    const seat = store.state.seats.find((x) => x.id === e.target.dataset.seat);
    e.target.dataset.beforeScore = seat?.score ?? "";
    e.target.dataset.beforeRank = seat?.rank ?? "";
  }
});

document.body.addEventListener("input", (e) => {
  if (!e.target.matches(".score-input, .rank-input")) return;
  const patch = e.target.classList.contains("score-input")
    ? { score: intOrNull(e.target.value) }
    : { rank: intOrNull(e.target.value) };
  const result = A.patchSeatResult(e.target.dataset.seat, patch);
  if (result?.ok === false) toast(result.errors.join("；"), "err");
  refreshPointsPreview();
});

// 按当前名次实时预览每桌名次分（胜/平，结算前仅展示）
function refreshPointsPreview() {
  const s = store.state;
  const season = s.seasons.find((x) => x.id === s.selectedSeasonId);
  if (!season) return;
  const tables = $$(".results-tables .game-table");
  for (const tableEl of tables) {
    const rankInputs = $$(".rank-input", tableEl);
    const ranks = rankInputs.map((i) => intOrNull(i.value));
    const counts = new Map(ranks.filter((r) => r !== null).map((r) => [r, 0]));
    ranks.forEach((r) => r !== null && counts.set(r, counts.get(r) + 1));
    for (const input of rankInputs) {
      const r = intOrNull(input.value);
      const cell = $(`.pts-cell[data-rank-for="${input.dataset.seat}"]`, tableEl);
      if (!cell) continue;
      if (r === null) {
        cell.textContent = "—";
      } else if (r === 1 && counts.get(1) === 1) {
        cell.textContent = `${season.pointsWin} 分（胜）`;
      } else if (counts.get(r) > 1) {
        cell.textContent = `${season.pointsDraw} 分（平）`;
      } else {
        cell.textContent = "0 分";
      }
    }
  }
}

document.body.addEventListener("focusout", (e) => {
  if (!e.target.matches(".score-input, .rank-input")) return;
  const round = store.state.rounds.find((r) => r.id === resultsRoundId);
  if (round?.status !== "settled") return;
  const before = {
    score: intOrNull(e.target.dataset.beforeScore),
    rank: intOrNull(e.target.dataset.beforeRank)
  };
  const patch = e.target.classList.contains("score-input")
    ? { score: intOrNull(e.target.value) }
    : { rank: intOrNull(e.target.value) };
  const result = A.correctSeatResult(e.target.dataset.seat, patch, before);
  if (result?.ok === false) {
    toast(`更正被拒绝，已恢复原值：${result.errors.join("；")}`, "err");
    render(); // 整轮已回滚，刷新所有输入框为真实值
  }
});

document.body.addEventListener("change", (e) => {
  if (e.target.id === "seasonSelect") {
    A.selectSeason(e.target.value);
    render();
  }
  if (e.target.classList.contains("participant-check")) {
    const season = store.state.seasons.find((x) => x.id === store.state.selectedSeasonId);
    const ids = $$(".participant-check").filter((c) => c.checked).map((c) => c.dataset.player);
    handle(A.updateSeasonParticipants(season.id, ids), "参赛者已更新");
  }
  if (e.target.classList.contains("skill-edit") || e.target.classList.contains("faction-edit")) {
    const row = e.target.closest(".player-row");
    const patch = e.target.classList.contains("skill-edit")
      ? { skill: Number(e.target.value) }
      : { factionId: e.target.value };
    handle(A.updatePlayer(row.dataset.player, patch), "玩家已更新");
  }
  if (e.target.id === "resultsRound") {
    resultsRoundId = e.target.value;
    render();
  }
  if (e.target.classList.contains("att-select")) {
    const row = e.target.closest("tr[data-player]");
    const card = e.target.closest(".round-card");
    const result = A.setAttendance(card.dataset.round, row.dataset.player, e.target.value);
    if (result?.ok === false) toast(result.errors.join("；"), "err");
    render();
  }
  if (e.target.classList.contains("sub-select")) {
    const row = e.target.closest("tr[data-player]");
    const card = e.target.closest(".round-card");
    const inId = e.target.value;
    if (!inId) return;
    run(() => A.substitutePlayer(card.dataset.round, row.dataset.player, inId), "已替换并重排，锁座保持不动");
  }
});

document.body.addEventListener("click", (e) => {
  // 冲突解决
  const conflictBtn = e.target.closest(".conflict-row button");
  if (conflictBtn) {
    const row = conflictBtn.closest(".conflict-row");
    const result = store.resolveConflicts([{ type: row.dataset.type, id: row.dataset.id, side: conflictBtn.dataset.side }]);
    handle(result, "冲突已解决");
    return;
  }

  const action = e.target.closest("[data-action]");
  if (!action) return;
  const act = action.dataset.action;

  if (act === "go-results") {
    e.preventDefault();
    activeTab = "results";
    $$("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === "results"));
    $$(".tab-panel").forEach((p) => p.classList.add("hidden"));
    $("#tab-results").classList.remove("hidden");
    const card = action.closest(".round-card");
    resultsRoundId = card.dataset.round;
    render();
    return;
  }

  const card = action.closest(".round-card");
  const roundId = card?.dataset.round || resultsRoundId;
  const map = {
    publish: () => A.publishRound(roundId),
    unpublish: () => A.unpublishRound(roundId),
    settle: () => A.settleRound(roundId),
    "settle-here": () => A.settleRound(roundId),
    reseat: () => A.reseat(roundId),
    delete: () => A.deleteRound(roundId),
    lock: () => A.toggleLockSeat(action.closest(".seat").dataset.seat),
    "undo-sub": () => {
      const row = action.closest("tr[data-player]");
      return A.undoSubstitute(roundId, row.dataset.player);
    },
    "del-penalty": () => A.removePenalty(action.dataset.penalty)
  };
  if (map[act]) {
    const msgs = {
      publish: "赛程已发布",
      unpublish: "已撤销发布，回到草稿",
      settle: "本轮已结算，积分榜已更新",
      "settle-here": "本轮已结算，积分榜已更新",
      reseat: "已按约束重排，锁座未动",
      delete: "轮次已删除",
      lock: "锁座状态已切换"
    };
    run(map[act], msgs[act]);
  }
});

// 导入导出
document.body.addEventListener("click", (e) => {
  if (e.target.id === "exportBtn") {
    const s = store.state;
    const payload = {
      schema: "league-console/v1",
      exportedAt: new Date().toISOString(),
      seasons: s.seasons,
      players: s.players,
      factions: s.factions,
      rounds: s.rounds,
      seats: s.seats,
      penalties: s.penalties
    };
    download(`league-export-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(payload, null, 2));
    toast("已导出");
  }
  if (e.target.id === "importApplyBtn") {
    if (!stagedImport) return;
    const result = A.importDocument(stagedImport);
    stagedImport = null;
    if (handle(result, "导入成功，数据已整体替换")) {
      resultsRoundId = "";
      $("#importFile").value = "";
    }
  }
});

$("#tab-io").addEventListener("change", (e) => {
  if (e.target.id !== "importFile") return;
  const file = e.target.files[0];
  const reportEl = $("#importReport");
  const applyBtn = $("#importApplyBtn");
  stagedImport = null;
  applyBtn.disabled = true;
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    let doc;
    try {
      doc = JSON.parse(reader.result);
    } catch {
      reportEl.innerHTML = `<div class="report-err"><b>校验失败：</b>文件不是合法 JSON。现有数据未改动。</div>`;
      return;
    }
    const report = validateImport(doc);
    if (report.errors.length) {
      reportEl.innerHTML = `<div class="report-err" data-testid="import-errors"><b>校验失败（${report.errors.length} 项），已阻断导入，现有数据未改动：</b>
        <ul>${report.errors.map((x) => `<li><code>${esc(x.code)}</code> ${esc(x.msg)}</li>`).join("")}</ul></div>`;
      toast("导入被阻断：数据保持不变", "err");
      return;
    }
    stagedImport = doc;
    applyBtn.disabled = false;
    const warnHtml = report.warnings.length
      ? `<p><b>警告（${report.warnings.length}，不阻断导入）：</b></p><ul>${report.warnings.map((x) => `<li>${esc(x.msg)}</li>`).join("")}</ul>`
      : "";
    reportEl.innerHTML = `<div class="report-ok" data-testid="import-ok"><b>校验通过。</b>
      <ul>
        <li>赛季 ${doc.seasons.length} 个、玩家 ${doc.players.length} 名、阵营 ${doc.factions.length} 个</li>
        <li>轮次 ${doc.rounds.length} 个、座位 ${doc.seats.length} 条、处罚 ${doc.penalties.length} 条</li>
      </ul>${warnHtml}确认后将整体替换当前数据。</div>`;
  };
  reader.readAsText(file);
});

store.subscribe(() => {
  // 持久化已由 store 完成；其他页面推送变更后重绘
  render();
});
store.onConflict(() => renderConflictBar());

// ---------- 首启演示数据 ----------
function seedDemo() {
  const s = store.state;
  if (s.seasons.length || s.players.length) return;
  const F = {};
  ["红雀会", "蓝塔团", "金狮盟"].forEach((name) => {
    const r = A.createFaction(name);
    F[name] = store.state.factions.find((x) => x.name === name)?.id;
    void r;
  });
  const roster = [
    ["阿十", 5, "红雀会"], ["豆豆", 2, "红雀会"],
    ["小满", 4, "蓝塔团"], ["七喜", 5, "蓝塔团"],
    ["柯北", 3, "金狮盟"], ["阿澈", 4, "金狮盟"],
    ["年糕", 3, ""], ["梅子", 2, ""], ["闻笙", 5, ""],
    ["老K", 4, ""], ["阿岩", 2, ""]
  ];
  const ids = [];
  roster.forEach(([name, skill, fac]) => {
    A.createPlayer({ name, skill, factionId: F[fac] || "" });
    ids.push(store.state.players.find((x) => x.name === name).id);
  });
  A.createSeason({
    name: "2026 秋季联赛",
    game: "璀璨宝石",
    minSize: 3,
    maxSize: 4,
    pointsWin: 3,
    pointsDraw: 1,
    participantIds: ids.slice(0, 9) // 老K、阿岩 为替补池
  });
  const seasonId = store.state.seasons[0].id;
  A.createRound(seasonId, "第 1 轮 · 常规赛");
}

seedDemo();

// ---------- 浏览器自动化 / 调试钩子 ----------
window.LEAGUE = {
  store,
  actions: A,
  domain: { seatRound, computeStandings, seasonRounds, roundSeats, seasonParticipants },
  resetAll() {
    localStorage.removeItem("league-console/v1");
    localStorage.removeItem("league-console/v1/pending");
    location.reload();
  },
  reseed() {
    localStorage.removeItem("league-console/v1");
    localStorage.removeItem("league-console/v1/pending");
    location.reload();
  }
};

render();
