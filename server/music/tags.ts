/**
 * Tag text as a person would read it. A fixed-width tag field pads its value with
 * NULs, so a title read straight from the frame keeps them; this drops every one,
 * which is also right for the interior padding a UTF-16 field can carry.
 */
export function stripPadding(value: string): string {
  return value.split("\u0000").join("").trim();
}
