// 服务器文件管理 —— 独立扩展
// 浏览并删除酒馆服务器上的用户文件（图片、资产等），供无法直接访问文件系统的移动端使用。
// 接口契约（与小白OS 内核已验证用法一致）：
//   列表  POST /api/files/get     body: { path: '<相对 get 服务端根的路径>' }
//   删除  POST /api/files/delete  body: { path: '<相对用户数据根的路径，如 user/files/xx.png>' }
// 删除失败 HTTP 400 通常表示服务端未开启 enableServerFilesDeleting。
(() => {
    'use strict';

    if (window.__SERVER_FILE_MANAGER_LOADED__) { return; }
    window.__SERVER_FILE_MANAGER_LOADED__ = true;

    const PANEL_ID = 'sfm-overlay';

    // ---------- 基础工具 ----------

    function getRequestHeaders() {
        const fromContext = window.SillyTavern?.getContext?.()?.getRequestHeaders;
        if (typeof fromContext === 'function') {
            try {
                return fromContext();
            } catch { /* 继续走 fallback */ }
        }
        const token = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') ?? '';
        return { 'X-CSRF-Token': token };
    }

    async function readErrorDetail(response) {
        // 先读原始文本再尝试解析，避免非 JSON 错误页被吞掉只剩「未知错误」
        try {
            const text = await response.text();
            if (!text) { return ''; }
            try {
                const parsed = JSON.parse(text);
                return typeof parsed?.error === 'string' ? parsed.error : String(text).slice(0, 200);
            } catch {
                return String(text).slice(0, 200);
            }
        } catch {
            return '';
        }
    }

    async function postJson(endpoint, body) {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!response.ok) {
            const detail = await readErrorDetail(response);
            throw new Error(`HTTP ${response.status}${detail ? '：' + detail : ''}`);
        }
        const contentType = response.headers.get('content-type') ?? '';
        if (!contentType.includes('json')) { return {}; }
        return await response.json();
    }

    function parseListResponse(data) {
        if (Array.isArray(data?.items)) { return data.items; }
        if (Array.isArray(data?.folders) || Array.isArray(data?.files)) {
            return [
                ...(data.folders ?? []).map(item => ({ ...item, type: 'folder' })),
                ...(data.files ?? []).map(item => ({ ...item, type: 'file' })),
            ];
        }
        return [];
    }

    function joinPath(root, relPath) {
        const parts = [];
        for (const segment of [root, relPath]) {
            if (!segment) { continue; }
            for (const piece of String(segment).split('/')) {
                if (piece && piece !== '.') { parts.push(piece); }
            }
        }
        return parts.join('/');
    }

    function parentPath(relPath) {
        const parts = String(relPath).split('/').filter(Boolean);
        parts.pop();
        return parts.join('/');
    }

    function formatSize(bytes) {
        const value = Number(bytes);
        if (!Number.isFinite(value) || value < 0) { return ''; }
        if (value < 1024) { return `${value} B`; }
        if (value < 1024 * 1024) { return `${(value / 1024).toFixed(1)} KB`; }
        return `${(value / (1024 * 1024)).toFixed(1)} MB`;
    }

    // ---------- 面板状态 ----------

    const state = {
        root: 'user/files',     // 浏览区基准目录（列表相对路径基于它）
        rel: '',                // 当前浏览的相对路径（基于 root）
        entries: [],
        selected: new Set(),    // 存 deletePath 全路径
        confirmArmed: false,
        confirmTimer: 0,
        loading: false,
    };

    // ---------- DOM 构建 ----------

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) { node.className = className; }
        if (text !== undefined) { node.textContent = text; }
        return node;
    }

    function injectStyles() {
        const style = document.createElement('style');
        style.id = 'sfm-styles';
        style.textContent = `
#sfm-menu-button .avatar { font-size: 22px; display: flex; align-items: center; justify-content: center; }
#sfm-menu-button .name { font-size: 12px; }
#sfm-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; z-index: 99999;
    background: rgba(0, 0, 0, 0.55); display: none; align-items: center; justify-content: center; padding: 16px; }
#sfm-overlay.sfm-open { display: flex; }
#sfm-panel { background: #1f2430; color: #e8eaf0; border-radius: 10px; width: 100%; max-width: 640px;
    max-height: 100%; display: flex; flex-direction: column; overflow: hidden;
    border: 1px solid #3a4150; font-size: 14px; }
.sfm-header { display: flex; align-items: center; gap: 8px; padding: 12px 14px; border-bottom: 1px solid #3a4150; }
.sfm-header .sfm-title { font-weight: 600; flex: 1; }
.sfm-header button { background: #2a3040; color: #e8eaf0; border: 1px solid #3a4150; border-radius: 6px;
    padding: 5px 10px; cursor: pointer; font-size: 13px; }
.sfm-header button:active { background: #36405a; }
.sfm-toolbar { padding: 8px 14px; border-bottom: 1px solid #3a4150; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.sfm-toolbar input { background: #151922; color: #e8eaf0; border: 1px solid #3a4150; border-radius: 6px;
    padding: 5px 8px; font-size: 13px; flex: 1; min-width: 140px; }
.sfm-toolbar button { background: #2a3040; color: #e8eaf0; border: 1px solid #3a4150; border-radius: 6px;
    padding: 5px 10px; cursor: pointer; font-size: 13px; white-space: nowrap; }
.sfm-crumbs { padding: 8px 14px; font-size: 13px; color: #9aa3b5; display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
.sfm-crumbs span { cursor: pointer; }
.sfm-crumbs span:hover { color: #e8eaf0; text-decoration: underline; }
.sfm-list { flex: 1; overflow-y: auto; min-height: 120px; }
.sfm-row { display: flex; align-items: center; gap: 8px; padding: 8px 14px; border-bottom: 1px solid #262c3a; }
.sfm-row input[type="checkbox"] { width: 16px; height: 16px; flex-shrink: 0; }
.sfm-row .sfm-name { flex: 1; word-break: break-all; cursor: default; }
.sfm-row.sfm-folder .sfm-name { cursor: pointer; color: #8ab4ff; }
.sfm-row .sfm-size { color: #9aa3b5; font-size: 12px; white-space: nowrap; }
.sfm-empty { padding: 24px 14px; text-align: center; color: #9aa3b5; }
.sfm-footer { padding: 10px 14px; border-top: 1px solid #3a4150; display: flex; align-items: center; gap: 10px; }
.sfm-footer .sfm-count { flex: 1; font-size: 13px; color: #9aa3b5; }
.sfm-footer label { display: flex; align-items: center; gap: 5px; font-size: 13px; cursor: pointer; }
#sfm-delete-btn { background: #2a3040; color: #e8eaf0; border: 1px solid #3a4150; border-radius: 6px;
    padding: 6px 12px; cursor: pointer; font-size: 13px; }
#sfm-delete-btn.sfm-armed { background: #a03030; border-color: #c04848; font-weight: 600; }
#sfm-delete-btn:disabled { opacity: 0.5; cursor: not-allowed; }
#sfm-toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); z-index: 100000;
    background: rgba(20, 24, 32, 0.92); color: #e8eaf0; border: 1px solid #3a4150; border-radius: 8px;
    padding: 8px 14px; font-size: 13px; max-width: 80vw; opacity: 0; pointer-events: none;
    transition: opacity 0.2s ease; }
#sfm-toast.sfm-show { opacity: 1; }
`;
        document.head.appendChild(style);
    }

    function showToast(message) {
        let toast = document.getElementById('sfm-toast');
        if (!toast) {
            toast = el('div');
            toast.id = 'sfm-toast';
            document.body.appendChild(toast);
        }
        toast.textContent = message;
        toast.classList.add('sfm-show');
        window.clearTimeout(showToast._timer);
        showToast._timer = window.setTimeout(() => toast.classList.remove('sfm-show'), 2600);
    }

    let refs = null;

    function buildPanel() {
        const overlay = el('div');
        overlay.id = PANEL_ID;

        const panel = el('div');
        panel.id = 'sfm-panel';

        // 头部
        const header = el('div', 'sfm-header');
        const title = el('div', 'sfm-title', '服务器文件管理');
        const refreshBtn = el('button', undefined, '刷新');
        refreshBtn.addEventListener('click', () => loadDirectory());
        const closeBtn = el('button', undefined, '关闭');
        closeBtn.addEventListener('click', () => overlay.classList.remove('sfm-open'));
        header.append(title, refreshBtn, closeBtn);

        // 工具栏：根目录 + 快捷切换
        const toolbar = el('div', 'sfm-toolbar');
        const rootInput = el('input');
        rootInput.type = 'text';
        rootInput.placeholder = '浏览根目录，如 user/files';
        rootInput.value = state.root;
        const goBtn = el('button', undefined, '跳转');
        const quickImages = el('button', undefined, '图片目录');
        const quickFiles = el('button', undefined, '文件目录');
        toolbar.append(rootInput, goBtn, quickImages, quickFiles);

        // 面包屑
        const crumbs = el('div', 'sfm-crumbs');

        // 列表
        const list = el('div', 'sfm-list');

        // 底部：全选 + 计数 + 删除
        const footer = el('div', 'sfm-footer');
        const selectAllLabel = el('label');
        const selectAll = el('input');
        selectAll.type = 'checkbox';
        selectAllLabel.append(selectAll, el('span', undefined, '全选'));
        const countLabel = el('div', 'sfm-count', '未选择');
        const deleteBtn = el('button', undefined, '删除选中');
        deleteBtn.id = 'sfm-delete-btn';
        footer.append(selectAllLabel, countLabel, deleteBtn);

        panel.append(header, toolbar, crumbs, list, footer);
        overlay.appendChild(panel);
        document.body.appendChild(overlay);

        refs = { overlay, rootInput, crumbs, list, selectAll, countLabel, deleteBtn };

        // 事件
        goBtn.addEventListener('click', () => {
            const next = rootInput.value.trim().replace(/^\/+|\/+$/g, '');
            state.root = next;
            state.rel = '';
            loadDirectory();
        });
        quickImages.addEventListener('click', () => switchRoot('user/images'));
        quickFiles.addEventListener('click', () => switchRoot('user/files'));
        selectAll.addEventListener('change', () => {
            if (selectAll.checked) {
                for (const entry of state.entries) {
                    if (entry.type === 'file') { state.selected.add(entry.fullPath); }
                }
            } else {
                state.selected.clear();
            }
            renderList();
        });
        deleteBtn.addEventListener('click', () => onDeleteClick());
    }

    function switchRoot(root) {
        state.root = root;
        state.rel = '';
        refs.rootInput.value = root;
        loadDirectory();
    }

    // ---------- 数据加载与渲染 ----------

    async function loadDirectory() {
        if (state.loading) { return; }
        state.loading = true;
        state.confirmArmed = false;
        refs.deleteBtn.classList.remove('sfm-armed');
        refs.deleteBtn.textContent = '删除选中';
        refs.list.textContent = '';
        refs.list.appendChild(el('div', 'sfm-empty', '加载中…'));
        try {
            const data = await postJson('/api/files/get', { path: state.rel });
            state.entries = parseListResponse(data)
                .map(entry => ({
                    name: String(entry.name ?? ''),
                    type: entry.type === 'folder' || entry.isDirectory ? 'folder' : 'file',
                    size: entry.size,
                    fullPath: joinPath(state.root, state.rel ? state.rel + '/' + String(entry.name ?? '') : String(entry.name ?? '')),
                }))
                .filter(entry => entry.name && entry.name !== '.')
                .sort((a, b) => a.type === b.type
                    ? a.name.localeCompare(b.name, 'zh-Hans-CN')
                    : (a.type === 'folder' ? -1 : 1));
        } catch (error) {
            state.entries = [];
            showToast(`读取目录失败：${error.message}`);
        } finally {
            state.loading = false;
            renderList();
        }
    }

    function renderCrumbs() {
        const crumbs = refs.crumbs;
        crumbs.textContent = '';
        const rootLabel = el('span', undefined, `[${state.root || '服务端根'}]`);
        rootLabel.addEventListener('click', () => { state.rel = ''; renderList(); });
        crumbs.appendChild(rootLabel);
        const parts = String(state.rel).split('/').filter(Boolean);
        parts.forEach((part, index) => {
            crumbs.appendChild(el('span', undefined, '/'));
            const segment = el('span', undefined, part);
            segment.addEventListener('click', () => {
                state.rel = parts.slice(0, index + 1).join('/');
                renderList();
            });
            crumbs.appendChild(segment);
        });
    }

    function renderList() {
        renderCrumbs();
        const list = refs.list;
        list.textContent = '';
        refs.selectAll.checked = state.entries.some(entry => entry.type === 'file')
            && state.entries.every(entry => entry.type !== 'file' || state.selected.has(entry.fullPath));

        if (state.rel) {
            const upRow = el('div', 'sfm-row sfm-folder');
            const upName = el('div', 'sfm-name', '.. 返回上一级');
            upName.addEventListener('click', () => {
                state.rel = parentPath(state.rel);
                renderList();
            });
            upRow.appendChild(upName);
            list.appendChild(upRow);
        }

        if (!state.entries.length) {
            list.appendChild(el('div', 'sfm-empty', state.loading ? '加载中…' : '目录为空，或当前根目录不可读'));
        }

        for (const entry of state.entries) {
            const row = el('div', `sfm-row${entry.type === 'folder' ? ' sfm-folder' : ''}`);
            const checkbox = el('input');
            checkbox.type = 'checkbox';
            checkbox.checked = state.selected.has(entry.fullPath);
            checkbox.addEventListener('change', () => {
                if (checkbox.checked) {
                    state.selected.add(entry.fullPath);
                } else {
                    state.selected.delete(entry.fullPath);
                    refs.selectAll.checked = false;
                }
                updateCount();
            });
            const icon = el('div', undefined, entry.type === 'folder' ? '📁' : guessFileIcon(entry.name));
            const name = el('div', 'sfm-name', entry.name);
            if (entry.type === 'folder') {
                name.addEventListener('click', () => {
                    state.rel = state.rel ? `${state.rel}/${entry.name}` : entry.name;
                    renderList();
                });
            }
            row.append(checkbox, icon, name);
            if (entry.type === 'file') {
                row.appendChild(el('div', 'sfm-size', formatSize(entry.size)));
            }
            list.appendChild(row);
        }
        updateCount();
    }

    function guessFileIcon(name) {
        const lower = name.toLowerCase();
        if (/\.(png|jpe?g|gif|webp|avif)$/.test(lower)) { return '🖼️'; }
        if (/\.(mp3|wav|ogg|m4a|flac)$/.test(lower)) { return '🎵'; }
        if (/\.(mp4|webm|mov)$/.test(lower)) { return '🎬'; }
        if (/\.(json|txt|md|yaml|yml|js|ts|css|html)$/.test(lower)) { return '📄'; }
        return '📄';
    }

    function updateCount() {
        const n = state.selected.size;
        refs.countLabel.textContent = n ? `已选择 ${n} 项` : '未选择';
        refs.deleteBtn.disabled = n === 0;
    }

    // ---------- 删除（两步确认，删除后不关面板、原地刷新） ----------

    function disarmConfirm() {
        state.confirmArmed = false;
        refs.deleteBtn.classList.remove('sfm-armed');
        refs.deleteBtn.textContent = '删除选中';
        window.clearTimeout(state.confirmTimer);
    }

    async function onDeleteClick() {
        if (!state.selected.size) { return; }
        if (!state.confirmArmed) {
            state.confirmArmed = true;
            refs.deleteBtn.classList.add('sfm-armed');
            refs.deleteBtn.textContent = `确认删除 ${state.selected.size} 项`;
            state.confirmTimer = window.setTimeout(disarmConfirm, 5000);
            return;
        }
        disarmConfirm();
        const targets = [...state.selected];
        refs.deleteBtn.disabled = true;
        let deleted = 0;
        const failures = [];
        for (const target of targets) {
            try {
                await postJson('/api/files/delete', { path: target, recursive: true });
                deleted += 1;
                state.selected.delete(target);
            } catch (error) {
                failures.push(`${target}：${error.message}`);
                if (/\b400\b/.test(error.message)) {
                    failures.push('（HTTP 400 通常表示服务端未开启 enableServerFilesDeleting）');
                    break;
                }
            }
        }
        refs.deleteBtn.disabled = false;
        if (failures.length) {
            showToast(failures[0]);
        } else {
            showToast(`已删除 ${deleted} 项`);
        }
        await loadDirectory();
    }

    // ---------- 入口 ----------

    function addMenuButton() {
        const menu = document.getElementById('extensionsMenu');
        if (!menu) {
            console.warn('[服务器文件管理] 未找到 extensionsMenu，扩展未挂载');
            return;
        }
        const button = el('div', 'list-item');
        button.id = 'sfm-menu-button';
        button.title = '浏览并删除服务器上的用户文件';
        const avatar = el('div', 'avatar');
        const icon = document.createElement('i');
        icon.className = 'fa-solid fa-folder-tree';
        avatar.appendChild(icon);
        const name = el('div', 'name', '文件管理');
        button.append(avatar, name);
        button.addEventListener('click', () => {
            refs.overlay.classList.add('sfm-open');
            if (!state.entries.length) { loadDirectory(); }
        });
        menu.appendChild(button);
    }

    injectStyles();
    buildPanel();
    addMenuButton();
})();
