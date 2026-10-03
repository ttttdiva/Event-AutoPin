const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const filename = path.join(__dirname, 'image-downloader.ts');
const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const cache = 'file:///cache/';
const oldCut = 'file:///documents/current-cut.jpg';
const oldOther = 'file:///documents/old-image.jpg';
const resizedUri = cache + 'ImageManipulator/123e4567-e89b-12d3-a456-426614174000.jpg';
const partialResizeUri = cache + 'ImageManipulator/123e4567-e89b-12d3-a456-426614174001.jpg';
const secondResizeUri = cache + 'ImageManipulator/123e4567-e89b-12d3-a456-426614174002.jpg';
const foreignCache = cache + 'foreign-existing.jpg';

function harness(options = {}) {
  const files = new Map([[oldCut, 'ユーザーのカット'], [oldOther, '既存画像']]);
  if (options.existingResize) files.set(resizedUri, '既存resize画像');
  if (options.foreignResize) files.set(foreignCache, '別用途cache');
  if (options.collidingTemp) files.set(`${cache}tmp_dl_42_1_new.jpg`, '既存cache');
  const deleted = [], downloads = [], events = options.events ?? [];
  let manipulateCall = 0;
  const FileSystem = {
    cacheDirectory: options.noCache ? null : cache,
    async getInfoAsync(uri) {
      if (options.failInfo && uri.startsWith(cache)) throw new Error('存在確認失敗');
      return { exists: files.has(uri) || uri === 'file:///staging/' || uri === cache + 'ImageManipulator/' && (options.failResizeSnapshot || [...files.keys()].some(p => p.startsWith(uri))) };
    },
    async readDirectoryAsync(uri) {
      if (options.failResizeSnapshot) throw new Error('resize cache一覧取得失敗');
      return [...files.keys()].filter(p => p.startsWith(uri)).map(p => p.slice(uri.length));
    },
    async makeDirectoryAsync() { if (options.failMkdir) throw new Error('mkdir失敗'); },
    async downloadAsync(url, uri) {
      downloads.push(uri);
      if (!options.throwBeforeWrite) files.set(uri, '一時ダウンロード');
      if (options.throwBeforeWrite || options.throwAfterWrite) throw new Error('通信中断');
      return { status: options.status ?? 200, uri: options.noUri ? undefined : options.returnOldCut ? oldCut : uri };
    },
    async copyAsync({ from, to }) {
      if (options.failCopy || options.failPrimaryCopy && from === resizedUri) throw new Error('保存失敗');
      assert.ok(files.has(from)); files.set(to, files.get(from));
    },
    async deleteAsync(uri) {
      deleted.push(uri);
      events.push(`delete:${uri}`);
      if (options.failDelete) throw new Error('削除失敗');
      files.delete(uri);
    },
  };
  const mocks = {
    'expo-file-system/legacy': FileSystem,
    'expo-image-manipulator': {
      SaveFormat: { JPEG: 'jpeg' },
      async manipulateAsync() {
        const callIndex = manipulateCall++;
        const planned = options.manipulatePlan?.[callIndex];
        if (planned) return planned({ files, events, callIndex });
        if (options.partialResizeOutputReject) {
          files.set(partialResizeUri, '部分生成resize画像');
          throw new Error('変換保存失敗');
        }
        if (options.failResize) throw new Error('リサイズ失敗');
        if (options.returnOldCutFromResize) return { uri: oldCut };
        if (options.existingResize) return { uri: resizedUri };
        if (options.foreignResize) return { uri: foreignCache };
        files.set(resizedUri, 'リサイズ済み'); return { uri: resizedUri };
      },
    },
  };
  const record = { exports: {} };
  new Function('exports', 'require', 'module', 'Date', 'console', compiled)(record.exports,
    name => { assert.ok(mocks[name], `予期しないimport: ${name}`); return mocks[name]; },
    record, { now: () => 42 }, { warn() {} });
  return {
    files, deleted, downloads, events,
    run: (name = 'new.jpg') => record.exports.downloadImage('http://127.0.0.1/fixture.jpg', options.failMkdir ? 'file:///new-staging/' : 'file:///staging/', name),
    assertUsersPreserved() {
      assert.equal(files.get(oldCut), 'ユーザーのカット');
      assert.equal(files.get(oldOther), '既存画像');
      assert.ok(!deleted.includes(oldCut) && !deleted.includes(oldOther));
    },
    assertDownloadsClean() {
      for (const uri of downloads) assert.ok(!files.has(uri), `今回の一時cacheを除去: ${uri}`);
      this.assertUsersPreserved();
    },
  };
}

for (const status of [404, 503]) test(`HTTP ${status}のレスポンス本文をcacheに残さない`, async () => {
  const h = harness({ status });
  assert.equal(await h.run(), null); h.assertDownloadsClean();
});
for (const fault of ['throwBeforeWrite', 'throwAfterWrite', 'noUri']) test(`${fault}でも予約した一時パスだけを片付ける`, async () => {
  const h = harness({ [fault]: true });
  assert.equal(await h.run(), null); h.assertDownloadsClean();
});
test('正常なリサイズ保存後もdownload cacheを除去する', async () => {
  const h = harness();
  assert.deepEqual(await h.run(), { localPath: 'file:///staging/new.jpg', filename: 'new.jpg' });
  assert.equal(h.files.get('file:///staging/new.jpg'), 'リサイズ済み'); h.assertDownloadsClean();
});
test('リサイズ失敗時の元画像コピーを維持してcacheを除去する', async () => {
  const h = harness({ failResize: true });
  assert.ok(await h.run()); assert.equal(h.files.get('file:///staging/new.jpg'), '一時ダウンロード'); h.assertDownloadsClean();
});
test('リサイズ変換が出力後にrejectしても部分生成cacheとdownload cacheを除去する', async () => {
  const h = harness({ partialResizeOutputReject: true, existingResize: true });
  assert.ok(await h.run());
  assert.equal(h.files.get('file:///staging/new.jpg'), '一時ダウンロード');
  assert.equal(h.files.get(resizedUri), '既存resize画像');
  assert.ok(!h.files.has(partialResizeUri));
  h.assertDownloadsClean();
});
test('コピー例外時もdownload cacheを除去する', async () => {
  const h = harness({ failResize: true, failCopy: true });
  assert.equal(await h.run(), null); h.assertDownloadsClean();
});
test('返却URIが既存カットでも削除対象は今回のdownload cacheに限定する', async () => {
  const h = harness({ returnOldCut: true, failResize: true });
  assert.ok(await h.run()); h.assertDownloadsClean();
});
test('同時刻の既存cacheを上書きや削除せず別の一時名を使う', async () => {
  const h = harness({ collidingTemp: true, status: 503 });
  assert.equal(await h.run(), null);
  assert.equal(h.files.get(`${cache}tmp_dl_42_1_new.jpg`), '既存cache'); h.assertDownloadsClean();
});
test('同時刻・同じ画像名の並行取得にも別々の一時名を使う', async () => {
  const h = harness({ status: 503 });
  await Promise.all([h.run(), h.run()]);
  assert.equal(new Set(h.downloads).size, 2); h.assertDownloadsClean();
});
test('並列2件の変換失敗と成功を直列化し、先行の部分cacheを後続に誤って消さない', async () => {
  const events = [];
  let releaseFirst;
  let firstStarted;
  const firstStartedPromise = new Promise(resolve => { firstStarted = resolve; });
  const h = harness({
    events,
    manipulatePlan: [
      async ({ files, events: planEvents }) => {
        planEvents.push('first-start');
        files.set(partialResizeUri, '先行部分生成resize画像');
        firstStarted();
        await new Promise(resolve => { releaseFirst = resolve; });
        planEvents.push('first-reject');
        throw new Error('先行変換失敗');
      },
      async ({ files, events: planEvents }) => {
        planEvents.push('second-start');
        files.set(secondResizeUri, '後続リサイズ');
        return { uri: secondResizeUri };
      },
    ],
  });

  const firstPromise = h.run('first.jpg');
  await firstStartedPromise;
  const secondPromise = h.run('second.jpg');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['first-start']);
  releaseFirst();

  const [firstResult, secondResult] = await Promise.all([firstPromise, secondPromise]);
  assert.ok(firstResult && secondResult);
  assert.equal(h.files.get('file:///staging/first.jpg'), '一時ダウンロード');
  assert.equal(h.files.get('file:///staging/second.jpg'), '後続リサイズ');
  assert.ok(events.indexOf(`delete:${partialResizeUri}`) < events.indexOf('second-start'));
  assert.ok(!h.files.has(partialResizeUri) && !h.files.has(secondResizeUri));
  h.assertDownloadsClean();
});
for (const fault of ['failInfo', 'failMkdir', 'noCache']) test(`${fault}のとき未確保のファイルを削除しない`, async () => {
  const h = harness({ [fault]: true });
  assert.equal(await h.run(), null); assert.deepEqual(h.deleted, []); h.assertUsersPreserved();
});
test('cache削除自体の失敗で元の取得結果を例外に変えない', async () => {
  const h = harness({ status: 503, failDelete: true });
  assert.equal(await h.run(), null); h.assertUsersPreserved();
});

for (const failFallback of [false, true]) test(`resize成功後のcopy失敗・fallback${failFallback ? '失敗' : '成功'}でも新規resize cacheを回収する`, async () => {
  const h = harness({ failPrimaryCopy: true, failCopy: failFallback });
  const result = await h.run();
  if (failFallback) assert.equal(result, null);
  else { assert.ok(result); assert.equal(h.files.get('file:///staging/new.jpg'), '一時ダウンロード'); }
  assert.ok(!h.files.has(resizedUri), '今回生成したresize cacheを片付ける');
  h.assertDownloadsClean();
});
test('resize結果が既存カットを返しても削除しない', async () => {
  const h = harness({ returnOldCutFromResize: true });
  assert.ok(await h.run()); h.assertDownloadsClean();
});
test('resize結果が既存ImageManipulator画像を返しても削除しない', async () => {
  const h = harness({ existingResize: true });
  assert.ok(await h.run());
  assert.equal(h.files.get(resizedUri), '既存resize画像'); h.assertDownloadsClean();
});
test('resize結果が別用途cacheを返しても削除しない', async () => {
  const h = harness({ foreignResize: true });
  assert.ok(await h.run());
  assert.equal(h.files.get(foreignCache), '別用途cache'); h.assertDownloadsClean();
});
test('resize前の既存画像確認に失敗したら元画像のfallbackを使う', async () => {
  const h = harness({ failResizeSnapshot: true });
  assert.ok(await h.run());
  assert.equal(h.files.get('file:///staging/new.jpg'), '一時ダウンロード');
  assert.ok(!h.files.has(resizedUri)); h.assertDownloadsClean();
});
