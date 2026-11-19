import { ZipFile } from 'yazl';
import { Readable } from 'node:stream';
import type { ExportFile } from '@gym/core';

/**
 * A ZIP that is streamed rather than built.
 *
 * The deploy target gives a request 120 seconds and the container 512MB, and
 * a gym with four years of attendance has a few hundred thousand rows. So
 * nothing here holds the archive, or even one file of it, in memory: each
 * CSV is produced a page at a time, deflated as it goes, and pushed to the
 * client. The response starts arriving within a second, which also means a
 * browser shows a download rather than appearing to hang.
 *
 * Deliberately not an in-memory Buffer with a Content-Length. A known length
 * would be nicer for progress bars and would require building the whole
 * thing first — which is the one thing that cannot be done here.
 */
export function zipStream(files: ExportFile[]): ReadableStream<Uint8Array> {
  const zip = new ZipFile();

  for (const file of files) {
    // Each file's generator is turned into a Node stream, so yazl pulls from
    // it at the rate the client can take the bytes.
    zip.addReadStream(Readable.from(toBuffers(file.contents)), file.name, {
      // Dates inside the archive are the moment of export: CSVs have no
      // meaningful mtime of their own and a fixed epoch looks like a bug.
      mtime: new Date(),
      mode: 0o644,
    });
  }

  zip.end();

  // yazl's output is a Node stream; the route needs a web stream. The cast
  // is because @types/yazl types outputStream as the DOM ReadableStream
  // rather than the Node one it actually is.
  return Readable.toWeb(
    zip.outputStream as unknown as Readable,
  ) as ReadableStream<Uint8Array>;
}

async function* toBuffers(contents: AsyncGenerator<string>): AsyncGenerator<Buffer> {
  // A BOM, because Excel on Windows reads a UTF-8 CSV as the system
  // codepage otherwise, and an Indian gym's member list is full of names
  // that then arrive as mojibake. Three bytes to avoid a support call.
  yield Buffer.from([0xef, 0xbb, 0xbf]);
  for await (const chunk of contents) yield Buffer.from(chunk, 'utf8');
}

/** A filename a person can find again on their desktop. */
export function exportFilename(gymName: string, suffix = 'export'): string {
  const slug = gymName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'gym';
  return `${slug}-${suffix}-${new Date().toISOString().slice(0, 10)}.zip`;
}
