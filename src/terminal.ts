import { createInterface } from "node:readline";
import { Writable } from "node:stream";

export interface TerminalIO {
  readonly interactive: boolean;
  ask(prompt: string, secret?: boolean): Promise<string | null>;
  write(text: string): void;
  onInterrupt(listener: () => void): () => void;
  close(): void;
}

/** Escape terminal control sequences without changing saved/model message text. */
export function safeText(text: string): string {
  return text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g,
    c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export function createTerminal(): TerminalIO {
  let muted = false;
  const output = new Writable({ write(chunk, _encoding, done) {
    if (!muted) process.stdout.write(chunk);
    done();
  } });
  const interactive = !!process.stdin.isTTY && !!process.stdout.isTTY;
  const rl = createInterface({ input: process.stdin, output, terminal: interactive, historySize: 0 });
  const queue: string[] = [];
  let waiter: ((value: string | null) => void) | undefined;
  let closed = false;
  const listeners = new Set<() => void>();
  rl.on("line", line => {
    if (waiter) { const next = waiter; waiter = undefined; next(line); }
    else queue.push(line);
  });
  rl.on("close", () => { closed = true; waiter?.(null); waiter = undefined; });
  const interrupt = () => {
    if (listeners.size) for (const listener of listeners) listener();
    else rl.close();
  };
  rl.on("SIGINT", interrupt);
  process.on("SIGINT", interrupt);
  return {
    interactive,
    async ask(prompt, secret = false) {
      if (closed && queue.length === 0) return null;
      if (secret && !interactive) throw new Error("密钥仅可在真实终端隐藏输入；非交互模式请配置环境变量。");
      // Never consume already buffered lines as a hidden credential.
      if (secret && (queue.length || rl.line.length)) throw new Error("密钥输入前检测到预先输入的文本，请重新启动并逐项输入。");
      process.stdout.write(safeText(prompt));
      muted = secret;
      try {
        if (queue.length) return queue.shift()!;
        return await new Promise<string | null>(resolve => { waiter = resolve; });
      } finally {
        muted = false;
        if (secret) process.stdout.write("\n");
      }
    },
    write(text) { process.stdout.write(safeText(text)); },
    onInterrupt(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    close() { muted = false; queue.length = 0; closed = true; rl.close(); process.off("SIGINT", interrupt); output.end(); },
  };
}
