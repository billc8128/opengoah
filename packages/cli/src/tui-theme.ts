const enabled = !process.env.NO_COLOR && process.env.TERM !== "dumb";
const paint = (open: string, value: string): string =>
  enabled ? `\u001b[${open}m${value}\u001b[0m` : value;

export const tuiTheme = {
  brand: (value: string) => paint("1;38;5;231;48;5;33", value),
  rail: (value: string) => paint("38;5;252;48;5;17", value),
  accent: (value: string) => paint("1;38;5;33", value),
  human: (value: string) => paint("1;38;5;75", value),
  userMessage: (value: string) => paint("38;5;236;48;5;230", value),
  strong: (value: string) => paint("1", value),
  underline: (value: string) => paint("4", value),
  muted: (value: string) => paint("38;5;243", value),
  subtle: (value: string) => paint("38;5;244", value),
  success: (value: string) => paint("38;5;35", value),
  warning: (value: string) => paint("38;5;214", value),
  error: (value: string) => paint("38;5;196", value),
  active: (value: string) => paint("1;38;5;17;48;5;75", value),
};

export function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}
