import { createInterface, type Interface as ReadlineInterface } from "node:readline";

/**
 * Prompt queue over readline 'line' events. readline/promises `question()` loses lines that arrive
 * between awaits under piped input (same-tick chunks race the next listener registration), so
 * onboarding buffers lines itself.
 */
export function lineQueue(input: ReadlineInterface): ((prompt: string) => Promise<string>) & { close(): void } {
  const buffered: string[] = [];
  const waiters: Array<(line: string) => void> = [];
  input.on("line", (line: string) => { const waiter = waiters.shift(); if (waiter) waiter(line); else buffered.push(line); });
  const ask = (prompt: string): Promise<string> => {
    input.setPrompt(prompt);
    input.prompt();
    const { promise, resolve } = Promise.withResolvers<string>();
    const bufferedLine = buffered.shift();
    if (bufferedLine !== undefined) resolve(bufferedLine);
    else waiters.push(resolve);
    return promise;
  };
  return Object.assign(ask, { close: () => input.close() });
}

export function stdioQueue(): ((prompt: string) => Promise<string>) & { close(): void } {
  return lineQueue(createInterface({ input: process.stdin, output: process.stdout, terminal: false }));
}
