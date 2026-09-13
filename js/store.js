// 状态存储：修订号、审计日志、跨标签页三方合并
import { uid } from "./util.js";

export const STORAGE_KEY = "league-console/v1";
export const PENDING_KEY = "league-console/v1/pending";
export const SCHEMA = "league-console/v1";
const AUDIT_LIMIT = 600;

export const COLLECTIONS = ["seasons", "players", "factions", "rounds", "seats", "penalties"];

export function freshState() {
  return {
    schema: SCHEMA,
    rev: 0,
    selectedSeasonId: "",
    seasons: [],
    players: [],
    factions: [],
    rounds: [],
    seats: [],
    penalties: [],
    tombstones: [], // {type, id, rev}
    audit: []
  };
}

export function auditEntry(action, target, detail, rev = 0) {
  return { id: uid("aud"), at: new Date().toISOString(), rev, action, target: target || null, detail: detail || "" };
}

class Store {
  constructor() {
    this.listeners = new Set();
    this.conflictListeners = new Set();
    this.pendingConflicts = [];
    this.isolated = false;
    this._remoteShadow = null;
    this.state = freshState();
    this.base = freshState();
    this._load();
    window.addEventListener("storage", (e) => {
      if (this.isolated) return;
      if (e.key === STORAGE_KEY && e.newValue) this._onRemoteChange();
    });
  }

  // ---- 持久化 ----
  _readStored() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const doc = JSON.parse(raw);
      if (!doc || doc.schema !== SCHEMA) return null;
      return doc;
    } catch {
      return null;
    }
  }

  _writeStored(doc) {
    if (this.isolated) {
      this._remoteShadow = doc;
    } else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(doc));
    }
  }

  _load() {
    const pendingRaw = localStorage.getItem(PENDING_KEY);
    const stored = this._readStored();
    if (stored) {
      this.state = stored;
      this.base = structuredClone(stored);
    }
    if (pendingRaw) {
      try {
        const pending = JSON.parse(pendingRaw);
        this.state = pending.doc;
        this.base = pending.base;
        this.pendingConflicts = pending.conflicts || [];
      } catch {
        localStorage.removeItem(PENDING_KEY);
      }
    }
  }

  /**
   * 执行一次变更。
   * mutator(draft) 返回审计条目数组（或单条），可直接改 draft。
   * 返回 { ok, conflicts, errors }；errors 用于 mutator 主动阻断（不写任何数据）。
   */
  commit(mutator, meta = {}) {
    const working = structuredClone(this.state);
    let entries;
    try {
      entries = mutator(working);
    } catch (err) {
      return { ok: false, errors: [err.message || String(err)] };
    }
    if (entries === false) return { ok: false, errors: meta.errors || ["操作被拒绝"] };
    if (entries == null || typeof entries !== "object") entries = [];
    if (!Array.isArray(entries)) entries = [entries];
    entries = entries.filter((e) => e && typeof e === "object" && typeof e.action === "string");

    // 实体修订号：与 base 比对，变化的实体 erev +1
    for (const type of COLLECTIONS) {
      const before = new Map((this.base[type] || []).map((x) => [x.id, x]));
      for (const ent of working[type] || []) {
        const old = before.get(ent.id);
        if (!old) ent.rev = (ent.rev || 0) || 1;
        else if (JSON.stringify(stripRev(old)) !== JSON.stringify(stripRev(ent))) ent.rev = (old.rev || 1) + 1;
        else ent.rev = old.rev || ent.rev || 1;
      }
    }

    const stored = this.isolated ? this._remoteShadow : this._readStored();
    // 静默提交（如逐字录入比分）不写审计，但 rev 仍 +1，保证跨页合并能看到变化
    const bump = entries.length || meta.silent ? 1 : 0;
    const nextRev = (stored ? stored.rev : this.base.rev) + (entries.length || bump);
    entries.forEach((entry, i) => {
      entry.rev = (stored ? stored.rev : this.base.rev) + i + 1;
    });
    working.audit = [...(working.audit || []), ...entries].slice(-AUDIT_LIMIT);
    working.rev = nextRev;

    const result = this._publish(working, stored, { silent: !!meta.silent });
    return result;
  }

  _publish(working, storedMaybe, opts = {}) {
    // 隔离模式：只更新内存与影子存储，不碰真实 localStorage、不推进基线、不广播
    if (this.isolated) {
      this._remoteShadow = working;
      this.state = working;
      return { ok: true };
    }
    const stored = storedMaybe || this._readStored();

    // 本地基线即存储最新：直接写入
    if (!stored || stored.rev === this.base.rev) {
      this._writeStored(working);
      this.state = working;
      this.base = structuredClone(working);
      this.pendingConflicts = [];
      localStorage.removeItem(PENDING_KEY);
      if (!opts.silent) this._emit();
      return { ok: true };
    }

    // 存储领先：三方合并
    const merged = mergeDocs(this.base, working, stored);
    if (merged.conflicts.length) {
      this.state = merged.doc; // 暂时保留本地版本
      this.pendingConflicts = merged.conflicts;
      localStorage.setItem(
        PENDING_KEY,
        JSON.stringify({ doc: this.state, base: this.base, conflicts: this.pendingConflicts })
      );
      this._emitConflict();
      if (!opts.silent) this._emit();
      return { ok: false, conflicts: merged.conflicts };
    }

    merged.doc.rev = Math.max(working.rev, stored.rev + 1);
    this._writeStored(merged.doc);
    this.state = merged.doc;
    this.base = structuredClone(merged.doc);
    this.pendingConflicts = [];
    localStorage.removeItem(PENDING_KEY);
    if (!opts.silent) this._emit();
    return { ok: true, merged: true };
  }

  /** 冲突解决：对每个冲突实体选择 local 或 remote 后落盘 */
  resolveConflicts(resolutions) {
    if (!this.pendingConflicts.length) return { ok: true };
    const stored = this.isolated ? this._remoteShadow : this._readStored();
    if (!stored) return { ok: false, errors: ["找不到对端版本，请刷新页面"] };
    const doc = structuredClone(this.state);
    for (const choice of resolutions) {
      const c = this.pendingConflicts.find((x) => x.type === choice.type && x.id === choice.id);
      if (!c) continue;
      const keep = choice.side === "remote" ? c.remote : c.local;
      const list = doc[c.type];
      const idx = list.findIndex((x) => x.id === c.id);
      if (keep) {
        keep.rev = Math.max(c.local?.rev || 0, c.remote?.rev || 0) + 1;
        if (idx >= 0) list[idx] = keep;
        else list.push(keep);
      } else if (idx >= 0) {
        list.splice(idx, 1);
        doc.tombstones = [...(doc.tombstones || []), { type: c.type, id: c.id, rev: stored.rev + 1 }];
      }
    }
    doc.rev = Math.max(this.state.rev || 0, stored.rev + 1);
    // 标量字段（当前赛季选择）：冲突取本地
    this._writeStored(doc);
    this.state = doc;
    this.base = structuredClone(doc);
    this.pendingConflicts = [];
    localStorage.removeItem(PENDING_KEY);
    this._emitConflict();
    this._emit();
    return { ok: true };
  }

  _onRemoteChange() {
    const stored = this._readStored();
    if (!stored) return;
    if (this.pendingConflicts.length) return; // 等用户解决
    if (stored.rev <= this.base.rev) return;
    const merged = mergeDocs(this.base, this.state, stored);
    if (merged.conflicts.length) {
      // 本地无未保存变更（本应用每次操作即时落盘），理论上不会走到；保险起见弹窗
      this.state = merged.doc;
      this.pendingConflicts = merged.conflicts;
      this._emitConflict();
    } else {
      this.state = merged.doc;
      this.base = structuredClone(merged.doc);
    }
    this._emit();
  }

  // ---- 测试用：模拟“另一个页面” ----
  beginIsolation() {
    this.isolated = true;
    this._remoteShadow = this._readStored();
  }

  endIsolation() {
    this.isolated = false;
    this._remoteShadow = null;
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  onConflict(fn) {
    this.conflictListeners.add(fn);
    return () => this.conflictListeners.delete(fn);
  }
  _emit() {
    this.listeners.forEach((fn) => fn(this.state));
  }
  _emitConflict() {
    this.conflictListeners.forEach((fn) => fn(this.pendingConflicts));
  }
}

function stripRev(obj) {
  const { rev, ...rest } = obj;
  return rest;
}

/**
 * 三方合并：base 为共同祖先，local / remote 为两边文档。
 * 实体级比对 erev：仅一边改动直接采用；两边都改且不同 => 冲突（不静默覆盖）。
 */
export function mergeDocs(base, local, remote) {
  const doc = structuredClone(remote);
  const conflicts = [];

  for (const type of COLLECTIONS) {
    const baseMap = new Map((base[type] || []).map((x) => [x.id, x]));
    const localMap = new Map((local[type] || []).map((x) => [x.id, x]));
    const remoteMap = new Map((remote[type] || []).map((x) => [x.id, x]));
    const ids = new Set([...baseMap.keys(), ...localMap.keys(), ...remoteMap.keys()]);
    const out = [];

    for (const id of ids) {
      const b = baseMap.get(id);
      const l = localMap.get(id);
      const r = remoteMap.get(id);
      const localChanged = !sameEntity(b, l);
      const remoteChanged = !sameEntity(b, r);

      if (!localChanged && !remoteChanged) {
        if (r) out.push(r);
        continue;
      }
      if (localChanged && !remoteChanged) {
        if (l) out.push(l); // 本地新增/修改，远端没动
        else doc.tombstones = [...(doc.tombstones || []), { type, id, rev: remote.rev }]; // 本地删除
        continue;
      }
      if (!localChanged && remoteChanged) {
        if (r) out.push(r);
        continue;
      }
      // 两边都动了
      if (sameEntity(l, r)) {
        if (l) out.push(l);
        continue;
      }
      // 一边删除、另一边修改 => 冲突（保留修改方，需用户拍板）
      conflicts.push({ type, id, local: l || null, remote: r || null });
      if (l) out.push(l);
    }
    doc[type] = out;
  }

  // 审计与墓碑：并集
  const auditMap = new Map();
  for (const a of [...(base.audit || []), ...(local.audit || []), ...(remote.audit || [])]) {
    auditMap.set(a.id, a);
  }
  doc.audit = [...auditMap.values()].sort((a, b) => a.rev - b.rev).slice(-AUDIT_LIMIT);
  doc.tombstones = uniqBy([...(doc.tombstones || []), ...(local.tombstones || [])], (t) => `${t.type}:${t.id}`);

  return { doc, conflicts };
}

function sameEntity(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return JSON.stringify(stripRev(a)) === JSON.stringify(stripRev(b));
}

function uniqBy(arr, key) {
  const map = new Map();
  for (const item of arr) map.set(key(item), item);
  return [...map.values()];
}

export const store = new Store();
