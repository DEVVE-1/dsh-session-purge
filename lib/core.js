/**
 * 会话删除插件 —— 与框架无关的文件系统部分。
 *
 * 这里只做两件事：把会话 id 安全地映射成磁盘路径，以及把该会话在磁盘上的
 * 全部持久化痕迹删掉。所有函数都不依赖 Cordis，可脱离运行时单独测试。
 *
 * @module session-purge/core
 */

import { readdir, rm, rmdir, stat } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';

/** 插件内统一的结构化错误。 */
export class SessionDeleteError extends Error {
	/**
	 * @param code - 机器可读的错误码。
	 * @param message - 面向用户的说明。
	 * @param options - 附加字段（HTTP 状态、活动列表等）。
	 */
	constructor(code, message, options = {}) {
		super(message);
		this.name = 'SessionDeleteError';
		this.code = code;
		this.status = options.status ?? 400;
		this.activity = options.activity;
		this.cause = options.cause;
	}
}

/** 会话 id 允许的字符：与 jsonl 后端的路径编码保持同一集合。 */
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** 单个路径段允许的字符（json 存储 per-record 布局的键规则）。 */
const SAFE_KEY_RE = /^[a-zA-Z0-9_-]+$/;

/** 路径段中无需转义的字符。 */
const PLAIN_CHAR_RE = /^[A-Za-z0-9._-]$/;

/**
 * 校验一个会话 id 是否可以安全地当作单个路径段使用。
 *
 * 拒绝空串、超长、路径分隔符、`.`/`..` 以及任何需要转义的字符，这样后续
 * 的文件操作永远不会逃出会话根目录。
 *
 * @param id - 待校验的会话 id。
 * @returns 合法时为 true。
 */
export function isSafeSessionId(id) {
	if (typeof id !== 'string') return false;
	if (id.length === 0 || id.length > 200) return false;
	if (id === '.' || id === '..') return false;
	return SAFE_ID_RE.test(id);
}

/**
 * 复刻 jsonl 会话后端使用的路径段编码（`encodeSegment`）。
 *
 * 只对合法 id 调用；非 `[A-Za-z0-9._-]` 的字符统一写成 `~XXXX`。
 *
 * @param raw - 会话 id。
 * @returns 单个安全的路径段。
 */
export function encodeSessionSegment(raw) {
	if (!isSafeSessionId(raw)) {
		throw new SessionDeleteError('invalid-session-id', `不合法的会话 id: ${String(raw)}`, { status: 400 });
	}
	if (raw === '.') return '~002E';
	if (raw === '..') return '~002E~002E';
	let out = '';
	for (let index = 0; index < raw.length; index++) {
		const code = raw.charCodeAt(index);
		const char = String.fromCharCode(code);
		out += char !== '~' && PLAIN_CHAR_RE.test(char) ? char : `~${code.toString(16).toUpperCase().padStart(4, '0')}`;
	}
	return out;
}

/**
 * 判断一个路径是不是目录；任何失败都当作“不是”。
 * @param path - 待检查的路径。
 * @returns 是目录时为 true。
 */
export async function isDirectory(path) {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

/**
 * 判断一个路径是否存在。
 * @param path - 待检查的路径。
 * @returns 存在时为 true。
 */
export async function pathExists(path) {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * 在会话根目录下找出该会话拥有的目录。
 *
 * 布局是 `<root>/<projectKey>/<encodedId>/`；这里逐个 project 目录探测，
 * 只接受直接位于某个 project 目录下、名字等于编码 id 的目录。
 *
 * @param sessionRoot - 会话持久化根目录。
 * @param sessionId - 会话 id。
 * @returns 命中的 `{ projectDir, sessionDir }` 列表。
 */
export async function findSessionDirs(sessionRoot, sessionId) {
	const segment = encodeSessionSegment(sessionId);
	const found = [];
	let projects;
	try {
		projects = await readdir(sessionRoot, { withFileTypes: true });
	} catch (error) {
		if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return found;
		throw error;
	}
	for (const project of projects) {
		if (!project.isDirectory()) continue;
		const projectDir = join(sessionRoot, project.name);
		const sessionDir = join(projectDir, segment);
		if (await isDirectory(sessionDir)) found.push({ projectDir, sessionDir });
	}
	return found;
}

/**
 * 删除前的最后一道保险：目标必须是根目录之下、且以编码 id 命名的一段。
 * @param sessionRoot - 会话持久化根目录。
 * @param target - 待删除的目录。
 * @param segment - 允许的最后一段名字。
 */
function assertDeletable(sessionRoot, target, segment) {
	const root = resolve(sessionRoot);
	const full = resolve(target);
	if (full === root || !full.startsWith(root + sep)) {
		throw new SessionDeleteError('unsafe-path', `拒绝删除会话根目录之外的路径: ${full}`, { status: 500 });
	}
	if (basename(full) !== segment) {
		throw new SessionDeleteError('unsafe-path', `拒绝删除名字不匹配的目录: ${full}`, { status: 500 });
	}
}

/**
 * 删除一个会话在会话根目录下的所有物理文件。
 *
 * 会话目录整体删除；删空之后顺带收掉空掉的 project 目录，避免留下空壳。
 *
 * @param options - `sessionRoot`、`sessionId`，以及是否回收空 project 目录。
 * @returns 被删除的路径列表。
 */
export async function deleteSessionStorage({ sessionRoot, sessionId, removeEmptyProjectDir = true }) {
	const segment = encodeSessionSegment(sessionId);
	const removed = [];
	for (const { projectDir, sessionDir } of await findSessionDirs(sessionRoot, sessionId)) {
		assertDeletable(sessionRoot, sessionDir, segment);
		await rm(sessionDir, { recursive: true, force: true });
		removed.push(sessionDir);
		if (!removeEmptyProjectDir) continue;
		const left = await readdir(projectDir).catch(() => null);
		if (left === null || left.length > 0) continue;
		try {
			await rmdir(projectDir);
			removed.push(projectDir);
		} catch {
			/* project 目录非空或被占用时保留，不影响删除结果 */
		}
	}
	return removed;
}

/**
 * projection cache 的单条记录路径：`<storageRoot>/session_projcache/sessions/<id>.json`。
 *
 * 只有 id 满足 json 后端 per-record 布局的键规则时才返回路径，否则回退为
 * `null`（由存储域自己在内存里处理）。
 *
 * @param storageRoot - `storages` 根目录。
 * @param sessionId - 会话 id。
 * @returns 记录文件路径，或 null。
 */
export function projectionCacheRecordPath(storageRoot, sessionId) {
	if (!SAFE_KEY_RE.test(sessionId)) return null;
	return join(storageRoot, 'session_projcache', 'sessions', `${sessionId}.json`);
}

/**
 * 删除 projection cache 的记录文件（存在才删）。
 * @param storageRoot - `storages` 根目录。
 * @param sessionId - 会话 id。
 * @returns 是否真的删掉了文件。
 */
export async function removeProjectionCacheFile(storageRoot, sessionId) {
	const recordPath = projectionCacheRecordPath(storageRoot, sessionId);
	if (recordPath === null) return false;
	if (!(await pathExists(recordPath))) return false;
	await rm(recordPath, { force: true });
	return true;
}
