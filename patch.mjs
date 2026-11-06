#!/usr/bin/env node
/**
 * 给 **VS Code Server**（Remote-SSH 的远程机）打补丁，让官方 Copilot 的
 * agent-host 会话（Copilot CLI / Chat）能用自定义模型，且**密钥走 VS Code 标准流程**。
 *
 *   node patch.mjs --server-dir ~/.vscode-server/cli/servers/Stable-<commit>/server
 *   node patch.mjs --server-dir <同上> --check
 *   node patch.mjs --server-dir <同上> --revert
 *   node patch.mjs --server-dir <同上> --dry-run
 *   node patch.mjs --server-dir <同上> --force      # 改了 adapter/bridge 后必须重打
 *
 * 动两个文件：
 *
 * A. `out/vs/platform/agentHost/node/agentHostMain.js`（agent host，6 处）
 *    1. 顶部插入 adapter.js
 *    2. `byokLmBridgeRegistry` 构造点后 `.wrap(reg)` —— 补上 getModels()
 *    3. `znt()` 的 providers 段 —— 改直连真实端点
 *    4. `znt()` 的 models 段 —— provider 用合成名
 *    5. `BQ()` 开头 —— 短路我们模型的 reasoningEffort
 *    6. `GQ()` 开头 —— 短路我们模型的 contextTier
 *
 * B. `out/server-main.js`（server 主进程，3 处）—— 让密钥走 SecretStorage
 *    7. 顶部插入 server-bridge.js
 *    8. `X.createInstance(<Starter>)` → 顺手把 DI 容器挂到实例上
 *    9. `<Starter>.start()` 开头 → 用 server 的 SecretStorage 解析占位符，
 *       结果通过 `VSCODE_BYOK_SECRETS_JSON` 注入给 agent host 子进程
 *
 * ⚠️ B 段需要 **server 进程重启** 才生效；A 段需要 **agent host 重启**。
 * ⚠️ VS Code 升级会换 server commit，补丁随之失效；重跑本脚本即可。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ADAPTER = path.join(HERE, 'adapter.js');
const BRIDGE = path.join(HERE, 'server-bridge.js');

const MARK = 'globalThis.__vscodeRemoteByok';
const SERVER_MARK = 'globalThis.__vscodeRemoteByokServer';

const args = process.argv.slice(2);
const argValue = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const SERVER_DIR = argValue('--server-dir', process.env.VSCODE_SERVER_DIR || null);
const CHECK = args.includes('--check');
const REVERT = args.includes('--revert');
const DRY = args.includes('--dry-run');
const FORCE = args.includes('--force');

if (!SERVER_DIR) {
  console.error('用法: node patch.mjs --server-dir <server bundle 根目录> [--check|--revert|--dry-run|--force]');
  console.error('例:   node patch.mjs --server-dir ~/.vscode-server/cli/servers/Stable-<commit>/server');
  process.exit(2);
}

const AGENT = path.join(SERVER_DIR, 'out/vs/platform/agentHost/node/agentHostMain.js');
const SERVER = path.join(SERVER_DIR, 'out/server-main.js');
const MARKER = path.join(SERVER_DIR, '.vscode-remote-byok.json');

const version = (() => { try { return JSON.parse(fs.readFileSync(path.join(SERVER_DIR, 'product.json'), 'utf8')).version; } catch { return 'unknown'; } })();
const label = `VS Code Server ${version}`;

for (const [what, f] of [['agentHostMain.js', AGENT], ['server-main.js', SERVER]]) {
  if (!fs.existsSync(f)) {
    console.error(`找不到 ${what}: ${f}`);
    console.error('  --server-dir 要指向 <cli-data-dir>/cli/servers/Stable-<commit>/server');
    process.exit(1);
  }
}

const read = (f) => fs.readFileSync(f, 'utf8');
const isPatched = (f, mark) => read(f).includes(mark);

// ── --revert ───────────────────────────────────────────────────────────────
if (REVERT) {
  for (const f of [AGENT, SERVER]) {
    if (!fs.existsSync(`${f}.orig`)) { console.error(`没有备份 ${f}.orig，无法回滚`); process.exit(1); }
    fs.copyFileSync(`${f}.orig`, f);
    fs.rmSync(`${f}.orig`, { force: true });
  }
  fs.rmSync(MARKER, { force: true });
  console.log(`✅ 已回滚 ${label}（agent host + server）`);
  process.exit(0);
}

// ── --check ────────────────────────────────────────────────────────────────
if (CHECK) {
  const a = isPatched(AGENT, MARK);
  const b = isPatched(SERVER, SERVER_MARK);
  if (a && b) {
    console.log(`✅ 已打补丁（agent host + server）  ${label}`);
    process.exit(0);
  }
  console.log(`❌ 未完整打补丁  ${label}`);
  console.log(`   agent host: ${a ? '已打' : '未打'}   server: ${b ? '已打' : '未打'}`);
  const prev = fs.existsSync(MARKER) ? JSON.parse(read(MARKER)) : undefined;
  if (prev?.version && prev.version !== version) {
    console.log(`   原因很可能是 VS Code 升级：补丁是给 ${prev.version} 打的，现在已是 ${version}`);
  }
  console.log(`   修复: node patch.mjs --server-dir "${SERVER_DIR}"`);
  process.exit(1);
}

if (FORCE) {
  for (const f of [AGENT, SERVER]) if (fs.existsSync(`${f}.orig`)) fs.copyFileSync(`${f}.orig`, f);
  console.log('从 .orig 重打');
}

if (!FORCE && isPatched(AGENT, MARK) && isPatched(SERVER, SERVER_MARK)) {
  fs.writeFileSync(MARKER, JSON.stringify({ version, patchedAt: new Date().toISOString() }, null, 2));
  console.log(`已经打过补丁（${label}），跳过（重打用 --force）`);
  process.exit(0);
}

// ══════════════════════════════════════════════════════════════════════════
// A. agent host
// ══════════════════════════════════════════════════════════════════════════
function patchAgentHost(source) {
  const regMatch = /byok:\{kind:"renderer",bridgeRegistry:([A-Za-z_$][\w$]*)\}/.exec(source);
  if (!regMatch) throw new Error('没找到 byok:{kind:"renderer",bridgeRegistry:X}');
  const regIdent = regMatch[1];

  // 压缩后的标识符在作用域内会复用，必须取「byok 描述符之前最近的 `X=new Y`」
  const before = source.slice(0, regMatch.index);
  const ctorRe = new RegExp(`\\b${regIdent}\\s*=\\s*new\\s+[A-Za-z_$][\\w$]*`, 'g');
  let ctorMatch = null;
  for (let m; (m = ctorRe.exec(before));) ctorMatch = m;
  if (!ctorMatch) throw new Error(`没找到 ${regIdent}=new <Class> 的构造点`);

  const BQ_DEF = 'function BQ(o,i,e,t){';
  const GQ_DEF = 'function GQ(o,i,e){';
  const PROV_PREFIX = 'let a=[...new Set(n.map(l=>l.vendor))]';
  const MODELS_PREFIX = 'd=n.map(l=>({id:m_(l),provider:l.vendor,';

  const provStart = source.indexOf(PROV_PREFIX);
  if (provStart < 0) throw new Error('没找到 providers 构造段（znt）');
  const provEnd = source.indexOf('})),', provStart);
  if (provEnd < 0) throw new Error('providers 段结束位置没找到');
  const provSeg = source.slice(provStart, provEnd + 4);

  const modelsAt = source.indexOf(MODELS_PREFIX);
  if (modelsAt < 0) throw new Error('没找到 models 的 provider 赋值段（znt）');
  if (!source.includes(BQ_DEF)) throw new Error('没找到 BQ');
  if (!source.includes(GQ_DEF)) throw new Error('没找到 GQ');

  const headerEnd = source.indexOf('*/');
  if (headerEnd < 0) throw new Error('文件头注释异常');

  const adapter = read(ADAPTER);
  if (!adapter.includes(MARK)) throw new Error('adapter.js 里没有 ' + MARK);

  // 原生桥在用时必须交还原生的 provider 构造（指向 loopback proxy + nonce bearer），
  // 所以把原始表达式作为 fallback thunk 传进去，而不是简单替换掉。
  const provOriginal = provSeg.replace(/^let a=/, '').replace(/,$/, '');   // `[...].map(...)`

  const edits = [
    { at: headerEnd + 2, len: 0, text: `\n${adapter}\n` },
    { at: provStart, len: provSeg.length, text: `let a=${MARK}.providers(n,()=>${provOriginal}),` },
    { at: modelsAt, len: MODELS_PREFIX.length, text: `d=n.map(l=>({id:m_(l),provider:${MARK}.providerFor(l),` },
    { at: ctorMatch.index, len: ctorMatch[0].length, text: `${ctorMatch[0]},${regIdent}=${MARK}.wrap(${regIdent})` },
    { at: source.indexOf(BQ_DEF), len: BQ_DEF.length, text: `${BQ_DEF}if(${MARK}.isOurs(o?.id))return void 0;` },
    { at: source.indexOf(GQ_DEF), len: GQ_DEF.length, text: `${GQ_DEF}if(${MARK}.isOurs(o?.id))return void 0;` },
  ].sort((x, y) => y.at - x.at);

  let out = source;
  for (const e of edits) out = out.slice(0, e.at) + e.text + out.slice(e.at + e.len);

  const expect = [
    ['适配器', MARK],
    ['providers 段', `${MARK}.providers(n,()=>`],
    ['models 段', `${MARK}.providerFor(l)`],
    ['registry 包装', `${MARK}.wrap(${regIdent})`],
    ['reasoning 拦截', `${BQ_DEF}if(${MARK}.isOurs(o?.id))return void 0;`],
    ['contextTier 拦截', `${GQ_DEF}if(${MARK}.isOurs(o?.id))return void 0;`],
  ];
  for (const [what, needle] of expect) if (!out.includes(needle)) throw new Error(`A 段注入失败：${what}`);
  return out;
}

// ══════════════════════════════════════════════════════════════════════════
// B. server-main（让密钥走 SecretStorage）
// ══════════════════════════════════════════════════════════════════════════
function patchServerMain(source) {
  const ANCHOR = 'VSCODE_ESM_ENTRYPOINT:"vs/platform/agentHost/node/agentHostMain"';
  const ai = source.indexOf(ANCHOR);
  if (ai < 0) throw new Error('没找到 agent host 的 ESM 入口标记');

  // starter 类 = anchor 之前最近的 `X=class extends`
  let starterMatch = null;
  for (const m of source.slice(0, ai).matchAll(/(\w+)=class extends/g)) starterMatch = m;
  if (!starterMatch) throw new Error('没找到 agent host starter 类');
  const starter = starterMatch[1];
  const classPos = source.lastIndexOf(`${starter}=class extends`, ai);
  const startPos = source.indexOf('async start(){', classPos);
  if (startPos < 0) throw new Error(`没找到 ${starter}.start()`);

  const ciRe = new RegExp(`(\\w+)\\.createInstance\\(${starter.replace(/\$/g, '\\$')}\\)`, 'g');
  const ciHits = [...source.matchAll(ciRe)];
  if (ciHits.length === 0) throw new Error(`没找到 *.createInstance(${starter})`);
  const diVar = ciHits[0][1];

  const tokenMatch = /(\w+)\s*=\s*A\("secretStorageService"\)/.exec(source);
  if (!tokenMatch) throw new Error('没找到 secretStorageService 的 DI 令牌');
  const token = tokenMatch[1];

  // ⚠️ 关键：`<token> = A("secretStorageService")` 位于一个**惰性模块块**里
  // （bundle 里形如 `X=v(()=>{…})`），在 server 启动早期可能还没初始化 →
  // 直接读 token 会得到 undefined → di.get(undefined) 静默失败。
  // 所以先找到那个块变量并显式调用它（bundle 自己也是这么触发的）。
  let chunkVar = null;
  for (const m of source.slice(0, tokenMatch.index).matchAll(/(\w+)=v\(\(\)=>\{/g)) chunkVar = m[1];
  if (!chunkVar) throw new Error('没找到 token 所在的惰性模块块');

  const bridge = read(BRIDGE);
  if (!bridge.includes(SERVER_MARK)) throw new Error('server-bridge.js 里没有 ' + SERVER_MARK);

  const headerEnd = source.indexOf('*/');
  if (headerEnd < 0) throw new Error('文件头注释异常');

  const START_DEF = 'async start(){';
  // ⚠️ 默认关闭：无 keyring 的机器上 di.get(secretStorageService) 可能同步阻塞，
  // 会拖住 agent host 启动。用 VSCODE_BYOK_BRIDGE=1 显式开启。
  const startInject =
    `${START_DEF}if(process.env.VSCODE_BYOK_BRIDGE==='1'){try{try{${chunkVar}()}catch{}` +
    `await Promise.race([${SERVER_MARK}.prepare(this.__di,` +
    `this._environmentService&&this._environmentService.userDataPath,${token}),` +
    `new Promise(function(r){setTimeout(r,1500)})])}catch{}}`;

  const edits = [
    { at: headerEnd + 2, len: 0, text: `\n${bridge}\n` },
    { at: startPos, len: START_DEF.length, text: startInject },
    ...ciHits.map((h) => ({
      at: h.index,
      len: h[0].length,
      text: `Object.assign(${h[1]}.createInstance(${starter}),{__di:${h[1]}})`,
    })),
  ].sort((x, y) => y.at - x.at);

  let out = source;
  for (const e of edits) out = out.slice(0, e.at) + e.text + out.slice(e.at + e.len);

  const expect = [
    ['桥接', SERVER_MARK],
    ['start 注入', `this._environmentService.userDataPath,${token})`],
    ['惰性块初始化', `try{${chunkVar}()}catch{}`],
    ['DI 挂载', `{__di:${diVar}}`],
  ];
  for (const [what, needle] of expect) if (!out.includes(needle)) throw new Error(`B 段注入失败：${what}`);

  return { out, meta: { starter, diVar, token, chunkVar, createInstanceSites: ciHits.length } };
}

// ── dry-run 且已打过：直接报告，别去定位（原字符串已被替换过）────────────
if (DRY && !FORCE && isPatched(AGENT, MARK) && isPatched(SERVER, SERVER_MARK)) {
  console.log(`server bundle  : ${SERVER_DIR}  (${label})`);
  console.log('已是补丁状态（重打用 --force）');
  process.exit(0);
}

// ── 执行 ───────────────────────────────────────────────────────────────────
let agentOut, serverResult;
try {
  agentOut = patchAgentHost(read(AGENT));
  serverResult = patchServerMain(read(SERVER));
} catch (e) {
  console.error('定位/注入失败：' + e.message);
  console.error('（bundle 结构可能变了，请核对 VS Code 版本）');
  process.exit(1);
}

if (DRY) {
  console.log(`server bundle  : ${SERVER_DIR}  (${label})`);
  console.log(`A. agent host  : +${agentOut.length - read(AGENT).length} 字节`);
  console.log(`B. server-main : starter=${serverResult.meta.starter}  DI=${serverResult.meta.diVar}  token=${serverResult.meta.token} chunk=${serverResult.meta.chunkVar}  createInstance 站点=${serverResult.meta.createInstanceSites}`);
  console.log(`               +${serverResult.out.length - read(SERVER).length} 字节`);
  console.log('dry-run，不写文件');
  process.exit(0);
}

const writeGuarded = (file, text) => {
  if (!fs.existsSync(`${file}.orig`)) fs.copyFileSync(file, `${file}.orig`);
  fs.writeFileSync(file, text);
  const chk = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (chk.status !== 0) {
    console.error(`语法校验失败：${file}`);
    console.error(chk.stderr);
    fs.copyFileSync(`${file}.orig`, file);
    console.error('已回滚该文件');
    process.exit(1);
  }
};

if (!isPatched(AGENT, MARK)) {
  const before = read(AGENT).length;
  writeGuarded(AGENT, agentOut);
  console.log(`A. 已写入 agentHostMain.js  (+${agentOut.length - before} 字节)  语法 ✓`);
} else {
  console.log('A. agent host 已是补丁状态，跳过');
}

if (!isPatched(SERVER, SERVER_MARK)) {
  const before = read(SERVER).length;
  writeGuarded(SERVER, serverResult.out);
  console.log(`B. 已写入 server-main.js  (+${serverResult.out.length - before} 字节)  语法 ✓`);
  console.log(`   starter=${serverResult.meta.starter}  DI=${serverResult.meta.diVar}  token=${serverResult.meta.token}  chunk=${serverResult.meta.chunkVar}`);
} else {
  console.log('B. server-main 已是补丁状态，跳过');
}

fs.writeFileSync(MARKER, JSON.stringify({ version, patchedAt: new Date().toISOString(), target: SERVER_DIR }, null, 2));
console.log('');
console.log('生效：');
console.log('  A 段（agent host） → 需 agent host 重启（重载/重连窗口）');
console.log('  B 段（server-main）→ 需 **server 进程重启**');
console.log('诊断：cat /tmp/vscode-remote-byok.log');
