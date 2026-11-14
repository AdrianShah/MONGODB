/** Child processes with labelled output, for `npm run services` and `npm run demo:rehearse`. */
import { spawn, type ChildProcess } from 'node:child_process';

export interface Proc {
  name: string;
  child: ChildProcess;
  output(): string;
  /** Resolves when a line matching `re` appears; rejects if the process exits first or after timeoutMs. */
  waitFor(re: RegExp, timeoutMs?: number): Promise<void>;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stop(): Promise<void>;
}

const COLORS = [36, 35, 33, 34, 32];

export function start(
  name: string,
  npmScript: string,
  args: string[] = [],
  opts: { env?: NodeJS.ProcessEnv; echo?: boolean; colorIndex?: number } = {},
): Proc {
  const child = spawn('npm', ['run', '-s', npmScript, ...(args.length ? ['--', ...args] : [])], {
    env: { ...process.env, ...opts.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });
  let out = '';
  const waiters: Array<() => void> = [];
  const tag = process.stdout.isTTY ? `\u001b[${COLORS[(opts.colorIndex ?? 0) % COLORS.length]}m[${name}]\u001b[0m` : `[${name}]`;
  let partial = '';
  const onData = (chunk: Buffer) => {
    const text = chunk.toString();
    out += text;
    if (opts.echo) {
      partial += text;
      const lines = partial.split('\n');
      partial = lines.pop() ?? '';
      for (const line of lines) process.stdout.write(`${tag} ${line}\n`);
    }
    for (const w of [...waiters]) w();
  };
  child.stdout!.on('data', onData);
  child.stderr!.on('data', onData);
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.on('exit', (code, signal) => {
      for (const w of [...waiters]) w();
      resolve({ code, signal });
    }),
  );

  return {
    name,
    child,
    output: () => out,
    exited,
    waitFor(re, timeoutMs = 30_000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${name}: no line matching ${re} within ${timeoutMs}ms\n${out}`)), timeoutMs);
        const check = () => {
          if (re.test(out)) {
            clearTimeout(timer);
            resolve();
          } else if (child.exitCode !== null || child.signalCode !== null) {
            clearTimeout(timer);
            reject(new Error(`${name} exited (code ${child.exitCode}, signal ${child.signalCode}) before ${re}\n${out}`));
          }
        };
        waiters.push(check);
        check();
      });
    },
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      await exited;
      clearTimeout(timer);
    },
  };
}

/** Runs an npm script to completion and returns its exit code and output. */
export async function run(npmScript: string, args: string[] = [], env?: NodeJS.ProcessEnv): Promise<{ code: number | null; output: string }> {
  const p = start(npmScript, npmScript, args, env ? { env } : {});
  const { code } = await p.exited;
  return { code, output: p.output() };
}
