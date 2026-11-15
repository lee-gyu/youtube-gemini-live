import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';

export interface ExecResult {
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  /** Stream piped into the child's stdin. */
  stdin?: Readable;
}

/** Runs an external tool (yt-dlp, ffmpeg) and rejects with its stderr on failure. */
export function exec(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: [opts.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout!.on('data', (d: Buffer) => stdout.push(d));
    child.stderr!.on('data', (d: Buffer) => stderr.push(d));

    if (opts.stdin && child.stdin) {
      // The child may exit before reading everything; its exit code reports the real error.
      child.stdin.on('error', () => {});
      opts.stdin.on('error', (err) => {
        child.kill();
        reject(err);
      });
      opts.stdin.pipe(child.stdin);
    }

    child.on('error', (err: NodeJS.ErrnoException) => {
      reject(
        err.code === 'ENOENT'
          ? new Error(`${cmd} 실행 파일을 찾을 수 없습니다. \`mise install\`을 먼저 실행하세요.`)
          : err,
      );
    });
    child.on('close', (code) => {
      const result = {
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      };
      if (code === 0) resolve(result);
      else reject(new Error(`${cmd} 실패 (exit ${code})\n${result.stderr.trim()}`));
    });
  });
}
