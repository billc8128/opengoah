import { homedir } from "node:os";

const SENSITIVE_FIELD =
  /^(?:api[_-]?key|token|(?:lease|fencing|access|refresh|auth)[_-]?token|secret|password|authorization|cookie|set-cookie)$/i;
const CREDENTIAL_ASSIGNMENT =
  /(?:api[ _-]?(?:key|password)|password|token|secret|authorization)\s*[:=]\s*[^\s,;"']{6,}/i;
const TOKEN_SHAPE = /\b(?:sk|ak|ark|npm)[-_][A-Za-z0-9._-]{12,}\b/i;

export function looksLikeCredential(value: string): boolean {
  return (
    CREDENTIAL_ASSIGNMENT.test(value) ||
    TOKEN_SHAPE.test(value) ||
    /\bBearer\s+[^\s"']{12,}/i.test(value)
  );
}
export function redactSensitiveText(value: string): string {
  return value
    .replaceAll(homedir(), "<HOME>")
    .replace(/\bBearer\s+[^\s"']+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk|ak|ark|npm|key)[-_][A-Za-z0-9._-]{12,}\b/gi, "[REDACTED]")
    .replace(
      /((?:api[ _-]?(?:key|password)|token|secret|password|authorization)\s*[:=]\s*)[^\s,;"']+/gi,
      "$1[REDACTED]",
    );
}
export function redactSensitiveValue(value: unknown, key = ""): unknown {
  if (SENSITIVE_FIELD.test(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((item) => redactSensitiveValue(item));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [
        childKey,
        redactSensitiveValue(child, childKey),
      ]),
    );
  return typeof value === "string" ? redactSensitiveText(value) : value;
}
