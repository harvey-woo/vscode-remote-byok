/**
 * 让**远程** agent host 里的官方 Copilot（agent-host 会话，如 Copilot CLI / Chat）
 * 能用远程 `chatLanguageModels.json` 里的自定义模型。
 *
 * 为什么需要它：上游 agent host 的 BYOK 桥只在「本机 utility process」形态下注册
 *   src/vs/platform/agentHost/node/agentHostMain.ts
 *     const server = utilityProcessServer ?? new ChildProcessServer(…);
 *     if (server instanceof UtilityProcessServer) { byokLmBridgeRegistry.register(…) }
 * Remote-SSH 下 agent host 是 server 拉起的子进程 → 整块被跳过
 * → `IByokLmBridgeRegistry.getModels()` 恒空 → 模型选择器里只有 Auto。
 * （上游自己也这么写：byokLmBridgeRegistry.ts 注释里点名 "the remote agent host"）
 *
 * 本适配器只补两件事，renderer / server / 回环代理都不动：
 *   1. 把配置文件里的模型喂给 `byokLmBridgeRegistry.getModels()`
 *   2. 告诉合成器每个模型该用哪个 provider —— 直连真实端点、`wireApi:'completions'`
 *      （Copilot SDK 的 provider 默认 wireApi 就是 'completions'，所以不需要协议翻译）
 *
 * 本文件会被**原样插到** agentHostMain.js 顶部执行，因此：
 *   - 不能用 import/export（用 require 或 process.getBuiltinModule）
 *   - 只依赖 node 内置模块与全局对象
 *
 * 环境变量：
 *   VSCODE_REMOTE_BYOK_FILE   直接指定配置文件路径（默认按 --user-data-dir 推导）
 *   VSCODE_REMOTE_BYOK_DEBUG  设 1 打开详细日志
 *   VSCODE_REMOTE_BYOK_LOG    日志路径（默认 /tmp/vscode-remote-byok.log）
 */
globalThis.__vscodeRemoteByok = (function () {
  const MARK = 'globalThis.__vscodeRemoteByok';
  const DEBUG = process.env.VSCODE_REMOTE_BYOK_DEBUG === '1';
  const LOG_FILE = process.env.VSCODE_REMOTE_BYOK_LOG || '/tmp/vscode-remote-byok.log';

  let fs = null;
  try {
    fs = typeof require === 'function' ? require('node:fs') : process.getBuiltinModule('node:fs');
  } catch { /* 没有 fs 也能跑，只是读不到配置 */ }

  function log(msg) {
    if (!DEBUG) return;
    try { fs && fs.appendFileSync(LOG_FILE, `[vscode-remote-byok ${new Date().toISOString()}] ${msg}\n`); } catch { /* ignore */ }
  }

  /** 无条件记一行（启动即验证用），只写一次；带 pid 便于区分是哪个进程写的 */
  let announced = false;
  function announce(msg) {
    if (announced) return;
    announced = true;
    try { fs && fs.appendFileSync(LOG_FILE, `[vscode-remote-byok ${new Date().toISOString()}] ${msg}\n`); } catch { /* ignore */ }
  }

  /** 配置文件候选路径：优先 --user-data-dir，其次 ~/.vscode-server/data（User 在前，Machine 兜底） */
  function configPaths() {
    if (process.env.VSCODE_REMOTE_BYOK_FILE) return [process.env.VSCODE_REMOTE_BYOK_FILE];
    const roots = [];
    const argv = process.argv || [];
    const i = argv.indexOf('--user-data-dir');
    if (i >= 0 && argv[i + 1]) roots.push(argv[i + 1]);
    if (process.env.HOME) roots.push(`${process.env.HOME}/.vscode-server/data`);
    const out = [];
    for (const r of roots) {
      out.push(`${r}/User/chatLanguageModels.json`);
      out.push(`${r}/Machine/chatLanguageModels.json`);
    }
    return out;
  }

  /**
   * 把配置里的 url 归一化成 **provider 根地址** + wireApi。
   *
   * 关键：Copilot SDK 会自己往 baseUrl 后面拼 wire 路径
   * （本地 BYOK 代理的 baseUrl 是 `http://127.0.0.1:<port>/v/<vendor>`，
   *  而请求实际打到 `/v/<vendor>/responses` —— 可见路径是 SDK 拼的）。
   * 所以这里必须给出**根**，不能带 `/chat/completions`，否则会拼成
   * `.../v1/chat/completions/chat/completions` 直接 404。
   *
   * 版本归一化沿用 copilot 扩展的规则：结尾是 `/v<N>` 就保留，否则补 `/v1`；
   * 配置里已经写全 wire 路径的先剥掉再判断。
   */
  function endpointOf(rawUrl, apiType) {
    let u = String(rawUrl || '').trim().replace(/\/+$/, '');
    if (!u) return null;
    const m = /\/(chat\/completions|responses|messages)$/.exec(u);
    const explicit = m ? m[1] : null;
    if (m) u = u.slice(0, u.length - m[0].length);
    if (!/\/v\d+$/.test(u) && !explicit) u = `${u}/v1`;
    const wireApi = (apiType === 'responses' || explicit === 'responses') ? 'responses' : 'completions';
    return { baseUrl: u, wireApi };
  }

  function shortHash(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  /** `${input:chat.lm.secret.X}` → `chat.lm.secret.X`；不是占位符则返回 undefined */
  function secretNameOf(value) {
    if (typeof value !== 'string') return undefined;
    const m = /^\$\{input:([^}]+)\}$/.exec(value.trim());
    return m ? m[1] : undefined;
  }

  /**
   * 密钥来源。
   *
   * ⚠️ 先说清楚：VS Code 的设计是「文件里只放占位符，真值在 SecretStorage」。
   * 但 agent host 是个精简的 utility 进程：bundle 里**没有** `secretStorageService` /
   * `encryptionService`（grep 全为 0），所以它**无法**参与标准流程。
   *
   * 因此这里提供的是**补丁专用兜底**（不改变配置文件的标准性）：
   * 真实密钥放在与该文件**同级**的 secrets 文件里（0600），由本适配器解析：
   *
   *   <配置文件目录>/chatLanguageModels.secrets.json
   *   { "chat.lm.secret.XXXXXXXX": "真实密钥", ... }
   *
   * 也支持环境变量兜底：`VSCODE_SECRET_<占位符名转大写下划线>`，例如
   *   chat.lm.secret.ab12cd34  →  VSCODE_SECRET_CHAT_LM_SECRET_AB12CD34
   *
   * 显式指定：VSCODE_REMOTE_BYOK_SECRETS=/path/to/secrets.json
   */
  const secretsCache = { file: null, map: null, tried: [] };

  function secretsPaths() {
    if (secretsCache.tried.length) return secretsCache.tried;
    const out = [];
    if (process.env.VSCODE_REMOTE_BYOK_SECRETS) out.push(process.env.VSCODE_REMOTE_BYOK_SECRETS);
    // 与配置文件同级的 secrets 文件，两种命名都认：
    //   chatLanguageModels.secrets.json               （标准名）
    //   <配置文件去掉 .json>.secrets.json             （自定义文件名时更直观）
    try {
      for (const p of configPaths()) {
        if (fs && fs.existsSync(p)) {
          out.push(p.replace(/\.json$/i, '') + '.secrets.json');
          out.push(p.replace(/\/[^/]*$/, '') + '/chatLanguageModels.secrets.json');
          break;
        }
      }
    } catch { /* ignore */ }
    // 兜底：默认 data 目录
    if (process.env.HOME) {
      out.push(`${process.env.HOME}/.vscode-server/data/User/chatLanguageModels.secrets.json`);
      out.push(`${process.env.HOME}/.vscode-server/data/Machine/chatLanguageModels.secrets.json`);
    }
    secretsCache.tried = out;
    return out;
  }

  function loadSecrets() {
    if (secretsCache.map) return secretsCache.map;
    const map = Object.create(null);
    for (const p of secretsPaths()) {
      try {
        if (fs && fs.existsSync(p)) {
          const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
          for (const k of Object.keys(parsed)) {
            if (typeof parsed[k] === 'string') map[k] = parsed[k];
          }
          secretsCache.file = p;
          log(`secrets loaded from ${p} (${Object.keys(parsed).length} entries)`);
          break;
        }
      } catch (e) { log(`secrets parse failed: ${p}: ${e.message}`); }
    }
    secretsCache.map = map;
    return map;
  }

  /**
   * 解析一个 secret 名。按下面顺序（前两个给"上层注入"用，最后一个是本补丁的兜底）：
   *   1. VSCODE_BYOK_SECRETS_JSON   e.g. '{"chat.lm.secret.x":"..."}'（可由启动 wrapper 注入）
   *   2. VSCODE_SECRET_<NAME>       e.g. VSCODE_SECRET_CHAT_LM_SECRET_X
   *   3. <配置同级>/chatLanguageModels.secrets.json（本补丁扩展，非 VS Code 设计）
   */
  let inlineSecrets;   // undefined = 还没解析过
  function loadedInlineSecrets() {
    if (inlineSecrets !== undefined) return inlineSecrets;
    inlineSecrets = Object.create(null);
    const raw = process.env.VSCODE_BYOK_SECRETS_JSON;
    if (typeof raw === 'string' && raw.trim()) {
      try {
        const parsed = JSON.parse(raw);
        for (const k of Object.keys(parsed)) {
          if (typeof parsed[k] === 'string') inlineSecrets[k] = parsed[k];
        }
        log(`inline secrets from VSCODE_BYOK_SECRETS_JSON (${Object.keys(inlineSecrets).length} entries)`);
      } catch (e) { log('VSCODE_BYOK_SECRETS_JSON parse failed: ' + e.message); }
    }
    return inlineSecrets;
  }

  function resolveSecret(name) {
    if (!name) return undefined;
    const inline = loadedInlineSecrets()[name];
    if (typeof inline === 'string' && inline.trim()) return inline.trim();
    const fromFile = loadSecrets()[name];
    if (typeof fromFile === 'string' && fromFile.trim()) return fromFile.trim();
    const envKey = 'VSCODE_SECRET_' + name.replace(/[^A-Za-z0-9]/g, '_').toUpperCase();
    const fromEnv = process.env[envKey];
    if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim();
    return undefined;
  }

  /**
   * 从分组/模型里取认证信息。支持四种写法（推荐第 1 种，即 VS Code 标准格式）：
   *   1. apiKey: "${input:chat.lm.secret.X}"   → 由 secrets 文件/环境变量解析
   *   2. apiKey: "YOUR-API-KEY"                      → 明文（能用，但文件里就有密钥）
   *   3. requestHeaders: { authorization: "Bearer ${apiKey}" }  → 用解析后的 apiKey 填充
   *   4. requestHeaders: { authorization: "Bearer YOUR-API-KEY" }     → 明文头
   */
  function authOf(group, model) {
    const resolvedKey = (() => {
      const raw = group.apiKey;
      if (typeof raw !== 'string') return { key: undefined, name: undefined, missing: false };
      const name = secretNameOf(raw);
      if (name) {
        const v = resolveSecret(name);
        return { key: v, name, missing: !v };
      }
      const v = raw.trim();
      return { key: v || undefined, name: undefined, missing: false };
    })();

    const headers = {};
    const missingHeaders = [];
    const rh = (model && model.requestHeaders) || null;
    if (rh && typeof rh === 'object') {
      for (const k of Object.keys(rh)) {
        const v = rh[k];
        if (typeof v !== 'string') continue;
        let out = v;
        // 头里也可能写占位符
        const inlineName = secretNameOf(out);
        if (inlineName) {
          const sv = resolveSecret(inlineName);
          if (sv) out = sv;
          else { missingHeaders.push(inlineName); continue; }
        }
        out = out.replace(/\$\{apiKey\}/g, resolvedKey.key || '');
        headers[k] = out;
      }
    }
    const hasAuthHeader = Object.keys(headers).some((k) => /^(authorization|x-api-key|api-key|apikey|x-goog-api-key)$/i.test(k));
    return {
      headers: hasAuthHeader ? headers : undefined,
      apiKey: hasAuthHeader ? undefined : resolvedKey.key,
      missingSecret: !hasAuthHeader && resolvedKey.missing ? resolvedKey.name : undefined,
      missingHeaderSecrets: missingHeaders.length ? missingHeaders : undefined,
    };
  }

  let cache = null;
  let lastError = null;

  function build() {
    const result = { models: [], providers: [], nameByModel: new Map(), ids: new Set(), selectionIds: new Set(), file: null, error: undefined, skipped: [], missingSecrets: [], secretsFile: null };
    if (!fs) { result.error = 'no fs'; return result; }

    let raw = null;
    for (const p of configPaths()) {
      try { if (fs.existsSync(p)) { raw = fs.readFileSync(p, 'utf8'); result.file = p; break; } } catch { /* ignore */ }
    }
    if (raw === null) { result.error = 'config not found: ' + configPaths().join(' | '); return result; }

    let groups;
    try {
      const parsed = JSON.parse(raw);
      groups = Array.isArray(parsed) ? parsed : (parsed.groups || []);
    } catch (e) { result.error = 'parse failed: ' + e.message; return result; }

    const seenGroup = new Map();
    const seenSelection = new Set();

    // 先扫一遍，数出每个 vendor 底下有几个「不同的端点」，决定要不要给 vendor 加后缀。
    //
    // ⚠️ 关键约束：client 可见的模型 id 是 `${vendor}/${selectionId}`，
    // 而 znt() 里 provider 的名字就是 `l.vendor`、model 的 `provider` 也是 `l.vendor`。
    // SDK 的 BYOK 键 = `<provider 名>/<selectionId>`。两者必须完全一致，
    // 否则 SDK 找不到 BYOK 模型 → resolveModelBackend 回落 {backend:"capi"}
    // → 请求打到官方 API → 「400 The requested model is not supported」。
    // 所以 provider 名**不能**和 vendor 不同；同一 vendor 要挂多个端点时，
    // 只能把 vendor 本身改写成唯一的（下面用 `--<hash>` 后缀）。
    const endpointCount = new Map();
    for (const g of groups) {
      if (!g || typeof g.vendor !== 'string' || !g.vendor.trim()) continue;
      const vendor = g.vendor.trim();
      for (const m of (Array.isArray(g.models) ? g.models : [])) {
        if (!m || typeof m.id !== 'string' || !m.id) continue;
        const ep = endpointOf(m.url || g.url, m.apiType || g.apiType);
        if (!ep || !ep.baseUrl) continue;
        const auth = authOf(g, m);
        const key = [ep.wireApi, ep.baseUrl, auth.apiKey || '', JSON.stringify(auth.headers || {})].join('|');
        if (!endpointCount.has(vendor)) endpointCount.set(vendor, new Set());
        endpointCount.get(vendor).add(key);
      }
    }
    // provider 名的后缀**不接受密钥值**参与 hash：否则换一次 key 就会改掉模型 id，
    // 客户端记住的模型选择随之失效。改为按「端点 + 该端点下的第 n 个凭据」命名。
    const perEndpointCount = new Map();
    const providerName = (vendor, endpointKey) => {
      if ((endpointCount.get(vendor)?.size ?? 0) <= 1) return vendor;
      const n = (perEndpointCount.get(endpointKey) || 0) + 1;
      perEndpointCount.set(endpointKey, n);
      const seed = n === 1 ? endpointKey : `${endpointKey}#${n}`;
      return `${vendor}--${shortHash(seed)}`;
    };

    for (const g of groups) {
      if (!g || typeof g.vendor !== 'string' || !g.vendor.trim()) continue;
      const vendor = g.vendor.trim();
      const models = Array.isArray(g.models) ? g.models : [];
      if (models.length === 0) continue;

      let groupName = String(g.name || 'default').trim() || 'default';
      const dupCount = (seenGroup.get(groupName) || 0) + 1;
      seenGroup.set(groupName, dupCount);
      if (dupCount > 1) groupName = `${groupName}~${dupCount}`;

      for (const m of models) {
        if (!m || typeof m.id !== 'string' || !m.id) continue;
        const ep = endpointOf(m.url || g.url, m.apiType || g.apiType);
        if (!ep || !ep.baseUrl) { result.skipped.push(`${g.name}/${m.id}: 没有 url`); continue; }
        if (m.apiType === 'messages') result.skipped.push(`${g.name}/${m.id}: apiType=messages 降级为 chat-completions`);
        const wireApi = ep.wireApi;
        const auth = authOf(g, m);
        if (auth.missingHeaderSecrets) {
          result.missingSecrets.push(...auth.missingHeaderSecrets);
          result.skipped.push(`${g.name}/${m.id}: requestHeaders 里的密钥未解析（缺少 ${auth.missingHeaderSecrets.join(', ')}）`);
        }
        if (auth.missingSecret) {
          result.missingSecrets.push(auth.missingSecret);
          result.skipped.push(`${g.name}/${m.id}: apiKey 占位符未解析 —— 缺少 ${auth.missingSecret}（见 chatLanguageModels.secrets.json）`);
        }
        if (!auth.apiKey && !auth.headers) result.skipped.push(`${g.name}/${m.id}: 没有可用凭据，该模型会 401`);

        // providerKey 含凭据 → 用于区分「同一端点、不同账号」；
        // endpointKey 不含凭据 → 只用于生成稳定的 provider 名。
        const endpointKey = `${wireApi}|${ep.baseUrl}`;
        const providerKey = [endpointKey, auth.apiKey || '', JSON.stringify(auth.headers || {})].join('|');
        let provider = result.providers.find((p) => p.__key === providerKey);
        const v = provider ? provider.name : providerName(vendor, endpointKey);
        if (!provider) {
          provider = {
            __key: providerKey,
            name: v,
            type: 'openai',
            wireApi,
            baseUrl: ep.baseUrl,
            ...(auth.apiKey ? { apiKey: auth.apiKey } : {}),
            ...(auth.headers ? { headers: auth.headers } : {}),
          };
          result.providers.push(provider);
        }

        // selectionId 必须唯一：同一个 `vendor/group/id` 出现两次会被 SDK 判为重复。
        let selectionId = `${groupName}/${m.id}`;
        if (seenSelection.has(selectionId)) {
          let n = 2;
          while (seenSelection.has(`${selectionId}~${n}`)) n++;
          selectionId = `${selectionId}~${n}`;
          result.skipped.push(`${g.name}/${m.id}: selectionId 重复，改用 ${selectionId}`);
        }
        seenSelection.add(selectionId);

        const modelIdentifier = `${v}/${selectionId}`;
        // ⚠️ 不要下发 reasoning effort 能力：SDK 侧元数据按 capabilityModelId 查官方模型目录，
        // 自定义模型不在目录里 → 结论是「不支持 reasoning effort」；若这里却告诉客户端「支持」，
        // 客户端会带上 reasoningEffort，会话构造直接失败。
        // （补丁另外在 BQ/GQ 里做了强制短路，这里是第二道保险。）
        if (Array.isArray(m.supportsReasoningEffort)) {
          result.skipped.push(`${groupName}/${m.id}: 忽略 supportsReasoningEffort（SDK 侧元数据不认自定义模型）`);
        }
        const info = {
          vendor: v,
          id: m.id,
          ...(m.name ? { name: m.name } : {}),
          modelIdentifier,
          ...(typeof m.maxInputTokens === 'number' ? { maxContextWindowTokens: m.maxInputTokens, maxPromptTokens: m.maxInputTokens } : {}),
          ...(typeof m.contextWindow === 'number' && typeof m.maxInputTokens !== 'number' ? { maxContextWindowTokens: m.contextWindow } : {}),
          ...(typeof m.maxOutputTokens === 'number' ? { maxOutputTokens: m.maxOutputTokens } : {}),
          supportsVision: m.vision === true,
        };
        result.models.push(info);
        result.nameByModel.set(modelIdentifier, provider.name);
        result.ids.add(modelIdentifier);
        result.selectionIds.add(selectionId);
      }
    }

    result.secretsFile = secretsCache.file;
    result.missingSecrets = [...new Set(result.missingSecrets)];
    result.providers = result.providers.map(({ __key, ...p }) => p);
    return result;
  }

  function ensure() {
    if (!cache) {
      try { cache = build(); } catch (e) { cache = { models: [], providers: [], nameByModel: new Map(), ids: new Set(), selectionIds: new Set(), missingSecrets: [], error: String(e && e.message) }; }
      const summary = `loaded pid=${process.pid} file=${cache.file || '(none)'} models=${cache.models.length} providers=${cache.providers.length}` +
        (cache.error ? ` error=${cache.error}` : '') +
        (cache.skipped && cache.skipped.length ? ` skipped=${cache.skipped.length}` : '');
      announce(summary);
      log(summary);
      if (cache.skipped) for (const s of cache.skipped.slice(0, 8)) log(`  skip: ${s}`);
    }
    return cache;
  }

  function keyOf(model) {
    return (model && (model.modelIdentifier || model.id)) || '';
  }

  return {
    /** 诊断用 */
    describe() {
      const c = ensure();
      return {
        file: c.file, models: c.models.length, providers: c.providers.length,
        error: c.error, skipped: c.skipped, lastError,
        modelIds: c.models.map((m) => m.modelIdentifier),
        providerNames: c.providers.map((p) => p.name),
        secretsFile: c.secretsFile,
        missingSecrets: c.missingSecrets || [],
      };
    },

    /**
     * 这个客户端模型 id 是不是我们注入的？
     *
     * 用途：agent host 在 `createSession` 时会把模型配置里的 thinkingLevel/contextSize
     * 翻译成 `reasoningEffort` / `contextTier` 传给 Copilot SDK：
     *   function qnt(o){let e=o?.config?.["thinkingLevel"]??o?.config?.["reasoningEffort"];…}
     *   function BQ(o,…){return lAe(o,dAe(o,…)??qnt(o))}
     *   …client.createSession({…, reasoningEffort: BQ(s,…), contextTier: GQ(s,…)})
     * 而 SDK 的原生元数据按 capabilityModelId 去官方模型目录查，自研模型不在目录里
     * → 判定「不支持 reasoning effort」，会话构造直接失败。
     * 所以对我们注入的模型，这两个值一律压掉（补丁在 BQ / GQ 里提前返回 undefined）。
     */
    isOurs(modelId) {
      try {
        if (typeof modelId !== 'string' || !modelId) return false;
        const c = ensure();
        if (c.ids.has(modelId) || c.selectionIds.has(modelId)) return true;
        // 容错：调用点可能拿到的是剥掉 provider 前缀后的 `<group>/<id>`。
        const slash = modelId.indexOf('/');
        return slash > 0 && c.selectionIds.has(modelId.slice(slash + 1));
      } catch { return false; }
    },

    /** 把模型的 provider 查成我们合成出来的 provider 名 */
    providerFor(model) {
      const c = ensure();
      try {
        return c.nameByModel.get(keyOf(model)) || model.vendor;
      } catch (e) { lastError = String(e && e.message); return model.vendor; }
    },

    /** znt() 需要的那份 providers（只返回本轮真正用到的） */
    providers(models) {
      const c = ensure();
      try {
        const want = new Set((models || []).map((m) => this.providerFor(m)));
        return c.providers.filter((p) => want.has(p.name));
      } catch (e) { lastError = String(e && e.message); return []; }
    },

    /** 包住 agent host 里那个 ByokLmBridgeRegistry 实例，把 getModels 接上 */
    wrap(registry) {
      try {
        if (!registry || registry.__vscodeRemoteByok) return registry;
        const orig = typeof registry.getModels === 'function' ? registry.getModels.bind(registry) : () => [];
        registry.getModels = function () {
          let base = [];
          try { base = [...(orig() || [])]; } catch { /* ignore */ }
          const extra = ensure().models;
          if (base.length === 0) return extra;
          const seen = new Set(base.map((m) => keyOf(m)));
          return base.concat(extra.filter((m) => !seen.has(keyOf(m))));
        };
        Object.defineProperty(registry, '__vscodeRemoteByok', { value: true, enumerable: false });
        ensure();
        log(`registry wrapped (base models=${(() => { try { return orig().length; } catch { return -1; } })()})`);
      } catch (e) { lastError = String(e && e.message); log('wrap failed: ' + lastError); }
      return registry;
    },
  };
})();
