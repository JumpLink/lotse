/**
 * How the entry point waits for the command, without a top-level `await`.
 *
 * On GJS a pending top-level await in the entry module leaves GJS in its own `MainLoop::spin`, which
 * polls `g_main_context_pending` without ever sleeping: a `lotse serve` that merely waits for its next
 * minute burned a whole core (measured on GJS 1.88.1, and reproducible with a plain `gjs -m` script
 * that awaits one timer). So on GJS the command is driven fire-and-forget and a GLib main loop is run
 * synchronously instead, which blocks in `poll` until there is something to do. Curlew's entry does the
 * same for the same reason.
 *
 * The loop ends with `process.exit`, never by returning: gjsify idle-schedules `MainLoop.quit()` and
 * `system.exit()` there, whereas a bare `system.exit()` from an async continuation hangs.
 */

export interface MainLoop {
  run(): void;
}

export interface MainHost {
  /** A GLib main loop, on GJS; `null` on Node, whose event loop is always on. */
  readonly loop: MainLoop | null;
  readonly exit: (code?: number) => void;
  readonly report: (error: unknown) => void;
  readonly exitCode: () => number | undefined;
}

export function runMain(parsed: Promise<unknown>, host: MainHost): void {
  const failed = (error: unknown) => {
    host.report(error);
    // `exit`, not `exitCode`: a gate that decided nothing and left a child process behind is worse
    // than a non-zero exit.
    host.exit(host.exitCode() || 1);
  };
  parsed.then(() => {
    // The natural end of main ignores `process.exitCode` on gjsify (fixed upstream in gjsify#2007, not
    // in a release yet), and a loop that is still running never ends by itself.
    if (host.loop || host.exitCode()) host.exit(host.exitCode() ?? 0);
  }, failed);
  host.loop?.run();
}

/** The GLib main loop when running on GJS. `imports` rather than `gi://`: this runs before any module graph. */
export function gjsMainLoop(): MainLoop | null {
  const imports = (
    globalThis as {
      imports?: { gi?: { GLib?: { MainLoop: new (ctx: null, running: boolean) => MainLoop } } };
    }
  ).imports;
  const GLib = imports?.gi?.GLib;
  return GLib ? new GLib.MainLoop(null, false) : null;
}
