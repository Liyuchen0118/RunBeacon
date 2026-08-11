import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function writeAcceptanceReport({
  kind,
  output,
  startedAt,
  checks,
  details = {},
}) {
  const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../..'
  );
  const core = JSON.parse(
    fs.readFileSync(path.join(root, 'package.json'), 'utf8')
  );
  const plugin = JSON.parse(
    fs.readFileSync(
      path.join(root, 'packages', 'codex-plugin', 'package.json'),
      'utf8'
    )
  );
  const report = {
    schemaVersion: 1,
    kind,
    passed: Object.values(checks).every((value) => value === true),
    commitSha: requiredEnvironment('GITHUB_SHA'),
    coreVersion: core.version,
    runnerVersion: core.version,
    pluginVersion: plugin.version,
    startedAt,
    finishedAt: new Date().toISOString(),
    checks,
    details,
  };
  if (!report.passed)
    throw new Error(`${kind} acceptance checks did not all pass`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600,
  });
  return report;
}

export function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
