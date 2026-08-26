import type { Readable } from 'node:stream';
import yauzl from 'yauzl';

/**
 * Opens one ZIP entry as a stream, without extracting the archive (bulk files expand to several
 * gigabytes).
 */
export function openZipEntry(zipPath: string, match: (fileName: string) => boolean): Promise<Readable> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: false }, (openError, zipFile) => {
      if (openError || !zipFile) {
        reject(openError ?? new Error(`Unable to open ${zipPath}`));
        return;
      }

      let found = false;

      zipFile.on('entry', (entry: yauzl.Entry) => {
        if (!match(entry.fileName)) {
          zipFile.readEntry();
          return;
        }

        found = true;
        zipFile.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            reject(streamError ?? new Error(`Unable to read ${entry.fileName} from ${zipPath}`));
            return;
          }
          stream.on('end', () => zipFile.close());
          resolve(stream as unknown as Readable);
        });
      });

      zipFile.on('end', () => {
        if (!found) {
          zipFile.close();
          reject(new Error(`No matching entry found in ${zipPath}`));
        }
      });

      zipFile.on('error', reject);
      zipFile.readEntry();
    });
  });
}

/**
 * The entry names of an archive, without reading them.
 *
 * The Australian extract has ten XML files in one ZIP and the Japanese one a CSV next to its
 * signature. yauzl only reads the central directory for this.
 */
export function listZipEntries(zipPath: string, match: (fileName: string) => boolean = () => true): Promise<string[]> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (openError, zipFile) => {
      if (openError || !zipFile) {
        reject(openError ?? new Error(`Unable to open ${zipPath}`));
        return;
      }

      const names: string[] = [];
      zipFile.on('entry', (entry: yauzl.Entry) => {
        if (match(entry.fileName)) names.push(entry.fileName);
        zipFile.readEntry();
      });
      zipFile.on('end', () => resolve(names));
      zipFile.on('error', reject);
      zipFile.readEntry();
    });
  });
}

/**
 * Every matching entry of an archive, in order, as streams, with one open for the whole archive.
 *
 * The Russian register has 7,519 XML files in a 2 GB archive, so reopening it per entry would be
 * too slow. The next entry is only read after the loop body is done with the current one, so memory
 * stays at one entry.
 */
export async function* openZipEntries(
  zipPath: string,
  match: (fileName: string) => boolean = () => true,
): AsyncGenerator<{ name: string; stream: Readable }> {
  const zipFile = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: false }, (openError, opened) => {
      if (openError || !opened) reject(openError ?? new Error(`Unable to open ${zipPath}`));
      else resolve(opened);
    });
  });

  /** The next requested entry, or null at the end. */
  const next = (): Promise<yauzl.Entry | null> =>
    new Promise((resolve, reject) => {
      const onEntry = (entry: yauzl.Entry): void => {
        if (match(entry.fileName)) {
          cleanup();
          resolve(entry);
          return;
        }
        zipFile.readEntry();
      };
      const onEnd = (): void => {
        cleanup();
        resolve(null);
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const cleanup = (): void => {
        zipFile.off('entry', onEntry);
        zipFile.off('end', onEnd);
        zipFile.off('error', onError);
      };
      zipFile.on('entry', onEntry);
      zipFile.on('end', onEnd);
      zipFile.on('error', onError);
      zipFile.readEntry();
    });

  try {
    for (let entry = await next(); entry !== null; entry = await next()) {
      const stream = await new Promise<Readable>((resolve, reject) => {
        zipFile.openReadStream(entry, (streamError, opened) => {
          if (streamError || !opened) reject(streamError ?? new Error(`Unable to read ${entry.fileName}`));
          else resolve(opened as unknown as Readable);
        });
      });
      try {
        yield { name: entry.fileName, stream };
      } finally {
        // Whether the loop read the entry fully or broke out, the archive cannot advance until this stream
        // is finished.
        stream.destroy();
      }
    }
  } finally {
    zipFile.close();
  }
}
