// The content desk every publishing platform shares: ideas, materials, drafts and a publish plan.
//
// Xiaohongshu and Douyin have the same shape — a person collects angles, gathers material, drafts a post and
// schedules it — so the collection logic lives once here and each platform supplies its own names and limits.
// Publishing is a separate, rule-gated action: nothing in this file posts anything.
import { randomUUID } from "node:crypto";

import { BridgeError, readJson, writeJson } from "../bridge.mjs";

/** Collections a desk keeps, in the order a person fills them. */
export const COLLECTIONS = ["ideas", "materials", "drafts", "plans"];

export function createDesk({ file, copy, caps, draftBodyKey = "body" }) {
  const empty = () => ({
    schemaVersion: 1,
    ideas: [],
    materials: [],
    drafts: [],
    plans: [],
    rules: { actions: { publish: "manual" } },
  });

  const load = () => {
    const state = readJson(file, null);
    if (!state || !Array.isArray(state.ideas)) return empty();
    const rules = state.rules && typeof state.rules === "object" ? state.rules : {};
    return {
      ...empty(),
      ...state,
      rules: { actions: { publish: "manual", ...(rules.actions && typeof rules.actions === "object" ? rules.actions : {}) } },
    };
  };

  const save = (state) => writeJson(file, state);

  const require = (value, field, max) => {
    const text = String(value ?? "").trim();
    if (!text) throw new BridgeError("invalid-args", `${field} is required`, false);
    return text.slice(0, max);
  };

  return {
    load,
    save,

    add(collection, row) {
      const state = load();
      if (!COLLECTIONS.includes(collection)) throw new BridgeError("invalid-action", `unknown collection ${collection}`, false);
      if (state[collection].length >= caps[collection]) {
        throw new BridgeError("store-full", `${copy[collection]} already holds ${caps[collection]} entries`, false);
      }
      const entry = { id: randomUUID(), ...row, createdAt: new Date().toISOString() };
      state[collection].push(entry);
      save(state);
      return entry;
    },

    list(collection, { status } = {}) {
      const rows = load()[collection] ?? [];
      return (status ? rows.filter((row) => row.status === status) : rows).slice(-100);
    },

    update(collection, id, patch) {
      const state = load();
      const row = state[collection].find((candidate) => candidate.id === id);
      if (!row) throw new BridgeError("not-found", `no ${copy[collection]} entry ${String(id).slice(0, 60)}`, false);
      Object.assign(row, patch, { updatedAt: new Date().toISOString() });
      save(state);
      return row;
    },

    remove(collection, id) {
      const state = load();
      const kept = state[collection].filter((row) => row.id !== id);
      if (kept.length === state[collection].length) throw new BridgeError("not-found", `no ${copy[collection]} entry ${String(id).slice(0, 60)}`, false);
      state[collection] = kept;
      save(state);
      return { removed: id };
    },

    /** A draft is the thing that gets published, so its body is required and its status is explicit. */
    saveDraft(args) {
      const body = require(args[draftBodyKey], draftBodyKey, 20_000);
      const title = require(args.title, "title", 200);
      if (args.id) return this.update("drafts", String(args.id), { title, [draftBodyKey]: body, ...(args.status ? { status: String(args.status) } : {}) });
      return this.add("drafts", { title, [draftBodyKey]: body, status: "draft" });
    },

    /** A plan names a draft and a time; it is a local schedule, never a claim that something was published. */
    addPlan(args) {
      const draftId = require(args.draftId, "draftId", 120);
      if (!this.list("drafts").some((draft) => draft.id === draftId)) {
        throw new BridgeError("not-found", `no draft ${draftId.slice(0, 60)}`, false);
      }
      const plannedFor = require(args.plannedFor, "plannedFor", 40);
      return this.add("plans", { draftId, plannedFor, status: "planned" });
    },

    setPublishMode(mode) {
      if (!["auto", "manual"].includes(mode)) throw new BridgeError("invalid-args", "mode must be auto or manual", false);
      const state = load();
      state.rules.actions.publish = mode;
      save(state);
      return state.rules;
    },

    publishMode() {
      return load().rules.actions.publish ?? "manual";
    },
  };
}

/** The board sections a content desk shows: what was collected, what is drafted, what is planned. */
export function deskSections(desk, copy) {
  const counts = COLLECTIONS.map((collection) => ({ collection, count: desk.list(collection).length }));
  return [
    {
      id: "collected",
      kind: "table",
      title: copy.collectedTitle,
      columns: [{ key: "kind", label: copy.kind }, { key: "count", label: copy.count, align: "end" }],
      rows: counts.map(({ collection, count }) => ({
        id: collection,
        cells: { kind: { kind: "text", value: copy[collection] }, count: { kind: "count", value: String(count) } },
      })),
      empty: copy.collectedEmpty,
    },
    {
      id: "drafts",
      kind: "list",
      title: copy.draftsTitle,
      items: desk.list("drafts").slice(-20).reverse().map((draft) => ({
        id: draft.id,
        title: draft.title ?? "(untitled)",
        subtitle: draft.status === "ready" ? copy.ready : draft.status === "published" ? copy.published : copy.draftState,
        meta: draft.createdAt?.slice(0, 10),
      })),
      empty: copy.draftsEmpty,
    },
    {
      id: "plans",
      kind: "timeline",
      title: copy.plansTitle,
      entries: desk.list("plans").slice(-20).reverse().map((plan) => ({
        id: plan.id,
        at: plan.plannedFor && !Number.isNaN(Date.parse(plan.plannedFor)) ? new Date(plan.plannedFor).toISOString() : plan.createdAt ?? new Date().toISOString(),
        title: copy.planAt,
        detail: plan.status === "done" ? copy.planDone : copy.planPlanned,
      })),
      empty: copy.plansEmpty,
    },
  ];
}
