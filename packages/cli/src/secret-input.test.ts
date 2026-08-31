import assert from "node:assert/strict";
import test from "node:test";
import { SecretInput, setInitialValue } from "./secret-input.js";

test("secret input never renders its value", () => {
  const input = new SecretInput();
  input.setValue("sk-live-secret");
  input.focused = true;
  const rendered = input.render(40).join("\n");
  assert.doesNotMatch(rendered, /sk-live-secret/);
  assert.match(rendered, /\*{10}/);
});

test("setup defaults place the cursor at the end", () => {
  const input = new SecretInput();
  setInitialValue(input, "ZAI_API_KEY");
  input.handleInput("X");
  assert.equal(input.getValue(), "ZAI_API_KEYX");
});
