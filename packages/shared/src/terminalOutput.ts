/** Removes ANSI escape sequences and non-printing terminal controls from display text. */
export function stripTerminalControl(text: string): string {
  return (
    text
      .replace(
        // eslint-disable-next-line no-control-regex
        /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[()][A-Za-z0-9]|\u001b[=>]/g,
        "",
      )
      // Keep tabs, line feeds, and carriage returns because callers may render
      // terminal output in a preformatted block.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
  );
}
