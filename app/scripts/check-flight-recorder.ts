// Failure-only diagnostics for fictional, isolated browser checks. Never retain request headers or bodies.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function failureText(error: unknown) {
  // Playwright appends request headers (including the session cookie) after the first message line.
  return error instanceof Error ? { name: error.name, message: error.message.split('\n')[0],
    code: (error as NodeJS.ErrnoException).code } : { message: String(error).split('\n')[0] };
}
export class CheckFlightRecorder {
  readonly events: { ms: number; event: string; [key: string]: unknown }[] = [];
  private readonly started = performance.now();
  private failed = false;
  private printed = false;
  private out: string;
  private state: () => Record<string, unknown>;
  constructor(out: string, state: () => Record<string, unknown>) {
    this.out = out;
    this.state = state;
    // Unlike unhandledRejection/uncaughtException handlers, this monitor cannot consume the original crash.
    process.on('uncaughtExceptionMonitor', (error, origin) => {
      this.fail('uncaught', { origin, error: failureText(error) });
      this.save();
    });
    process.on('exit', code => {
      if (code) this.fail('exit', { code });
      this.save();
    });
  }
  record(event: string, values: Record<string, unknown> = {}) {
    this.events.push({ ms: performance.now() - this.started, event, ...values });
  }
  fail(event: string, values: Record<string, unknown> = {}) {
    this.failed = true;
    this.record(event, { ...this.state(), ...values });
  }
  save() {
    if (!this.failed) return;
    const text = JSON.stringify({ state: this.state(), events: this.events }, null, 2) + '\n';
    writeFileSync(join(this.out, 'flight-recorder.json'), text);
    if (!this.printed) { this.printed = true; console.error('FLIGHT RECORDER\n' + text); }
  }
}
