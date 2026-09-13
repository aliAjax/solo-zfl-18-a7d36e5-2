// store 三方合并 / 冲突 / 原子提交测试（Node + localStorage shim）
globalThis.window = { listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; } };
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k)
};

const { store, mergeDocs, freshState } = await import("../js/store.js");

let pass = 0;
let fail = 0;
function assert(cond, msg) {
  if (cond) pass++;
  else {
    fail++;
    console.error("✗", msg);
  }
}

function mkPlayer(id, name) {
  return { id, name, factionId: "f1", skill: 3, rev: 1 };
}

function setup() {
  mem.clear();
  store.state = freshState();
  store.base = freshState();
  store.pendingConflicts = [];
  store.isolated = false;
  store._remoteShadow = null;
}

// ---- 基本提交与审计、rev ----
setup();
store.commit((d) => {
  d.players.push(mkPlayer("p1", "甲"));
  return { id: "a1", at: "t", rev: 0, action: "新增", target: "p1", detail: "甲" };
});
assert(store.state.players.length === 1, "提交后实体存在");
assert(store.state.rev === 1, `rev=1，实际 ${store.state.rev}`);
assert(store.state.audit.length === 1, "审计写入一条");
assert(JSON.parse(mem.get("league-console/v1")).players[0].name === "甲", "已持久化");

// ---- 远端只改了别的实体：自动合并，不冲突 ----
const base = JSON.parse(mem.get("league-console/v1"));
const remote1 = structuredClone(base);
remote1.players.push(mkPlayer("p2", "乙"));
remote1.rev = 2;
remote1.audit.push({ id: "a2", at: "t", rev: 2, action: "远端新增", target: "p2", detail: "乙" });
mem.set("league-console/v1", JSON.stringify(remote1));
// 本地也提交一个不同实体
const r1 = store.commit((d) => {
  d.players.push(mkPlayer("p3", "丙"));
  return { id: "a3", at: "t", rev: 0, action: "本地新增", target: "p3", detail: "丙" };
});
assert(r1.ok && r1.merged, "两边改不同实体应自动合并");
const names = store.state.players.map((p) => p.name).sort();
assert(JSON.stringify(names) === JSON.stringify(["丙", "乙", "甲"]), `合并后三人都在：${names}`);

// ---- 两边改同一实体：冲突，不静默覆盖 ----
setup();
store.commit((d) => {
  d.players.push({ ...mkPlayer("p1", "甲") });
});
const b2 = JSON.parse(mem.get("league-console/v1"));
const remote2 = structuredClone(b2);
remote2.players[0].name = "远端改";
remote2.rev = 5;
mem.set("league-console/v1", JSON.stringify(remote2));
const r2 = store.commit((d) => {
  d.players[0].name = "本地改";
});
assert(r2.ok === false && r2.conflicts.length === 1, "同实体双改应报冲突");
assert(store.pendingConflicts.length === 1, "冲突挂起待解决");
// 存储未被本地版本静默覆盖
assert(JSON.parse(mem.get("league-console/v1")).players[0].name === "远端改", "冲突期间存储保持远端版本");
// 选择本地
store.resolveConflicts([{ type: "players", id: "p1", side: "local" }]);
assert(store.state.players[0].name === "本地改", "选择本页后保留本地版本");
assert(JSON.parse(mem.get("league-console/v1")).players[0].name === "本地改", "选择后落盘");
assert(store.pendingConflicts.length === 0, "冲突清除");

// ---- 一边删除、另一边修改：冲突，可选远端恢复 ----
setup();
store.commit((d) => d.players.push({ ...mkPlayer("p1", "甲") }));
const remote3 = structuredClone(JSON.parse(mem.get("league-console/v1")));
remote3.players[0].name = "远端又改了";
remote3.rev = 9;
mem.set("league-console/v1", JSON.stringify(remote3));
store.commit((d) => {
  d.players = d.players.filter((p) => p.id !== "p1");
});
assert(store.pendingConflicts.length === 1, "删/改并发应冲突");
store.resolveConflicts([{ type: "players", id: "p1", side: "remote" }]);
assert(store.state.players[0].name === "远端又改了", "采用远端 => 实体恢复");

// ---- 纯函数 mergeDocs：远端删除、本地未动 ----
{
  const b = freshState();
  b.players = [mkPlayer("p1", "甲")];
  const local = structuredClone(b);
  const remote = freshState();
  remote.players = [];
  const { doc, conflicts } = mergeDocs(b, local, remote);
  assert(!conflicts.length && doc.players.length === 0, "远端删除应自动同步");
}

console.log(`\n${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
