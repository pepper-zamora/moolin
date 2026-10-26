export type SelectAllTarget = "scrollback" | "input";

// Where Select All (Cmd/Ctrl+A) goes. Typed at the input line, it should select
// the line, so what's there can be typed over; but while something is selected
// in the scrollback, it should select the whole scrollback. A request that
// names its target (the context menu knows which was right-clicked) gets it.
// With nothing to type in (not connected), the scrollback is all there is.
export function chooseSelectAllTarget(
  requested: SelectAllTarget | undefined,
  scrollbackHasSelection: boolean,
  inputUsable: boolean,
): SelectAllTarget {
  if (requested) return requested;
  return scrollbackHasSelection || !inputUsable ? "scrollback" : "input";
}
