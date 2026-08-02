import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { JobRecord } from './types.js';

interface StoreDocument {
  version: 1;
  savedAt: string;
  jobs: JobRecord[];
}

export class JobStore {
  constructor(
    private readonly filePath: string,
    private readonly persistOutput = false
  ) {}

  load(): JobRecord[] {
    if (!existsSync(this.filePath)) return [];

    try {
      const document = JSON.parse(
        readFileSync(this.filePath, 'utf8')
      ) as StoreDocument;
      if (document.version !== 1 || !Array.isArray(document.jobs)) return [];
      return document.jobs;
    } catch {
      return [];
    }
  }

  save(jobs: JobRecord[]): void {
    const directory = dirname(this.filePath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });

    const document: StoreDocument = {
      version: 1,
      savedAt: new Date().toISOString(),
      jobs: jobs.map((job) => ({
        ...job,
        // Command output can contain secrets. Persistence is explicit opt-in.
        output: this.persistOutput ? job.output : [],
      })),
    };

    const temporaryPath = `${this.filePath}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify(document, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
    if (process.platform !== 'win32') chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, this.filePath);
    if (process.platform !== 'win32') chmodSync(this.filePath, 0o600);
  }
}
