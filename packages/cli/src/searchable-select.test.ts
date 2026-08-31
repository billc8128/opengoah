import assert from "node:assert/strict";
import test from "node:test";
import type { SelectListTheme } from "@earendil-works/pi-tui";
import { SearchableSelect } from "./searchable-select.js";

const plain: SelectListTheme = {
  selectedPrefix: String,
  selectedText: String,
  description: String,
  scrollInfo: String,
  noMatch: String,
};
const items = [
  { value: "openai-codex", label: "OpenAI Codex", description: "OAuth" },
  { value: "vercel-ai-gateway", label: "Vercel AI Gateway", description: "201 models" },
  { value: "zai-coding-cn", label: "Z.AI Coding CN", description: "5 models" },
];

test("searchable select fuzzy-filters labels and provider ids", () => {
  const select = new SearchableSelect(items, 10, plain, { searchLabel: "Search providers" });
  select.handleInput("v");
  select.handleInput("a");
  select.handleInput("g");
  assert.equal(select.query, "vag");
  assert.equal(select.resultCount, 1);
  assert.match(select.render(100).join("\n"), /Vercel AI Gateway/);
  assert.doesNotMatch(select.render(100).join("\n"), /OpenAI Codex/);
});

test("escape clears a query before cancelling the selector", () => {
  const select = new SearchableSelect(items, 10, plain);
  let cancelled = false;
  select.onCancel = () => {
    cancelled = true;
  };
  select.handleInput("z");
  select.handleInput("\x1b");
  assert.equal(select.query, "");
  assert.equal(cancelled, false);
  select.handleInput("\x1b");
  assert.equal(cancelled, true);
});
