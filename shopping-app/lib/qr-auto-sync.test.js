const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');
const { redactSyncUrl, redactSyncText } = require('./single-event-sync');

async function runQrAutoSyncTests() {
  const source = fs.readFileSync(path.join(__dirname, '../app/(tabs)/index.tsx'), 'utf8');
  const start = source.indexOf('  async function onSendQRCodeScanned(');
  const end = source.indexOf('\n  const handleEventPress', start);
  assert.ok(start >= 0 && end > start);
  const js = ts.transpileModule(source.slice(start, end) + '\nthis.scan = onSendQRCodeScanned;', {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const url = 'http://192.168.1.25:43123/upload?token=secret&target_uid=private';
  async function run({ status = 200, error = null } = {}) {
    const calls = [], logs = [], alerts = [];
    let releaseExport;
    const exportReady = new Promise((resolve) => { releaseExport = resolve; });
    const context = {
      redactSyncUrl, redactSyncText, sendQrScannedRef: { current: false },
      sendToPCTarget: { id: 7, name: 'Test' },
      setShowSendQRScanner() {}, setSendToPCTarget() {}, setExporting() {},
      setSyncMessage() {}, setLastSyncLogPath() {}, setExportProgress() {},
      createSyncLog: async (kind, details) => { logs.push(details); return 'log'; },
      appendSyncLog: async (log, event, details) => { logs.push({ event, details }); },
      exportEventAsZip: async (id) => { calls.push(['export', id]); await exportReady; return 'event.zip'; },
      getFileSize: async () => 10, Platform: { OS: 'test' },
      FileSystem: { FileSystemUploadType: { BINARY_CONTENT: 1 },
        uploadAsync: async (target, zip, options) => {
          calls.push(['upload', target, zip, options]);
          if (error) throw error;
          return { status, body: `response ${url}` };
        },
      },
      fetchWithTimeout: async () => { throw new Error('unexpected fetch'); },
      fetch: async () => { throw new Error('unexpected fetch'); },
      Alert: { alert: (title) => alerts.push(title) }, shareSyncLog() {},
    };
    vm.runInNewContext(js, context);
    const first = context.scan({ data: url });
    await context.scan({ data: url });
    releaseExport();
    await first;
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], ['export', 7]);
    assert.equal(calls[1][0], 'upload');
    assert.equal(calls[1][1], url);
    assert.equal(calls[1][2], 'event.zip');
    assert.equal(calls[1][3].httpMethod, 'POST');
    assert.equal(calls[1][3].uploadType, 1);
    assert.equal(calls[1][3].headers['Content-Type'], 'application/octet-stream');
    assert.doesNotMatch(JSON.stringify(logs), /secret|private/);
    return alerts;
  }
  assert.deepEqual(await run(), ['同期完了']);
  assert.deepEqual(await run({ status: 403 }), ['送信エラー']);
  const error = new Error(`failed ${url}`);
  error.stack = `stack ${url}`;
  assert.deepEqual(await run({ error }), ['送信エラー']);
}
module.exports = { runQrAutoSyncTests };
