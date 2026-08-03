import { createHash } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { createServer, Server } from 'node:https';
import { XenProtocol } from '../../src/protocols/XenProtocol.js';
import { VNCProtocol } from '../../src/protocols/VNCProtocol.js';

const forge: any = require('node-forge');

interface TestCertificate {
  certificatePem: string;
  privateKeyPem: string;
  fingerprint: string;
}

function createSelfSignedCertificate(): TestCertificate {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = keys.publicKey;
  certificate.serialNumber = Math.floor(Math.random() * 1e12).toString(16);
  certificate.validity.notBefore = new Date(Date.now() - 60_000);
  certificate.validity.notAfter = new Date(Date.now() + 24 * 60 * 60_000);
  const attributes = [{ name: 'commonName', value: '127.0.0.1' }];
  certificate.setSubject(attributes);
  certificate.setIssuer(attributes);
  certificate.setExtensions([
    { name: 'basicConstraints', cA: true },
    {
      name: 'keyUsage',
      digitalSignature: true,
      keyEncipherment: true,
      keyCertSign: true,
    },
    { name: 'extKeyUsage', serverAuth: true },
    {
      name: 'subjectAltName',
      altNames: [{ type: 7, ip: '127.0.0.1' }],
    },
  ]);
  certificate.sign(keys.privateKey, forge.md.sha256.create());
  const der = forge.asn1
    .toDer(forge.pki.certificateToAsn1(certificate))
    .getBytes();
  return {
    certificatePem: forge.pki.certificateToPem(certificate),
    privateKeyPem: forge.pki.privateKeyToPem(keys.privateKey),
    fingerprint: `sha256:${createHash('sha256')
      .update(Buffer.from(der, 'binary'))
      .digest('hex')}`,
  };
}

describe('Xen XAPI HTTPS security', () => {
  let certificate: TestCertificate;
  let otherCertificate: TestCertificate;
  let server: Server;
  let port: number;
  let mode: 'success' | 'timeout' | 'oversize' | 'invalid-json' | 'failure';
  let testRoot: string;
  let caPath: string;
  let wrongCaPath: string;

  beforeAll(() => {
    certificate = createSelfSignedCertificate();
    otherCertificate = createSelfSignedCertificate();
  });

  beforeEach(async () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xen-ca-'));
    caPath = path.join(testRoot, 'ca.pem');
    wrongCaPath = path.join(testRoot, 'wrong-ca.pem');
    fs.writeFileSync(caPath, certificate.certificatePem, { mode: 0o600 });
    fs.writeFileSync(wrongCaPath, otherCertificate.certificatePem, {
      mode: 0o600,
    });
    mode = 'success';
    server = createServer(
      {
        key: certificate.privateKeyPem,
        cert: certificate.certificatePem,
      },
      (request, response) => {
        if (mode === 'timeout') return;
        if (mode === 'failure') {
          response.writeHead(503).end('unavailable');
          return;
        }
        if (mode === 'oversize') {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end('x'.repeat(1024 * 1024 + 1));
          return;
        }
        if (mode === 'invalid-json') {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end('{not-json');
          return;
        }

        const chunks: Buffer[] = [];
        request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        request.on('end', () => {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({
              result: {
                Status: 'Success',
                Value:
                  body.method === 'session.login_with_password'
                    ? 'test-session'
                    : '',
              },
            })
          );
        });
      }
    );
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const candidate = 20_000 + Math.floor(Math.random() * 20_000);
      try {
        await new Promise<void>((resolve, reject) => {
          const onError = (error: Error) => {
            server.off('listening', onListening);
            reject(error);
          };
          const onListening = () => {
            server.off('error', onError);
            resolve();
          };
          server.once('error', onError);
          server.once('listening', onListening);
          server.listen(candidate);
        });
        break;
      } catch (error: any) {
        if (error?.code !== 'EADDRINUSE' || attempt === 19) throw error;
      }
    }
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    const fs = require('node:fs');
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  function config(overrides: Record<string, unknown> = {}) {
    return {
      host: '127.0.0.1',
      port,
      username: 'root',
      password: 'test-only',
      useSSL: true,
      timeout: 2_000,
      caFile: undefined,
      ...overrides,
    };
  }

  test('rejects plaintext XAPI and untrusted certificates', async () => {
    const protocol = new XenProtocol() as any;
    await expect(protocol.xapiLogin(config({ useSSL: false }))).rejects.toThrow(
      /requires HTTPS/
    );
    await expect(protocol.xapiLogin(config())).rejects.toThrow();
  });

  test('accepts an explicit CA and applies an additional SHA-256 pin', async () => {
    const protocol = new XenProtocol() as any;
    await expect(protocol.xapiLogin(config({ caFile: caPath }))).resolves.toBe(
      'test-session'
    );
    await expect(
      protocol.xapiLogin(
        config({
          caFile: caPath,
          serverCertSha256: certificate.fingerprint,
        })
      )
    ).resolves.toBe('test-session');
    await expect(
      protocol.xapiLogout(config({ caFile: caPath }), 'test-session')
    ).resolves.toBeUndefined();
  });

  test('rejects an incorrect certificate pin', async () => {
    const protocol = new XenProtocol() as any;
    await expect(
      protocol.xapiLogin(
        config({
          caFile: caPath,
          serverCertSha256: `sha256:${'0'.repeat(64)}`,
        })
      )
    ).rejects.toThrow(/fingerprint mismatch/);
  });

  test('rejects an incorrect CA', async () => {
    const protocol = new XenProtocol() as any;
    await expect(
      protocol.xapiLogin(config({ caFile: wrongCaPath }))
    ).rejects.toThrow();
  });

  test('rejects a hostname mismatch', async () => {
    const protocol = new XenProtocol() as any;
    await expect(
      protocol.xapiLogin(config({ host: 'localhost', caFile: caPath }))
    ).rejects.toThrow(/altname|IP|hostname/i);
  });

  test.each([
    ['oversize', /1 MiB/],
    ['failure', /HTTP status 503/],
    ['invalid-json', /invalid JSON/],
  ] as const)(
    'fails safely for %s responses',
    async (responseMode, message) => {
      const protocol = new XenProtocol() as any;
      mode = responseMode;
      await expect(
        protocol.xapiLogin(config({ caFile: caPath }))
      ).rejects.toThrow(message);
    }
  );

  test('fails safely when an XAPI request times out', async () => {
    const protocol = new XenProtocol() as any;
    mode = 'timeout';
    await expect(
      protocol.xapiLogin(config({ caFile: caPath, timeout: 1_000 }))
    ).rejects.toThrow(/timed out/);
  });

  test('validates timeout and fingerprint formats before network access', async () => {
    const protocol = new XenProtocol() as any;
    await expect(protocol.xapiLogin(config({ timeout: 999 }))).rejects.toThrow(
      /between 1000 and 120000/
    );
    await expect(
      protocol.xapiLogin(config({ serverCertSha256: 'sha256:bad' }))
    ).rejects.toThrow(/64 hexadecimal/);
  });
});

describe('VNC authentication security', () => {
  test('rejects raw VNC authentication and VeNCrypt PLAIN', async () => {
    const protocol = new VNCProtocol() as any;
    protocol.securityTypes = [2];
    expect(() => protocol.selectPreferredSecurity()).toThrow(
      /No compatible security type/
    );
    expect(() => protocol.selectVeNCryptSubtype([256])).toThrow(
      /No compatible VeNCrypt subtype/
    );
    await expect(protocol.handleVeNCryptSubtype(256)).rejects.toThrow(
      /PLAIN authentication is not permitted/
    );
  });

  test('rejects disabled or unauthorized TLS certificate validation', async () => {
    expect(
      () =>
        new VNCProtocol({
          tlsOptions: { enabled: true, rejectUnauthorized: false },
        } as any)
    ).toThrow(/cannot be disabled/);

    const protocol = new VNCProtocol({ password: 'test-only' }) as any;
    expect(() =>
      protocol.vncAuthChallenge(Buffer.alloc(16), 'test-only')
    ).toThrow(/certificate-verified TLS/);
    protocol.options.tlsOptions = {
      enabled: true,
      rejectUnauthorized: false,
    };
    await expect(protocol.upgradToTLS()).rejects.toThrow(/cannot be disabled/);
  });

  test('allows the RFC DES challenge only on an authorized TLS socket', () => {
    const protocol = new VNCProtocol({ password: 'test-only' }) as any;
    const authorizedSocket = { authorized: true };
    protocol.tlsSocket = authorizedSocket;
    protocol.socket = authorizedSocket;
    protocol.tlsVerified = true;

    const response = protocol.vncAuthChallenge(
      Buffer.from('00112233445566778899aabbccddeeff', 'hex'),
      'test-only'
    );
    expect(response).toBeInstanceOf(Buffer);
    expect(response).toHaveLength(16);

    protocol.tlsSocket.authorized = false;
    expect(() =>
      protocol.vncAuthChallenge(Buffer.alloc(16), 'test-only')
    ).toThrow(/certificate-verified TLS/);
  });

  test('TLS_VNC upgrades TLS before invoking challenge authentication', async () => {
    const protocol = new VNCProtocol({ password: 'test-only' }) as any;
    const order: string[] = [];
    protocol.upgradToTLS = jest.fn(async () => order.push('tls'));
    protocol.authenticateVNC = jest.fn(async () => order.push('vnc'));

    await protocol.handleVeNCryptSubtype(258);
    expect(order).toEqual(['tls', 'vnc']);
  });
});
