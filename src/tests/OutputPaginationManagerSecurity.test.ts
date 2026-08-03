import { createHash } from 'node:crypto';
import { OutputPaginationManager } from '../core/OutputPaginationManager.js';

describe('OutputPaginationManager security', () => {
  let manager: OutputPaginationManager;

  beforeEach(() => {
    manager = new OutputPaginationManager();
  });

  afterEach(() => {
    manager.destroy();
  });

  test('uses SHA-256 for buffer integrity checks', () => {
    const buffer = {
      sessionId: 'security-test',
      outputs: [],
      lineIndex: new Map(),
      createdAt: 1,
      lastAccessed: 2,
      totalLines: 3,
    };

    const checksum = (manager as any).calculateBufferChecksum(buffer);
    expect(checksum).toBe(
      createHash('sha256').update('security-test:3:2').digest('hex')
    );
    expect(checksum).toHaveLength(64);
  });

  test('uses UUID-format identifiers for continuation tokens', () => {
    const encoded = (manager as any).createContinuationToken({
      sessionId: 'security-test',
      offset: 10,
      limit: 10,
      timestamp: Date.now(),
      checksum: 'a'.repeat(64),
    });
    const decoded = JSON.parse(Buffer.from(encoded, 'base64url').toString());

    expect(decoded.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
    );
  });
});
