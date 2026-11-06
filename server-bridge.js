/**
 * server 侧桥接（可选）：把「VS Code 标准流程」的密钥送进 agent host。
 *
 * 背景
 * ----
 * VS Code 的设计里 `chatLanguageModels.json` 只存 `${input:chat.lm.secret.X}` 占位符，
 * 真值在 **SecretStorage**（`secretStorage.get(name)`）。
 * 但远程的 agent host 是个精简 utility 进程，**没有** SecretStorage，解析不了占位符。
 *
 * 而 **server 进程有** SecretStorage，且 agent host 正是它 fork 的子进程
 * （子进程 env = `i8(process.env, …)`，会继承 `process.env`）。
 *
 * 于是这里做一件小事：
 *   读配置文件 → 收集所有 `${input:NAME}` → 用 server 的 SecretStorage 解析
 *   → 结果以 JSON 塞进 `process.env.VSCODE_BYOK_SECRETS_JSON`
 *   → 子进程里的 adapter 读这个 env（优先级高于兜底文件）。
 *
 * ⚠️ 默认**关闭**，需要 `VSCODE_BYOK_BRIDGE=1` 才启用。原因见下。
 *
 * 为什么默认关闭
 * --------------
 * 在**无头 Linux（没有 keyring / Secret Service）**上，`instantiationService.get(secretStorageService)`
 * 可能**同步阻塞**（实测：进程卡在那里不返回，连 Promise.race 的超时都抢不走）。
 * 一旦阻塞，agent host 启动会被拖住，最坏情况下起不来。
 * 有可用 keyring 的机器上它是正常且即时的，所以做成开关。
 *
 * 启用方式：在 server 启动环境里设 `VSCODE_BYOK_BRIDGE=1`（例如 `~/.vscode-server/server-env-setup`），
 * 然后确认日志出现 `resolved N/M secret(s) from SecretStorage`。
 *
 * 安全：全程 try/catch，失败只是「解析不到」→ adapter 回落到兜底来源，不抛错。
 *
 * 本文件被原样插到 server-main.js 顶部执行，因此不能用 import/export。
 */
globalThis.__vscodeRemoteByokServer = (function () {
  const LOG_FILE = process.env.VSCODE_REMOTE_BYOK_LOG || '/tmp/vscode-remote-byok.log';
  const GET_TIMEOUT_MS = 800;
  const OVERALL_TIMEOUT_MS = 1500;

  let fs = null;
  try {
    fs = typeof require === 'function' ? require('node:fs') : process.getBuiltinModule('node:fs');
  } catch { /* ignore */ }

  function log(msg) {
    try {
      if (fs) fs.appendFileSync(LOG_FILE, `[vscode-remote-byok/server ${new Date().toISOString()}] ${msg}\n`);
    } catch { /* ignore */ }
  }

  /** `${input:chat.lm.secret.X}` → `chat.lm.secret.X` */
  function secretNameOf(value) {
    if (typeof value !== 'string') return undefined;
    const m = /^\$\{input:([^}]+)\}$/.exec(value.trim());
    return m ? m[1] : undefined;
  }

  /** server 的 userDataPath 下：User 为主，Machine 兜底 */
  function configFiles(userDataPath) {
    if (!userDataPath) return [];
    return [
      `${userDataPath}/User/chatLanguageModels.json`,
      `${userDataPath}/Machine/chatLanguageModels.json`,
    ];
  }

  function collectSecretNames(userDataPath) {
    const names = new Set();
    if (!fs) return names;
    for (const f of configFiles(userDataPath)) {
      let raw;
      try {
        if (!fs.existsSync(f)) continue;
        raw = fs.readFileSync(f, 'utf8');
      } catch { continue; }
      let cfg;
      try { cfg = JSON.parse(raw); } catch { continue; }
      const groups = Array.isArray(cfg) ? cfg : (cfg && cfg.groups) || [];
      for (const g of groups) {
        if (!g) continue;
        const nm = secretNameOf(g.apiKey);
        if (nm) names.add(nm);
        for (const m of (Array.isArray(g.models) ? g.models : [])) {
          const rh = m && m.requestHeaders;
          if (!rh || typeof rh !== 'object') continue;
          for (const k of Object.keys(rh)) {
            const v = secretNameOf(rh[k]);
            if (v) names.add(v);
          }
        }
      }
    }
    return names;
  }

  function withTimeout(p, ms) {
    return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout after ' + ms + 'ms')), ms))]);
  }

  return {
    /**
     * @param di           server 的 IInstantiationService
     * @param userDataPath server 的 userDataPath
     * @param token        'secretStorageService' 的 DI 令牌
     */
    async prepare(di, userDataPath, token) {
      if (process.env.VSCODE_BYOK_BRIDGE !== '1') {
        delete process.env.VSCODE_BYOK_SECRETS_JSON;
        return;
      }
      try {
        const names = collectSecretNames(userDataPath);
        if (names.size === 0) { delete process.env.VSCODE_BYOK_SECRETS_JSON; return; }
        if (!di || typeof di.get !== 'function') { log('bridge: DI unavailable'); return; }

        const ss = di.get(token);           // ← 无 keyring 的机器上这里可能阻塞（见文件头说明）
        if (!ss || typeof ss.get !== 'function') { log('bridge: SecretStorage unavailable'); return; }

        const map = Object.create(null);
        let timedOut = 0;
        for (const n of names) {
          try {
            const v = await withTimeout(Promise.resolve(ss.get(n)), GET_TIMEOUT_MS);
            if (typeof v === 'string' && v.trim()) map[n] = v;
          } catch (e) {
            if (String(e && e.message).includes('timeout')) timedOut++;
          }
        }

        const resolved = Object.keys(map).length;
        if (resolved > 0) {
          process.env.VSCODE_BYOK_SECRETS_JSON = JSON.stringify(map);
          log(`bridge: resolved ${resolved}/${names.size} secret(s) from SecretStorage`);
        } else {
          delete process.env.VSCODE_BYOK_SECRETS_JSON;
          log(`bridge: SecretStorage has 0/${names.size} secret(s)` + (timedOut ? ` (${timedOut} timed out)` : '') + '; agent host falls back');
        }
      } catch (e) {
        log('bridge: prepare failed (ignored): ' + (e && e.message));
      }
    },

    describe(userDataPath) {
      return {
        enabled: process.env.VSCODE_BYOK_BRIDGE === '1',
        userDataPath,
        names: [...collectSecretNames(userDataPath)],
        inline: process.env.VSCODE_BYOK_SECRETS_JSON ? 'set' : 'unset',
      };
    },
  };
})();
