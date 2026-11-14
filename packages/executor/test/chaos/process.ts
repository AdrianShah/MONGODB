import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const PKG_ROOT = fileURLToPath(new URL("../..", import.meta.url));

export interface ExecutorProcess {
  child: ChildProcess;
  /** Resolves on the "ready" log line; rejects if the process exits first. */
  ready: Promise<void>;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  output(): string;
  stop(): Promise<void>;
}

export function spawnExecutor(env: Record<string, string | undefined>): ExecutorProcess {
  const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
    cwd: PKG_ROOT,
    env: { ...process.env, CRASH_AT: undefined, CRASH_ON_HIT: undefined, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let onReady: () => void;
  const readySeen = new Promise<void>((r) => (onReady = r));
  const collect = (chunk: Buffer) => {
    out += chunk.toString();
    if (/\[executor\] ready/.test(out)) onReady();
  };
  child.stdout!.on("data", collect);
  child.stderr!.on("data", collect);

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.on("exit", (code, signal) => resolve({ code, signal })),
  );
  const ready = Promise.race([
    readySeen,
    exited.then(({ code, signal }) => {
      throw new Error(`executor exited before ready (code=${code}, signal=${signal})\n${out}`);
    }),
  ]);
  ready.catch(() => {}); // Callers that expect a crash before ready never await this.

  return {
    child,
    ready,
    exited,
    output: () => out,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
        await exited;
        clearTimeout(timer);
      }
    },
  };
}

export async function expectKilled(p: ExecutorProcess, timeoutMs = 15_000): Promise<void> {
  const result = await Promise.race([
    p.exited,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`executor did not crash within ${timeoutMs}ms\n${p.output()}`)), timeoutMs),
    ),
  ]);
  if (result.signal !== "SIGKILL") {
    throw new Error(`expected SIGKILL, got code=${result.code} signal=${result.signal}\n${p.output()}`);
  }
}
