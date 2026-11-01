const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const ts = require("typescript");
const source = ts.transpileModule(fs.readFileSync(require.resolve("./x-post-lookup.ts"), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
function load(fetch) { const exports = {}; new Function("exports", "fetch", source)(exports, fetch); return exports.fetchXPostDetail; }
test("公開投稿の本文と全写真を取得", async () => {
 const lookup = load(async url => { assert.match(url, /cdn\.syndication\.twimg\.com/); return { ok: true, json: async () => ({ id_str: "123", text: "本文", photos: [{url:"https://pbs.twimg.com/a.jpg"},{url:"https://pbs.twimg.com/b.jpg"}] }) }; });
 assert.deepEqual(await lookup("123"), { text: "本文", imageUrls: ["https://pbs.twimg.com/a.jpg", "https://pbs.twimg.com/b.jpg"] });
});
test("取得不能を具体的に報告", async () => {
 await assert.rejects(load(async () => ({ok:false,status:403}))( "123"), /403/);
 await assert.rejects(load(async () => ({ok:true,json:async()=>({})}))( "123"), /非公開/);
});

test("長文と途中切れを区別", async () => {
 const make = data => load(async()=>({ok:true,json:async()=>({id_str:"123",text:"短縮",...data})}))("123");
 assert.equal((await make({truncated:true, note_tweet:{note_tweet_results:{result:{text:"長い全文"}}}})).text,"長い全文");
 await assert.rejects(make({truncated:true}),/全文/);
 await assert.rejects(make({note_tweet:{}}),/全文/);
});
test("写真の不一致や欠落を拒否", async () => {
 const make = data => load(async()=>({ok:true,json:async()=>({id_str:"123",text:"本文",...data})}))("123");
 await assert.rejects(make({mediaDetails:[{type:"photo",media_url_https:"https://pbs.twimg.com/a"}],photos:[]}),/すべて/);
 await assert.rejects(make({photos:[{}]}),/画像URL/);
 assert.deepEqual((await make({mediaDetails:[{type:"photo",media_url_https:"https://pbs.twimg.com/a"}],photos:[{url:"https://pbs.twimg.com/a"}]})).imageUrls,["https://pbs.twimg.com/a"]);
});
test("取得のタイムアウトで中断しタイマーを解除", async () => {
 let cleared = false;
 const exports = {};
 new Function("exports","fetch","setTimeout","clearTimeout",source)(exports, (_url, options) => new Promise((_resolve,reject)=>options.signal.addEventListener("abort",()=>reject(new Error("abort")))), callback => { queueMicrotask(callback); return 1; }, () => {cleared=true;});
 await assert.rejects(exports.fetchXPostDetail("123"),/タイムアウト/);
 assert.equal(cleared,true);
});
