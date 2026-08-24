import { CURSOR_MARKER, Input } from "@mariozechner/pi-tui";

/** Input that keeps the real value in memory while rendering only a fixed mask. */
export class SecretInput extends Input {
  override render(width: number): string[] {
    const available = Math.max(0, width - 3);
    const length = [...this.getValue()].length;
    const mask = length > available ? `${"*".repeat(Math.max(0, available - 1))}…` : "*".repeat(length);
    const marker = this.focused ? CURSOR_MARKER : "";
    return [`> ${mask}${marker}\x1b[7m \x1b[27m${" ".repeat(Math.max(0, available - mask.length - 1))}`];
  }
}

/** Input.setValue preserves cursor position; setup defaults should instead edit from the end. */
export function setInitialValue(input: Input, value: string): void { input.setValue(value); input.handleInput("\x05"); }
