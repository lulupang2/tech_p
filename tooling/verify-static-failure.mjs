import { access, copyFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { fileURLToPath } from 'node:url';

const rootDirectory = fileURLToPath(new URL('../', import.meta.url));
const fixtureUrl = new URL('./fixtures/intentional-static-failure.ts', import.meta.url);
const targetUrl = new URL(
  '../packages/domain/src/__intentional_static_failure__.ts',
  import.meta.url,
);

try {
  await access(targetUrl, constants.F_OK);
  throw new Error(`Refusing to overwrite existing fixture target: ${targetUrl.pathname}`);
} catch (error) {
  if (error?.code !== 'ENOENT') {
    throw error;
  }
}

try {
  await copyFile(fixtureUrl, targetUrl);

  const result = await new Promise((resolve, reject) => {
    const child =
      process.platform === 'win32'
        ? spawn('pnpm.cmd run static', {
            cwd: rootDirectory,
            shell: true,
            stdio: 'inherit',
          })
        : spawn('pnpm', ['run', 'static'], {
            cwd: rootDirectory,
            stdio: 'inherit',
          });

    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });

  if (result.code === 0) {
    throw new Error('Expected `pnpm run static` to fail for the intentional fixture.');
  }
} finally {
  await rm(targetUrl, { force: true });
}
