window.__ModuleLoader__.load({
	id: "session-purge",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const { jsx, jsxs, Fragment } = require("react/jsx-runtime");
		const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		const { createSnapshotStore } = require("@deepseek-ai/dsh-client-store");

		/** Host 半边注册的删除接口；路径固定，两边共用同一个常量（见 Host 的 ROUTE）。 */
		const ENDPOINT = "/session-purge";
		/** 侧边栏会话行的 DOM 契约（ui-workspace 写死的 data-row-key）。 */
		const ROW_SELECTOR = '[data-row-key^="session:"]';
		const ROW_PREFIX = "session:";
		/** 字典命名空间。 */
		const NS = "session-purge";

		const CSS = [
			".session-purge-menu{position:fixed;z-index:1400;min-width:168px;padding:4px;border-radius:var(--dsw-radius-lg,10px);background:var(--dsw-alias-button-elevated-fill,#2b2b2b);border:.5px solid var(--dsw-alias-border-l4,rgba(255,255,255,.14));box-shadow:0 10px 28px rgba(0,0,0,.3)}",
			".session-purge-menu-item{display:flex;align-items:center;gap:8px;width:100%;padding:6px 8px;border:none;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-state-error-primary,#e5484d);font-size:14px;line-height:20px;text-align:left;cursor:pointer}",
			".session-purge-menu-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}",
			".session-purge-menu-item svg{flex:none}",
			".session-purge-danger:not(:disabled){color:var(--dsw-alias-state-error-primary,#e5484d)}",
			".session-purge-status{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;margin-top:8px}",
			".session-purge-error{color:var(--dsw-alias-state-error-primary,#e5484d);font-size:12px;line-height:18px;margin-top:8px}",
		].join("");

		const zh = {
			"menu.delete": "删除会话",
			"dialog.title": "删除会话",
			"dialog.desc": "将永久删除会话「{title}」的全部记录：会话日志、投影缓存与工作区记账，且不可恢复。",
			"dialog.pending": "正在删除…",
			"dialog.action": "删除",
			"cancel": "取消",
			"error.endpoint": "删除服务不可用（Host 半边未加载，或当前不是 Web 运行方式）。",
		};
		const en = {
			"menu.delete": "Delete session",
			"dialog.title": "Delete session",
			"dialog.desc": "This permanently deletes every trace of “{title}”: the session log, its projection cache, and its workspace accounting. This cannot be undone.",
			"dialog.pending": "Deleting…",
			"dialog.action": "Delete",
			"cancel": "Cancel",
			"error.endpoint": "The delete service is unavailable (host half not loaded, or not running in Web mode).",
		};

		/** 注入一次样式，返回移除函数。 */
		function installStyles() {
			const tagId = "session-purge/style.css";
			const selector = 'style[data-plugin-css="' + tagId + '"]';
			if (typeof document === "undefined" || document.querySelector(selector) !== null) return () => {};
			const tag = document.createElement("style");
			tag.dataset.plugin = "session-purge";
			tag.dataset.pluginCss = tagId;
			tag.textContent = CSS;
			document.head.appendChild(tag);
			return () => tag.remove();
		}

		/** 调用 Host 的删除接口。 */
		async function callDelete(sessionId) {
			let response;
			try {
				response = await fetch(ENDPOINT, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ sessionId, stop: true }),
				});
			} catch (reason) {
				throw new Error(
					"无法连接删除服务：" + (reason instanceof Error ? reason.message : String(reason)),
				);
			}
			let payload = null;
			try {
				payload = await response.json();
			} catch {
				payload = null;
			}
			if (payload === null || typeof payload !== "object") {
				if (response.status === 404) throw new Error("ENDPOINT_MISSING");
				throw new Error(`删除请求失败（HTTP ${response.status}）`);
			}
			if (payload.ok !== true) {
				const error = new Error(String(payload.message ?? `删除请求失败（HTTP ${response.status}）`));
				error.code = payload.code;
				throw error;
			}
			return payload.result;
		}

		/** 右键菜单：定位到指针，点空白处或 Esc 关闭。 */
		function ContextMenuSurface({ menu, close, requestDelete, t }) {
			const ref = React.useRef(null);
			React.useEffect(() => {
				const onPointerDown = (event) => {
					if (ref.current !== null && ref.current.contains(event.target)) return;
					close();
				};
				const onKeyDown = (event) => {
					if (event.key === "Escape") close();
				};
				document.addEventListener("pointerdown", onPointerDown, true);
				document.addEventListener("keydown", onKeyDown, true);
				window.addEventListener("blur", close);
				return () => {
					document.removeEventListener("pointerdown", onPointerDown, true);
					document.removeEventListener("keydown", onKeyDown, true);
					window.removeEventListener("blur", close);
				};
			}, [close]);
			const select = () => {
				close();
				requestDelete(menu.sessionId, menu.title);
			};
			return jsx("div", {
				ref,
				className: "session-purge-menu",
				role: "menu",
				style: { left: `${menu.x}px`, top: `${menu.y}px` },
				children: jsx("button", {
					type: "button",
					role: "menuitem",
					className: "session-purge-menu-item",
					onClick: select,
					children: [
						jsx(primitives.IconTrashOutlineRegular, { size: 14 }),
						jsx("span", { children: t("menu.delete") }),
					],
				}),
			});
		}

		/** 左侧边栏「⋯」菜单里的同一条目。 */
		function DeleteSessionMenuItem(props) {
			const { sessionId, displayTitle, useMenuOpenState, requestDelete, t } = props;
			const [, setMenuOpen] = useMenuOpenState();
			return jsx(primitives.MenuItemButton, {
				icon: jsx(primitives.IconTrashOutlineRegular, { size: 14 }),
				onSelect: () => {
					setMenuOpen(false);
					requestDelete(sessionId, displayTitle);
				},
				children: t("menu.delete"),
			});
		}

		/** 二次确认 + 执行。 */
		function DeleteSessionDialog({ request, performDelete, onSettle, t }) {
			const [deleting, setDeleting] = React.useState(false);
			const [error, setError] = React.useState(null);
			const close = () => {
				if (deleting) return;
				onSettle();
			};
			const confirm = () => {
				setDeleting(true);
				setError(null);
				performDelete(request.sessionId)
					.then(() => {
						setDeleting(false);
						onSettle();
					})
					.catch((reason) => {
						setDeleting(false);
						setError(reason instanceof Error ? reason.message : String(reason));
					});
			};
			return jsxs(primitives.Modal, {
				open: true,
				onClose: close,
				closeLabel: t("cancel"),
				title: t("dialog.title"),
				description: t("dialog.desc", { title: request.title }),
				footer: jsxs(Fragment, {
					children: [
						jsx(primitives.Button, { variant: "outline", disabled: deleting, onClick: close, children: t("cancel") }),
						jsx(primitives.Button, {
							variant: "outline",
							className: "session-purge-danger",
							disabled: deleting,
							onClick: confirm,
							children: t("dialog.action"),
						}),
					],
				}),
				children: [
					deleting && jsx("div", { className: "session-purge-status", role: "status", children: t("dialog.pending") }),
					error !== null && jsx("div", { className: "session-purge-error", role: "alert", children: error }),
				],
			});
		}

		/** `shell.overlay` 的唯一入口：右键菜单 + 确认框。 */
		function SessionDeleteOverlay(props) {
			const { useContextMenu, closeContextMenu, useDeleteRequest, requestDelete, settleDelete, performDelete, t } = props;
			const menu = useContextMenu((value) => value);
			const request = useDeleteRequest((value) => value);
			return jsxs(Fragment, {
				children: [
					menu !== null && jsx(ContextMenuSurface, { menu, close: closeContextMenu, requestDelete, t }),
					request !== null && jsx(DeleteSessionDialog, { request, performDelete, onSettle: settleDelete, t }, request.sessionId),
				],
			});
		}

		const inject = ["slots", "sessions", "locale"];

		function apply(ctx) {
			ctx.effect(() => installStyles(), "session-purge: styles");
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "session-purge: dictionaries");

			const contextMenu = createSnapshotStore(null);
			const deleteRequest = createSnapshotStore(null);
			const closeContextMenu = () => contextMenu.set(null);
			const settleDelete = () => deleteRequest.set(null);

			const rowTitle = (sessionId) => {
				try {
					const summary = ctx.get("sessions")?.list?.getSnapshot()?.byId?.[sessionId];
					const title = summary?.displayTitle;
					return typeof title === "string" && title.length > 0 ? title : sessionId;
				} catch {
					return sessionId;
				}
			};

			const requestDelete = (sessionId, title) => {
				contextMenu.set(null);
				if (typeof sessionId !== "string" || sessionId.length === 0) return;
				deleteRequest.set({ sessionId, title: typeof title === "string" && title.length > 0 ? title : rowTitle(sessionId) });
			};

			const performDelete = async (sessionId) => {
				// 必须在请求之前问：删完 Host 会发 api-session/removed，客户端那一行
				// 立刻就被摘掉了，之后再去读 retainedBy 已经读不到东西。
				let wasMain = false;
				try {
					wasMain = (ctx.get("sessions")?.list?.getSnapshot()?.byId?.[sessionId]?.retainedBy?.mainView ?? 0) > 0;
				} catch {
					wasMain = false;
				}
				let result;
				try {
					result = await callDelete(sessionId);
				} catch (reason) {
					if (reason instanceof Error && reason.message === "ENDPOINT_MISSING") {
						throw new Error(ctx.locale.bind(NS)("error.endpoint"));
					}
					throw reason;
				}
				await ctx.get("sessions")?.refresh?.();
				// 删的正是主视图那个会话时，内置的 uiSession 会在会话列表变化后自己重算
				// 主会话（publishMain：当前会话不再被主视图引用就从列表里另挑一个，挑不到
				// 就回到空状态）。所以通常什么都不用做——这里只是等一等，确认那一行真的
				// 已经不在列表里；万一它没被摘掉，才退回整页刷新兜底。
				//
				// 以前是无条件 `window.location.reload()`：桌面端重载渲染器看起来就是
				// 「DSH 重启」，重载后又因为原会话没了而新开一个，用户看到的就是这个。
				if (wasMain) {
					const stillMain = () =>
						(ctx.get("sessions")?.list?.getSnapshot()?.byId?.[sessionId]?.retainedBy?.mainView ?? 0) > 0;
					const deadline = Date.now() + 600;
					while (Date.now() < deadline && stillMain()) {
						await new Promise((done) => setTimeout(done, 40));
					}
					if (stillMain()) window.location.reload();
				}
				return result;
			};

			const onContextMenu = (event) => {
				const target = event.target;
				if (target === null || typeof target !== "object" || typeof target.closest !== "function") return;
				const row = target.closest(ROW_SELECTOR);
				if (row === null) return;
				const key = row.getAttribute("data-row-key");
				if (typeof key !== "string" || !key.startsWith(ROW_PREFIX)) return;
				const sessionId = key.slice(ROW_PREFIX.length);
				if (sessionId.length === 0) return;
				event.preventDefault();
				event.stopPropagation();
				const width = 200;
				const height = 44;
				const margin = 8;
				const x = Math.max(margin, Math.min(event.clientX, window.innerWidth - width - margin));
				const y = Math.max(margin, Math.min(event.clientY, window.innerHeight - height - margin));
				contextMenu.set({ sessionId, title: rowTitle(sessionId), x, y });
			};
			document.addEventListener("contextmenu", onContextMenu, true);
			ctx.effect(() => () => document.removeEventListener("contextmenu", onContextMenu, true), "session-purge: contextmenu");

			ctx.slots.inject("shell.overlay", () =>
				ctx.slots.register(
					{
						name: "shell.overlay",
						id: "session-purge.overlay",
						order: 500,
						locale: NS,
						inject: () => ({
							hooks: { contextMenu, deleteRequest },
							closeContextMenu,
							requestDelete,
							settleDelete,
							performDelete,
						}),
					},
					SessionDeleteOverlay,
				),
			);

			ctx.slots.inject("sidebar.workspaces.session.menu.item", () =>
				ctx.slots.register(
					{
						name: "sidebar.workspaces.session.menu.item",
						id: "session-purge.row",
						order: 500,
						locale: NS,
						inject: () => ({ requestDelete }),
					},
					DeleteSessionMenuItem,
				),
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.name = "session-purge";
		return module.exports;
	},
});
