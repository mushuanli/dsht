/** Process-local recall history; never stores transcripts or writes prompt text to disk.
 *
 * `record` bounds what a session seeds and what its own submissions retain. `prepend` adds prompts
 * the reader explicitly paged back to, so the buffer may grow while reading history and the next
 * submission trims it to the budgets again.
 */
export class InputHistory {
  private entries: string[] = [];
  private bytes = 0;
  private position: number | undefined;
  private draft = '';

  /** Remember submitted input, coalescing consecutive duplicates and enforcing both budgets.
   * @param value - Submitted command or prompt, excluding interaction answers.
   */
  record(value: string): void {
    this.reset();
    if (!value || this.entries.at(-1) === value || value.length * 2 > 256 * 1024) return;
    this.entries.push(value); this.bytes += value.length * 2;
    while (this.entries.length > 200 || this.bytes > 256 * 1024) this.bytes -= this.entries.shift()!.length * 2;
  }

  /** Leave recall navigation when the composer is edited or otherwise replaced. */
  reset(): void { this.position = undefined; this.draft = ''; }

  /** Retained entry count, so a caller can tell an empty buffer from a parked cursor. */
  get length(): number { return this.entries.length; }

  /** Whether recall is parked on the oldest retained entry. */
  get atOldest(): boolean { return this.position === 0; }

  /** Fold prompts discovered by paging older history in front of the retained window.
   *
   * An active cursor shifts with the inserted entries, so the entry it pointed at stays selected
   * and the next `move(-1)` reaches the older ones. Prepending deliberately does not evict: the
   * budgets bound what a session seeds and what submissions retain, while reading further back is
   * the user's explicit request and the next submission trims the buffer again.
   * @param values - Older prompts in session order, oldest first.
   */
  prepend(values: readonly string[]): void {
    const older = values.filter(value => value !== '' && value.length * 2 <= 256 * 1024);
    if (!older.length) return;
    this.entries = [...older, ...this.entries];
    this.bytes += older.reduce((sum, value) => sum + value.length * 2, 0);
    if (this.position !== undefined) this.position += older.length;
  }

  /** Recall older/newer input, restoring the original unsent draft at the end.
   * @param direction - Negative for older input, positive for newer input.
   * @param current - Current composer content before beginning recall.
   * @returns Recalled input, or the original draft when returning to the newest position.
   */
  move(direction: -1 | 1, current: string): string {
    if (!this.entries.length) return current;
    if (this.position === undefined) {
      if (direction > 0) return current;
      this.position = this.entries.length; this.draft = current;
    }
    this.position = Math.max(0, Math.min(this.entries.length, this.position + direction));
    if (this.position === this.entries.length) {
      const draft = this.draft; this.reset(); return draft;
    }
    return this.entries[this.position]!;
  }
}
