/** Pin frame styling before Ink loads, so rendered frames do not depend on the ambient terminal.
 *
 * Ink styles every frame through chalk's default instance, and chalk latches its color level from
 * the ambient terminal during its first import: a pipe or a `dumb` terminal yields plain text,
 * while a real terminal interleaves SGR escapes between the prompt and the text around it. Recorded
 * expectations and substring assertions in this suite describe text, so an escape sequence must not
 * decide whether they match.
 *
 * Import this module first: it only affects the level chalk latches during that first import, so the
 * value stays for the lifetime of the process and cannot be restored afterwards.
 */
process.env.FORCE_COLOR = '0';
