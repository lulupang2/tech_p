import { runOpsCli } from './cli.js';

const result = await runOpsCli(process.argv.slice(2));

if (result.output !== null && result.output !== undefined) {
  const output =
    typeof result.output === 'string' ? result.output : JSON.stringify(result.output, null, 2);
  process.stdout.write(`${output}\n`);
}
if (result.error) {
  process.stderr.write(`${result.error}\n`);
}

process.exitCode = result.exitCode;
