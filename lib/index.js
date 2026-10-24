/**
 * 会话删除插件 —— Host 半边。
 *
 * 提供一条同源、仅本机可用的删除接口：左侧边栏右键会话 → 浏览器半边调用
 * 这条接口 → 这里把该会话的物理文件、投影缓存、工作区记账一次性清干净。
 *
 * 只依赖 Node 内置模块，不引入任何 @deepseek-ai/* 运行时依赖，方便单独测试。
 *
 * @module session-purge
 */

import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import {
	SessionDeleteError,
	deleteSessionStorage,
	encodeSessionSegment,
	isSafeSessionId,
	removeProjectionCacheFile,
} from './core.js';

/** 插件名（Loader 内的模块级名字）。 */
export const name = 'session-purge';

/** webServer 就绪后才应用。 */
export const inject = ['webServer'];

/**
 * 删除接口路径。
 *
 * 这里不做成插件配置：浏览器半边拿不到 Host 半边的 `config`，一旦允许改路由，
 * 两边就会各自记住不同的路径，改完只会得到一个 404。所以路径固定，两边共用
 * 同一份常量。
 */
const ROUTE = '/session-purge';

/** 请求体上限，防呆。 */
const MAX_BODY_BYTES = 8192;

/**
 * 解析 DSH home，优先级与 `@deepseek-ai/dsh-home-paths` 一致：
 * 非空 `$DSH_HOME` → `~/.dsh`。
 * @returns 绝对路径。
 */
function dshHome() {
	const env = process.env.DSH_HOME;
	if (typeof env === 'string' && env.trim().length > 0) return resolve(env);
	return join(homedir(), '.dsh');
}

/**
 * 会话持久化根目录：优先取运行时服务的真实根，回退到默认 home。
 * @param ctx - Cordis 上下文。
 * @returns 绝对路径。
 */
function sessionRootOf(ctx) {
	const root = ctx.get('sessionPersistence')?.root;
	return typeof root === 'string' && root.length > 0 ? root : join(dshHome(), 'sessions');
}

/**
 * 存储根目录的候选列表，按可信度排序去重。
 *
 * 优先用插件配置；否则从会话根目录的父目录推导（发行版把 `sessions` 与
 * `storages` 放在同一个 home 下）；最后回退到默认 home。
 *
 * @param ctx - Cordis 上下文。
 * @param config - 插件配置。
 * @returns 候选绝对路径。
 */
function storageRootCandidates(ctx, config) {
	const candidates = [];
	if (typeof config?.storageRoot === 'string' && config.storageRoot.length > 0) {
		candidates.push(resolve(config.storageRoot));
	}
	const root = ctx.get('sessionPersistence')?.root;
	if (typeof root === 'string' && root.length > 0) candidates.push(join(dirname(resolve(root)), 'storages'));
	candidates.push(join(dshHome(), 'storages'));
	return [...new Set(candidates)];
}

/**
 * 回环地址判定：`localhost` / `127.0.0.0/8` / `::1`。
 *
 * 「Origin 与 Host 相等」挡不住 DNS rebinding：攻击者页面把自己的域名解析到
 * 127.0.0.1 时，两个头会一起变成同一个非回环域名。所以这条接口只认回环 Host。
 *
 * @param host - `Host` 头（可能带端口）。
 * @returns 是回环时为 true。
 */
function isLoopbackHost(host) {
	if (typeof host !== 'string' || host.length === 0) return false;
	let name = host;
	if (name.startsWith('[')) {
		const end = name.indexOf(']');
		if (end === -1) return false;
		name = name.slice(1, end);
	} else {
		const colon = name.lastIndexOf(':');
		if (colon !== -1) name = name.slice(0, colon);
	}
	const lower = name.toLowerCase();
	if (lower === 'localhost' || lower === '::1' || lower === '0:0:0:0:0:0:0:1') return true;
	const parts = lower.split('.');
	if (parts.length !== 4 || parts[0] !== '127') return false;
	return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/**
 * 只允许本机同源请求。
 *
 * - `Host` 必须是回环地址（挡 DNS rebinding）；
 * - 浏览器发跨站请求一定会带上 `Sec-Fetch-Site`，标着 `cross-site` 的直接拒，
 *   省得将来某种不带 `Origin` 的浏览器上下文把请求送进来；
 * - 带 `Origin` 时必须与 `Host` 同源；
 * - 没有 `Origin`、也没有 `Sec-Fetch-Site` 的本地进程调用（脚本、curl、测试）放行。
 *
 * @param req - Node 请求对象。
 * @returns 允许时为 true。
 */
function sameOrigin(req) {
	const host = req.headers.host;
	if (!isLoopbackHost(host)) return false;
	const site = req.headers['sec-fetch-site'];
	if (typeof site === 'string' && site.length > 0) {
		const normalized = site.toLowerCase();
		if (normalized !== 'same-origin' && normalized !== 'none') return false;
	}
	const origin = req.headers.origin;
	if (typeof origin !== 'string' || origin.length === 0) return true;
	if (origin === 'null') return false;
	let originHost;
	try {
		originHost = new URL(origin).host;
	} catch {
		return false;
	}
	return originHost.toLowerCase() === host.toLowerCase();
}

/**
 * 读取并解析 JSON 请求体。
 *
 * 超长和非法 JSON 是两回事，分开报：前者 413，后者才是 400。
 *
 * @param req - Node 请求对象。
 * @returns `{ ok: true, body }` 或 `{ ok: false, code }`。
 */
function readJsonBody(req) {
	return new Promise((done) => {
		let size = 0;
		let oversize = false;
		const chunks = [];
		req.on('data', (chunk) => {
			if (oversize) return;
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				oversize = true;
				done({ ok: false, code: 'payload-too-large' });
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => {
			if (oversize) return;
			try {
				done({ ok: true, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
			} catch {
				done({ ok: false, code: 'bad-request' });
			}
		});
		req.on('error', () => {
			if (!oversize) done({ ok: false, code: 'bad-request' });
		});
	});
}

/**
 * 发送 JSON 响应。
 * @param res - Node 响应对象。
 * @param status - HTTP 状态码。
 * @param payload - 响应体。
 */
function send(res, status, payload) {
	const body = JSON.stringify(payload);
	res.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'content-length': Buffer.byteLength(body),
		'cache-control': 'no-store',
	});
	res.end(body);
}

/**
 * 询问运行中的活动提供者：这个会话此刻有没有在跑的东西。
 * @param ctx - Cordis 上下文。
 * @param sessionId - 会话 id。
 * @returns 活动条目列表。
 */
async function sessionActivity(ctx, sessionId) {
	if (typeof ctx.waterfall !== 'function') return [];
	const activity = await ctx.waterfall('workspace/session-activity', { sessionId }, () => Promise.resolve([]));
	return Array.isArray(activity) ? activity : [];
}

/**
 * 请求所有提供者停掉该会话的工作（与归档的 `stopActivity` 同一条通道）。
 * @param ctx - Cordis 上下文。
 * @param sessionId - 会话 id。
 */
async function stopSessionActivity(ctx, sessionId) {
	try {
		await ctx.parallel('workspace/session-stop', { sessionId });
	} catch (error) {
		const failures = error instanceof AggregateError ? error.errors : [error];
		for (const failure of failures) ctx.logger?.warn?.(`session-purge: 停止会话 ${sessionId} 的工作失败: ${String(failure)}`);
	}
}

/**
 * 这个工作区还记不记得该会话。
 *
 * `workspace.sessionIds` 是实体上**按会话头索引过滤过**的 getter：会话头一旦
 * 不在索引里（文件被删掉之后就会这样），它会把 id 藏起来。所以「看不见」不等于
 * 「没记账」——`detachSession` 是幂等的，写不动时 `mutate` 也不会落盘，多问一句
 * 不花什么代价，漏问却会把死 id 永久留在 workspace.json 里。两处都没有才算真的
 * 不相干。
 *
 * @param workspace - 工作区实体。
 * @param sessionId - 会话 id。
 * @returns 需要摘除时为 true。
 */
function workspaceAccountsFor(workspace, sessionId) {
	const visible = workspace?.sessionIds;
	if (Array.isArray(visible) && visible.includes(sessionId)) return true;
	const raw = workspace?.record?.sessionIds;
	return Array.isArray(raw) && raw.includes(sessionId);
}

/**
 * 把会话 id 从工作区记账里摘掉：成员列表、置顶、归档三处。
 * @param ctx - Cordis 上下文。
 * @param sessionId - 会话 id。
 * @returns 受影响的工作区 id。
 */
async function detachFromWorkspaces(ctx, sessionId) {
	const registry = ctx.get('workspaceRegistry');
	const detached = [];
	if (registry === undefined) return detached;
	try {
		for (const workspace of registry.list()) {
			try {
				if (typeof workspace.detachSession !== 'function') continue;
				if (!workspaceAccountsFor(workspace, sessionId)) continue;
				await workspace.detachSession(sessionId);
				detached.push(workspace.id);
			} catch (error) {
				ctx.logger?.warn?.(`session-purge: 从工作区摘除会话失败: ${String(error)}`);
			}
		}
	} catch (error) {
		ctx.logger?.warn?.(`session-purge: 读取工作区列表失败: ${String(error)}`);
	}
	try {
		await registry.unpinSession?.(sessionId);
	} catch {
		/* 未置顶时是无操作 */
	}
	try {
		await registry.unarchiveSession?.(sessionId);
	} catch {
		/* 未归档时是无操作 */
	}
	return detached;
}

/**
 * 等一会儿。
 * @param ms - 毫秒。
 * @returns 到点后 resolve。
 */
function delay(ms) {
	return new Promise((done) => setTimeout(done, ms));
}

/**
 * 轮询等活动提供者把该会话的活干完。
 * @param ctx - Cordis 上下文。
 * @param sessionId - 会话 id。
 * @param timeoutMs - 最长等待时间。
 * @returns 清空时为 true。
 */
async function waitForActivityToClear(ctx, sessionId, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if ((await sessionActivity(ctx, sessionId)).length === 0) return true;
		if (Date.now() >= deadline) return false;
		await delay(200);
	}
}

/**
 * 删除会话目录，遇到占用类错误时重试几次。
 * @param sessionRoot - 会话持久化根目录。
 * @param sessionId - 会话 id。
 * @returns 被删除的路径。
 */
async function removeStorageWithRetry(sessionRoot, sessionId) {
	let lastError;
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			return await deleteSessionStorage({ sessionRoot, sessionId });
		} catch (error) {
			lastError = error;
			await delay(150);
		}
	}
	throw lastError;
}

/**
 * 注册一步拦门：已被删除的会话不许再跑新的模型步骤。
 *
 * 这样即使进程里还留着一个已经删掉的会话的 Agent，它收到的迟到投递也只会
 * 以 `blocked` 收场，不会把日志文件重新写出来（与归档会话的 gate 同一形状）。
 *
 * 这条监听会在**所有**会话的每一步模型调用前被走到，而没删过会话的人一次都
 * 用不上它，所以不在 `apply()` 里常驻：等第一次真的删成功之后再装，装一次
 * 长期有效。`tombstones` 为空时它本来也只是原样放行。
 *
 * @param ctx - Cordis 上下文。
 * @param tombstones - 删除后禁步的会话 id 集合（插件生命周期内有效）。
 * @returns 装上拦门的函数；重复调用无副作用。
 */
export function tombstoneGate(ctx, tombstones) {
	let dispose;
	return () => {
		if (dispose !== undefined) return;
		dispose = ctx.effect(
			() =>
				ctx.on('agent/pre-step', (payload, next) => {
					const id = payload?.agent?.session?.header?.id;
					return typeof id === 'string' && tombstones.has(id) ? Promise.resolve({ kind: 'reject' }) : next();
				}),
			'session-purge: 已删会话拦门',
		);
	};
}

/**
 * 删掉 projection cache 里的那一条记录，并保证磁盘文件也不残留。
 * @param ctx - Cordis 上下文。
 * @param sessionId - 会话 id。
 * @returns 删除结果。
 */
async function removeProjectionCache(ctx, sessionId, config) {
	let viaDomain = false;
	let domainError;
	try {
		const table = ctx.get('storageDomain')?.get?.('session_projcache')?.table?.('sessions');
		if (table !== undefined) viaDomain = (await table.delete(sessionId)) === true;
	} catch (error) {
		domainError = String(error);
	}
	let fileRemoved = false;
	for (const root of storageRootCandidates(ctx, config)) {
		if (await removeProjectionCacheFile(root, sessionId)) fileRemoved = true;
	}
	return { viaDomain, fileRemoved, domainError };
}

/**
 * 把一个 id 从其所属注册表里摘掉。
 *
 * DSH 的 `ctx.sessions` / `ctx.agents` 都没有公开的“删除一个条目”入口：条目
 * 的摘除能力由 `enter()` 返回给创建者。但两者的实体方法（`detachEntered`）
 * 与存储容器（`store`）是稳定的，能在 `enter` 之后被复用，所以这里做一次
 * 能力探测，拿不到就老实放弃（退化为旧行为，不影响删除本身）。
 *
 * @param service - `ctx.sessions` 或 `ctx.agents`。
 * @param id - 会话 / Agent id。
 * @returns 真的摘掉了一个条目时为 true。
 */
function detachRegistryEntry(service, id) {
	if (service === null || typeof service !== 'object') return false;
	// 只走带完整 teardown 的那条路：缺了 detachEntered 就什么都不做，
	// 悄悄 `store.delete` 会跳过 session/disposed，反倒留下一个还能写的句柄。
	if (typeof service.detachEntered !== 'function') return false;
	const store = service.store;
	if (!(store instanceof Map)) return false;
	const entry = store.get(id);
	if (entry === undefined) return false;
	service.detachEntered(entry);
	return true;
}

/**
 * 把进程内还活着的会话与 Agent 摘掉。
 *
 * 这一步是“删了却还在列表里”的解药。`ctx.sessions.list()` 里活着的会话会无
 * 条件并进会话列表（`SessionCorpus.listSessions` = 磁盘 ∪ 内存），所以只要
 * 进程里还挂着，侧边栏就一直有这一行、点进去也还能看到内存里的内容。摘掉之
 * 后 `session/disposed` 会发出去，客户端收到 `api-session/removed` 自行去掉
 * 那一行，同时 jsonl 后端会关掉写句柄，杜绝“删完又被写回来”。
 *
 * 顺序有讲究：会话先摘。`agents` 的 `agent/disposed` 监听会在
 * `ctx.sessions.get(id) === agent.session` 时补发一条 `api-session/added`，
 * 先摘会话就不会被补回来。
 *
 * @param ctx - Cordis 上下文。
 * @param sessionId - 会话 id。
 * @returns `{ session, agent, errors }`，报告实际摘掉了哪几个。
 */
export function detachLiveSession(ctx, sessionId) {
	const errors = [];
	const attempt = (name, service) => {
		try {
			return detachRegistryEntry(service, sessionId);
		} catch (error) {
			errors.push(`${name}: ${String(error)}`);
			return false;
		}
	};
	const session = attempt('sessions', ctx.get?.('sessions'));
	const agent = attempt('agents', ctx.get?.('agents'));
	return { session, agent, errors };
}

/**
 * 让全文搜索索引把这条会话的记录也丢掉。
 *
 * SQLite 索引（`sessionQuery`）在每次搜索前会拿磁盘与内存的真实语料对一遍账，
 * 主动踢一脚就能立刻消掉遗留的 FTS 记录，而不是等用户下次搜索。索引不可用或
 * 配置为关闭时静默跳过，绝不因为索引问题让删除失败。
 *
 * 冷索引第一次对账可能要读一遍全部会话日志，所以给一个预算：超时就把对账丢到
 * 后台继续，响应不等它——索引本来就在每次查询前自行对齐，延迟清掉不会让它被
 * 搜出内容来。
 *
 * @param ctx - Cordis 上下文。
 * @param sessionId - 会话 id。
 * @param budgetMs - 同步等待预算（毫秒）。
 * @returns `done`（已对完账）/ `background`（超时转后台）/ `unavailable`（索引不可用）。
 */
async function reconcileSessionQuery(ctx, sessionId, budgetMs) {
	const query = ctx.get?.('sessionQuery');
	if (query === null || typeof query !== 'object' || typeof query.searchSessions !== 'function') return 'unavailable';
	const request = { query: 'session-purge', limit: 1 };
	const run = (signal) => query.searchSessions(request, signal === undefined ? undefined : { signal });
	const controller = new AbortController();
	// 和预算赛跑，而不是只靠 signal：万一索引那边不理会中断，也不能把响应吊住。
	let expired = false;
	let timer;
	const budget = new Promise((resolve) => {
		timer = setTimeout(() => {
			expired = true;
			controller.abort();
			resolve();
		}, budgetMs);
	});
	const background = () => {
		Promise.resolve()
			.then(() => run(undefined))
			.then(() => undefined)
			.catch((reason) => ctx.logger?.debug?.(`session-purge: 后台搜索索引对账失败: ${String(reason)}`));
		return 'background';
	};
	try {
		await Promise.race([run(controller.signal), budget]);
		return expired ? background() : 'done';
	} catch (error) {
		if (expired || controller.signal.aborted) return background();
		// 索引会在下次搜索时自行对齐；这里只是尽力提前清掉。
		ctx.logger?.debug?.(`session-purge: 触发搜索索引对账失败: ${String(error)}`);
		return 'unavailable';
	} finally {
		clearTimeout(timer);
	}
}

/**
 * 真正执行删除：停掉在跑的工作 → 摘掉活会话 → 清文件 → 复查残留 → 清缓存 → 清记账。
 *
 * 关键点有两个：
 *
 * 1. **不**以“运行时有这个 Agent”为拒绝条件。DSH 的注册表会把进程内打开过
 *    的每个会话一直持有着，用户切走也不会释放，拿它当“是否正在打开”会误伤
 *    几乎所有会话。真正该拦的是“有东西在跑”，那由
 *    `workspace/session-activity` 报出来。
 * 2. 删文件之前先把活会话摘掉。既让侧边栏立刻去掉这一行，也让 jsonl 后端关
 *    掉写句柄——否则活着的会话会在某个 flush 时机把日志重新写出来。
 *
 * @param ctx - Cordis 上下文。
 * @param sessionId - 会话 id。
 * @param options - `stop`、`storageRoot`、`tombstones`、`settleMs`、`residualDelayMs`（首次复查等待）、`pollMs`（之后每次复查间隔）、`residualBudgetMs`（复查总预算）、`searchBudgetMs`（索引对账同步预算）。
 * @returns 删除结果。
 */
export async function deleteSession(ctx, sessionId, options = {}) {
	const startedAt = Date.now();
	if (!isSafeSessionId(sessionId)) {
		throw new SessionDeleteError('invalid-session-id', `不合法的会话 id: ${String(sessionId)}`, { status: 400 });
	}
	const encoded = encodeSessionSegment(sessionId);

	let activity = await sessionActivity(ctx, sessionId);
	let activityStopped = false;
	if (activity.length > 0) {
		if (options.stop !== true) {
			throw new SessionDeleteError('session-active', '该会话还有正在运行的工作。', { status: 409, activity });
		}
		activityStopped = true;
		await stopSessionActivity(ctx, sessionId);
		if (!(await waitForActivityToClear(ctx, sessionId, options.settleMs ?? 4000))) {
			throw new SessionDeleteError('session-active', '该会话仍在运行，停止尚未完成，请稍后重试。', {
				status: 409,
				activity: await sessionActivity(ctx, sessionId),
			});
		}
	}

	const liveAgent = ctx.get('agents')?.get?.(sessionId) !== undefined;
	const sessionRoot = sessionRootOf(ctx);

	// 先摘掉进程内的活会话：既让侧边栏立刻去行，也让 jsonl 后端关掉写句柄。
	// 摘的动作会让写句柄异步收尾（可能落一次盘），但不必在这儿干等——下面的
	// 复查会跟着这个窗口走。
	const detachedLive = detachLiveSession(ctx, sessionId);

	// 会话目录可能被占用（正在追加一批事件），给几次重试的机会。
	const removedPaths = await removeStorageWithRetry(sessionRoot, sessionId);

	// 复查残留：刚摘掉的活会话可能在收尾时又落一个文件下来。不睡固定时长，改成
	// 每 40ms 探一次，连续两轮干净就收工（没摘过活会话只要一轮），并有总预算兜底。
	const residualPaths = [];
	const quietTarget = detachedLive.session || detachedLive.agent ? 2 : 1;
	const budget = Date.now() + Math.max(0, options.residualBudgetMs ?? 1500);
	const firstDelay = Math.max(0, options.residualDelayMs ?? 40);
	const pollDelay = Math.max(1, options.pollMs ?? 40);
	let quiet = 0;
	let attempt = 0;
	while (quiet < quietTarget && Date.now() < budget) {
		await delay(attempt === 0 ? Math.min(firstDelay, Math.max(0, budget - Date.now())) : pollDelay);
		const swept = await deleteSessionStorage({ sessionRoot, sessionId });
		residualPaths.push(...swept);
		quiet = swept.length === 0 ? quiet + 1 : 0;
		attempt += 1;
	}

	const projectionCache = await removeProjectionCache(ctx, sessionId, { storageRoot: options.storageRoot });
	const detached = await detachFromWorkspaces(ctx, sessionId);

	// 已经删掉的会话不许再跑新一轮模型请求，否则日志会被重新写出来。
	// 拦门到这一刻才装：之前没删过东西的话，它只会白白搭在所有会话的每一步上。
	options.tombstones?.add?.(sessionId);
	options.armGate?.();

	// 让全文索引顺手对一次账，别把内容留在 SQLite 里（超预算就转后台）。
	const searchReconciled = await reconcileSessionQuery(ctx, sessionId, Math.max(0, options.searchBudgetMs ?? 800));
	const elapsedMs = Date.now() - startedAt;

	ctx.logger?.info?.(
		`session-purge: 已删除 ${sessionId}（${elapsedMs}ms，活会话摘除 session=${detachedLive.session} agent=${detachedLive.agent}，` +
			`残留清理 ${residualPaths.length} 项，索引对账=${searchReconciled}）`,
	);

	return {
		sessionId,
		encoded,
		removedPaths,
		residualPaths,
		projectionCache,
		detachedWorkspaces: detached,
		detachedLive,
		searchReconciled,
		activityStopped,
		liveAgent,
		elapsedMs,
	};
}

/**
 * 处理删除接口的一次调用。
 * @param ctx - Cordis 上下文。
 * @param req - Node 请求对象。
 * @param res - Node 响应对象。
 * @param config - 插件配置（`storageRoot`）。
 * @param tombstones - 删除后禁步的会话 id 集合。
 * @param armGate - 装上拦门的函数；第一次删成功时调用。
 */
export async function handleDeleteRequest(ctx, req, res, config, tombstones, armGate) {
	try {
		if (req.method !== 'POST') {
			send(res, 405, { ok: false, code: 'method-not-allowed', message: '请使用 POST' });
			return;
		}
		if (!sameOrigin(req)) {
			send(res, 403, { ok: false, code: 'forbidden', message: '拒绝跨站请求' });
			return;
		}
		if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
			send(res, 415, { ok: false, code: 'unsupported-media-type', message: '请求体必须是 application/json' });
			return;
		}
		const parsed = await readJsonBody(req);
		if (!parsed.ok) {
			if (parsed.code === 'payload-too-large') {
				send(res, 413, { ok: false, code: 'payload-too-large', message: `请求体超过 ${MAX_BODY_BYTES} 字节` });
				return;
			}
			send(res, 400, { ok: false, code: 'bad-request', message: '请求体不是合法 JSON' });
			return;
		}
		const body = parsed.body;
		if (body === null || typeof body !== 'object') {
			send(res, 400, { ok: false, code: 'bad-request', message: '请求体必须是 JSON 对象' });
			return;
		}
		const result = await deleteSession(ctx, body.sessionId, {
			stop: body.stop !== false,
			storageRoot: config?.storageRoot,
			tombstones,
			armGate,
		});
		send(res, 200, { ok: true, result });
	} catch (error) {
		if (error instanceof SessionDeleteError) {
			send(res, error.status, {
				ok: false,
				code: error.code,
				message: error.message,
				activity: error.activity,
			});
			return;
		}
		// 意外错误只进日志：响应里回显内部错误会把这半边的实现细节送给浏览器。
		ctx.logger?.warn?.(error);
		send(res, 500, { ok: false, code: 'internal', message: '删除失败：服务端内部错误，详情见 Host 日志' });
	}
}

/**
 * 注册删除路由。
 *
 * 加载时只做两件事：挂一条路由、记一行日志。除路由之外的常驻钩子一个都不装
 * （禁步拦门要等第一次真删成功，见 {@link tombstoneGate}），空闲时这个插件不
 * 占监听、不占定时器、不碰磁盘。
 *
 * 路由固定，理由见 {@link ROUTE}。
 *
 * @param ctx - Cordis 上下文（已注入 webServer）。
 * @param config - 可选的 `{ storageRoot }`。
 */
export function apply(ctx, config) {
	const tombstones = new Set();
	const armGate = tombstoneGate(ctx, tombstones);
	const handler = (req, res) => handleDeleteRequest(ctx, req, res, config, tombstones, armGate);
	const dispose = ctx.webServer.register({ kind: 'exact', path: ROUTE, handler });
	ctx.effect(() => dispose, 'session-purge: route');
	ctx.logger?.info?.(`session-purge: 删除接口已挂载 ${ROUTE}`);
}
