import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { finalizeReleaseReview, ReleaseReviewError } from './release-review.js';

/** No .env, DB, provider or ledger access. Existing files can never be overwritten. */
export async function runReleaseReviewCli(args: readonly string[]): Promise<number> {
  try {
    const paths = new Map<string, string>();
    for (const argument of args) {
      const match = /^--(report|review|output)=(.+)$/u.exec(argument);
      if (!match || paths.has(match[1]!)) throw new ReleaseReviewError('arguments');
      paths.set(match[1]!, resolve(match[2]!));
    }
    if (paths.size !== 3) throw new ReleaseReviewError('arguments');
    const [source, review] = await Promise.all([
      readFile(paths.get('report')!, 'utf8'),
      readFile(paths.get('review')!, 'utf8'),
    ]);
    const acceptance = finalizeReleaseReview(source, review);
    await writeFile(paths.get('output')!, JSON.stringify(acceptance, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    console.log(
      JSON.stringify({
        task: acceptance.task,
        sourceReportSha256: acceptance.sourceReportSha256,
        releaseGatePassed: acceptance.releaseGatePassed,
      }),
    );
    return acceptance.releaseGatePassed ? 0 : 2;
  } catch (error) {
    // Parser and filesystem errors can include private paths or input fragments.
    console.error(error instanceof ReleaseReviewError ? error.message : 'release_review_io_failed');
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runReleaseReviewCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
