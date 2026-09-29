// cumAI's Status panel (stage C, C5b; C-D10): only what GET /v1/status says.
// The contract is TI Build's (c-playground.md, C2b's notes); the example body
// below is its own. No example data reaches the page: what the gateway has
// not measured stays "unknown".
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MODEL_STATES, ago, counts, fetchStatus, firstToken, lasted, parseStatus, speed, statusView, worst,
} from "../public/ai/status.js";
import { STATUS } from "../public/ai/words.js";

/** The contract's own example, with a few more models and incidents. */
const BODY = {
  generated_at: "2026-09-24T14:00:00.000Z",
  services: [{ id: "gateway", state: "operational" }, { id: "moderation", state: "operational" }, { id: "supplier", state: "degraded" }],
  models: [
    { id: "gpt-4.1-nano", state: "live", first_token_ms: 420, tokens_per_s: 88.5, checked_at: "2026-09-24T13:58:12.000Z", source: "probe" },
    { id: "gpt-5", state: "degraded", first_token_ms: 1900, tokens_per_s: null, checked_at: "2026-09-24T13:10:00.000Z", source: "call" },
    { id: "claude-sonnet-5", state: "down", first_token_ms: null, tokens_per_s: null, checked_at: "2026-09-24T11:00:00.000Z", source: "probe" },
    { id: "deepseek-v4-pro", state: "unknown", first_token_ms: null, tokens_per_s: null, checked_at: null, source: null },
  ],
  incidents: [
    { subject: "gpt-5", state: "degraded", from: "2026-09-24T13:10:00.000Z", to: null },
    { subject: "supplier", state: "degraded", from: "2026-09-24T12:00:00.000Z", to: "2026-09-24T12:30:00.000Z" },
  ],
  probe: { on: true, every_minutes: 30, budget_usd_day: 1, spent_usd_today: 0.0047 },
};

test("the status is a CORS simple request to the gateway, and a failure is null", async () => {
  const calls = [];
  const got = await fetchStatus(async (url, init) => { calls.push([url, init]); return { status: 200, json: async () => BODY }; });
  assert.deepEqual(calls, [["https://api.clankuwu.com/v1/status", { credentials: "omit" }]]);
  assert.equal(got.models.length, 4);
  for (const bad of [async () => ({ status: 503, json: async () => ({}) }), async () => { throw new TypeError("x"); },
    async () => ({ status: 200, json: async () => ({ models: "no" }) })]) {
    assert.equal(await fetchStatus(bad), null);
  }
});

test("the contract's fields, read as they are; anything malformed is left out, never guessed", () => {
  const s = parseStatus(BODY);
  assert.equal(s.generatedAt, "2026-09-24T14:00:00.000Z");
  assert.deepEqual(s.services.map((x) => [x.id, x.state]), [["gateway", "operational"], ["moderation", "operational"], ["supplier", "degraded"]]);
  assert.deepEqual(s.models[0], { id: "gpt-4.1-nano", state: "live", firstTokenMs: 420, tokensPerS: 88.5, checkedAt: "2026-09-24T13:58:12.000Z", source: "probe" });
  assert.deepEqual(s.models[3], { id: "deepseek-v4-pro", state: "unknown", firstTokenMs: null, tokensPerS: null, checkedAt: null, source: null });
  assert.deepEqual(s.probe, { on: true, everyMinutes: 30, budgetUsdDay: 1, spentUsdToday: 0.0047 });
  assert.deepEqual(s.models.map((m) => m.id), BODY.models.map((m) => m.id), "in the gateway's order");
  const odd = parseStatus({
    services: [{ id: "openrouter", state: "operational" }, { id: "gateway", state: "fine" }],
    models: [{ id: "<img src=x>", state: "live" }, { id: "gpt-5", state: "slow" }, { id: "gpt-5", state: "live", first_token_ms: -1, tokens_per_s: "fast", checked_at: "soon", source: "guess" }],
    incidents: [{ subject: "gpt-5", state: "live", from: "2026-09-24T13:10:00.000Z" }, { subject: "gpt-5", state: "down", from: "nope" }],
    probe: { on: "yes" },
  });
  assert.deepEqual(odd.services, [], "no supplier by name, and no state the gateway doesn't have");
  assert.deepEqual(odd.models, [{ id: "gpt-5", state: "live", firstTokenMs: null, tokensPerS: null, checkedAt: null, source: null }]);
  assert.deepEqual(odd.incidents, []);
  assert.equal(odd.probe.on, false);
  assert.equal(parseStatus(null), null);
  assert.equal(parseStatus({ services: [] }), null);
});

test("counts, the worst state, and the table's order: the worst first", () => {
  const s = parseStatus(BODY);
  assert.deepEqual(counts(s.models), { live: 1, degraded: 1, down: 1, unknown: 1 });
  assert.equal(worst(s.models), "down");
  assert.equal(worst(s.models.filter((m) => m.state !== "down")), "degraded");
  assert.equal(worst([{ state: "unknown" }]), "unknown", "unknown only when nothing is known");
  assert.equal(worst([{ state: "unknown" }, { state: "live" }]), "live");
  assert.deepEqual(statusView(s.models).map((m) => m.state), ["down", "degraded", "live", "unknown"]);
  assert.deepEqual(statusView(s.models, "live").map((m) => m.id), ["gpt-4.1-nano"]);
  assert.deepEqual(MODEL_STATES, ["live", "degraded", "down", "unknown"]);
});

test("figures: first token, speed, and times from the gateway's own clock", () => {
  assert.equal(firstToken(420), "0.42 s");
  assert.equal(firstToken(null), "—");
  assert.equal(speed(88.5), "89 tok/s");
  assert.equal(speed(null), "—");
  assert.equal(ago("2026-09-24T13:58:12.000Z", "2026-09-24T14:00:00.000Z"), "2 min ago");
  assert.equal(ago("2026-09-24T13:59:50.000Z", "2026-09-24T14:00:00.000Z"), "just now");
  assert.equal(ago("2026-09-24T11:00:00.000Z", "2026-09-24T14:00:00.000Z"), "3 h ago");
  assert.equal(ago(null, "2026-09-24T14:00:00.000Z"), "—");
  assert.equal(lasted("2026-09-24T12:00:00.000Z", "2026-09-24T12:30:00.000Z"), "for 30 min");
  assert.equal(lasted("2026-09-24T12:00:00.000Z", null, "2026-09-24T14:00:00.000Z"), "for 2 h");
});

test("the words follow the gateway's rules, keep the supplier unnamed, and invent nothing", () => {
  assert.deepEqual(Object.keys(STATUS.services), ["gateway", "moderation", "supplier"]);
  assert.equal(STATUS.services.supplier[0], "Supplier");
  assert.doesNotMatch(JSON.stringify(STATUS), /APIMart|OpenRouter|example|soon/i);
  assert.equal(STATUS.legend.down, "its last three failed");
  assert.equal(STATUS.legend.degraded, "a failure among its last five");
  assert.equal(STATUS.legend.unknown, "nothing measured in 3 hours");
  assert.equal(STATUS.noChecks, "No scheduled checks yet: a model shows as unknown until real calls reach it.");
});
