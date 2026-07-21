// Types for web/md.js. The renderer stays a plain classic script (index.html loads it via
// <script src="md.js"> and its inline script uses the globals), so TS code reaches it through a
// side-effect import plus these global declarations - until the C1 module split makes it a real
// module with real exports.
export {};

declare global {
  /** Escape a string for HTML *text* content (& < > only - never enough for attribute values). */
  function esc(s: unknown): string;
  /** Escape a string for an HTML attribute value (& < > " '). */
  function escAttr(s: unknown): string;
  /** Render the console's markdown subset to HTML. Every interpolation is escaped; link targets are scheme-allowlisted. */
  function md(src: unknown): string;
  /** The same render, split into one HTML string per top-level block — the seam the chat pane uses to
   *  diff a streamed answer and touch only the DOM of the block that actually changed. */
  function mdBlocks(src: unknown): string[];
}
