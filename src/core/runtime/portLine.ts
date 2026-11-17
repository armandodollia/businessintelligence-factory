/**
 * The one line the server prints on its standard output when the port it listens on was chosen at
 * start (design §4.1): `BIF_PORT=<port>`. The shell that started the server reads its output line by
 * line and takes the port from this line; every other line is for people.
 */
const LINE = /^BIF_PORT=(\d{1,5})\r?$/;

export function portLine(port: number): string {
  return `BIF_PORT=${port}`;
}

/** The port of a port line; undefined for any other line. */
export function parsePortLine(line: string): number | undefined {
  const m = LINE.exec(line);
  if (!m) return undefined;
  const port = Number(m[1]);
  return port >= 1 && port <= 65535 ? port : undefined;
}
