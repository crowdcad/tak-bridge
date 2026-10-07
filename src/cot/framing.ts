// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Splits a TAK streaming connection into individual CoT messages.
 *
 * TAK Server sends XML CoT events back to back with no delimiter, each
 * optionally preceded by an XML declaration, and TCP delivers them in
 * arbitrary chunks. CotFramer buffers chunks and returns each complete
 * `<event ...>...</event>` (or self-closing `<event .../>`) as a string.
 *
 * The buffer is capped. If no complete event appears within maxBufferBytes, the
 * buffer is dropped and framing resyncs on the next `<event`, so one malformed
 * or huge message cannot grow memory without bound.
 */
export class CotFramer {
  private buffer = '';
  private droppedBytes = 0;

  constructor(private readonly maxBufferBytes = 1024 * 1024) {}

  /** Bytes discarded so far because they were not part of an event, or overflowed the buffer. */
  get discarded(): number {
    return this.droppedBytes;
  }

  push(chunk: string): string[] {
    this.buffer += chunk;
    const events: string[] = [];

    for (;;) {
      const start = findEventStart(this.buffer);
      if (start < 0) {
        // Keep a short tail in case "<event" is split across chunks.
        const keep = Math.min(this.buffer.length, 6);
        this.droppedBytes += this.buffer.length - keep;
        this.buffer = this.buffer.slice(this.buffer.length - keep);
        break;
      }
      if (start > 0) {
        this.droppedBytes += start;
        this.buffer = this.buffer.slice(start);
      }

      const end = findEventEnd(this.buffer);
      if (end < 0) {
        if (this.buffer.length > this.maxBufferBytes) {
          // Drop the oversized partial event and resync after its opening tag.
          this.droppedBytes += 1;
          this.buffer = this.buffer.slice(1);
          continue;
        }
        break;
      }
      events.push(this.buffer.slice(0, end));
      this.buffer = this.buffer.slice(end);
    }
    return events;
  }
}

/** Index of the next `<event` tag (not `<events` or similar), or -1. */
function findEventStart(s: string): number {
  let from = 0;
  for (;;) {
    const i = s.indexOf('<event', from);
    if (i < 0) return -1;
    const next = s[i + 6];
    if (next === undefined) return -1; // incomplete; wait for more data
    if (next === ' ' || next === '>' || next === '\n' || next === '\r' || next === '\t' || next === '/') return i;
    from = i + 1;
  }
}

/** For a buffer starting at `<event`, the index just past the end of the event, or -1 if incomplete. */
function findEventEnd(s: string): number {
  const tagClose = s.indexOf('>');
  if (tagClose < 0) return -1;
  if (s[tagClose - 1] === '/') return tagClose + 1; // <event ... />
  const close = s.indexOf('</event>', tagClose);
  return close < 0 ? -1 : close + '</event>'.length;
}
