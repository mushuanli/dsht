/** Mount a component on a terminal whose size the test chooses.
 *
 * `ink-testing-library` fixes the output at 100 columns with no height, so a test about wrapping or
 * page sizes cannot use it. Ink reads both values from the output stream it renders into, so this
 * module supplies those streams and reuses the same render entry point.
 */
import { EventEmitter } from 'node:events';
import { render } from 'ink';
import type { ReactElement } from 'react';

/** Ink output stream recording every frame and reporting the size the test chose. */
class TestOutput extends EventEmitter {
  readonly frames: string[] = [];
  private last?: string;
  constructor(readonly columns: number, readonly rows: number) { super(); }
  write = (frame: string) => { this.frames.push(frame); this.last = frame; };
  /** @returns The most recently written frame, or undefined before the first one. */
  lastFrame = (): string | undefined => this.last;
}

/** Ink input stream; writing a value delivers that key sequence to the mounted tree. */
class TestInput extends EventEmitter {
  isTTY = true;
  private data: string | null = null;
  write = (data: string) => { this.data = data; this.emit('readable'); this.emit('data', data); };
  setEncoding(): void {}
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}
  read = (): string | null => { const { data } = this; this.data = null; return data; };
}

/** A mounted tree plus the streams that feed and capture it. */
export interface TestTerminal {
  /** Latest frame; undefined before the first render. */
  lastFrame(): string | undefined;
  /** Deliver one key sequence. */
  press(value: string): void;
  /** Unmount the tree and release Ink's internal state. */
  close(): void;
}

/** Mount one element on a terminal of the given size.
 * @param tree - Element to render.
 * @param columns - Terminal columns.
 * @param rows - Terminal rows.
 * @returns Frame access, key delivery and teardown.
 */
export function renderAt(tree: ReactElement, columns: number, rows: number): TestTerminal {
  const stdout = new TestOutput(columns, rows);
  const stdin = new TestInput();
  const stderr = new TestOutput(columns, rows);
  const instance = render(tree, { stdout: stdout as never, stdin: stdin as never, stderr: stderr as never,
    debug: true, exitOnCtrlC: false, patchConsole: false });
  return {
    lastFrame: () => stdout.lastFrame(),
    press: value => stdin.write(value),
    close: () => { instance.unmount(); instance.cleanup(); },
  };
}
