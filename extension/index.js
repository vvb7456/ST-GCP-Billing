const API = '/api/plugins/agent-platform-billing';
const MODULE = 'agent_platform_billing';
const VERSION = '1.2.0';
const REPO_URL = 'https://github.com/vvb7456/ST-GCP-Billing';

const TABS = [
    { id: 'overview', label: '概览', icon: 'fa-solid fa-chart-pie' },
    { id: 'records', label: '明细', icon: 'fa-solid fa-list-ul' },
    { id: 'pricing', label: '定价', icon: 'fa-solid fa-tags' },
    { id: 'settings', label: '设置', icon: 'fa-solid fa-gear' },
];

const PERIODS = [
    { id: 'today', label: '今日' },
    { id: 'week', label: '近 7 天' },
    { id: 'month', label: '本月' },
    { id: 'all', label: '全部' },
];

const state = {
    tab: 'overview',
    period: 'today',
    summary: null,
    settings: null,
    recordLimit: 30,
    lastSeenTs: null,
    connected: null,
};

const ctx = () => SillyTavern.getContext();
const $root = () => $('#vb_root');

function prefs() {
    const s = ctx().extensionSettings;
    s[MODULE] ??= {};
    s[MODULE].toast ??= true;
    s[MODULE].rate ??= 0;
    s[MODULE].currency ??= 'CNY';
    return s[MODULE];
}

function savePrefs() {
    ctx().saveSettingsDebounced();
}

async function api(endpoint, body = {}) {
    const res = await fetch(API + endpoint, {
        method: 'POST',
        headers: ctx().getRequestHeaders(),
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${endpoint}: HTTP ${res.status} ${await res.text()}`);
    return res.json();
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = n => Number(n || 0).toLocaleString();

function compact(n) {
    n = Number(n || 0);
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 1 : 2).replace(/\.?0+$/, '') + 'M';
    if (n >= 1e4) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
    return n.toLocaleString();
}

function usd(v) {
    v = Number(v || 0);
    if (v === 0) return '$0.00';
    if (Math.abs(v) >= 1) return '$' + v.toFixed(2);
    if (Math.abs(v) >= 0.01) return '$' + v.toFixed(4);
    return '$' + v.toPrecision(3);
}

function converted(v) {
    const p = prefs();
    if (!(p.rate > 0)) return '';
    const x = Number(v || 0) * p.rate;
    return `≈ ${x >= 1 ? x.toFixed(2) : x.toFixed(4)} ${esc(p.currency)}`;
}

function money(v) {
    const c = converted(v);
    return c ? `${usd(v)} <span class="vb-dim">${c}</span>` : usd(v);
}

function timeLabel(ts) {
    const d = new Date(ts);
    const diff = Date.now() - ts;
    if (diff < 60_000) return '刚刚';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
    const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const today = new Date();
    if (d.toDateString() === today.toDateString()) return `今天 ${hm}`;
    const y = new Date(today);
    y.setDate(today.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return `昨天 ${hm}`;
    return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

function periodSince(id) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    if (id === 'today') return d.getTime();
    if (id === 'week') return d.getTime() - 6 * 86_400_000;
    if (id === 'month') { d.setDate(1); return d.getTime(); }
    return 0;
}

function billableInput(b) {
    return Math.max(0, (b.promptTokens || 0) - (b.cachedTokens || 0)) + (b.toolUseTokens || 0);
}

/* ---------- shell ---------- */

function shellHtml() {
    return `
<div class="inline-drawer vb-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
        <b>Agent Platform 费用统计</b>
        <span id="vb_header_today" class="vb-header-today"></span>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">
        <div id="vb_root" class="vb-settings">
            <div class="vb-tab-bar">
                ${TABS.map(t => `<div class="vb-tab" data-tab="${t.id}"><i class="${t.icon}"></i><span>${t.label}</span></div>`).join('')}
            </div>
            ${TABS.map(t => `<div class="vb-tab-panel" data-panel="${t.id}"></div>`).join('')}
        </div>
    </div>
</div>`;
}

function switchTab(id) {
    state.tab = id;
    $root().find('.vb-tab').each(function () { $(this).toggleClass('active', this.dataset.tab === id); });
    $root().find('.vb-tab-panel').each(function () { $(this).toggle(this.dataset.panel === id); });
    renderTab(id);
}

function renderTab(id) {
    if (id === 'overview') renderOverview();
    if (id === 'records') renderRecords();
    if (id === 'pricing') renderPricing();
    if (id === 'settings') renderSettings();
}

function disconnectedHtml() {
    return `<div class="vb-empty">
        <i class="fa-solid fa-plug-circle-xmark vb-empty-icon vb-danger"></i>
        <div class="vb-empty-title">未连接到服务端插件</div>
        <div class="vb-empty-desc">前端扩展需要配合服务端插件使用。请在酒馆目录下执行<br><code>node plugins.js install ${REPO_URL}</code><br>并在 <code>config.yaml</code> 中设置 <code>enableServerPlugins: true</code> 后重启酒馆。<br><a href="${REPO_URL}#安装" target="_blank" rel="noopener">查看安装说明</a></div>
        <div class="menu_button menu_button_icon vb-btn" data-action="retry"><i class="fa-solid fa-rotate"></i><span>重试</span></div>
    </div>`;
}

/* ---------- overview ---------- */

function warningsHtml(b, unpricedModels) {
    const items = [];
    if (unpricedModels?.length) {
        items.push(`<div class="vb-alert vb-alert-warn" data-action="goto-pricing">
            <i class="fa-solid fa-tag"></i><span>${unpricedModels.length} 个模型还没有价格，花费未计入：${unpricedModels.map(esc).join('、')}</span><b>去定价 ›</b>
        </div>`);
    }
    if (b.incomplete) {
        items.push(`<div class="vb-alert"><i class="fa-solid fa-circle-pause"></i><span>${b.incomplete} 次流式请求被中途停止，谷歌未返回完整用量，这部分可能少计</span></div>`);
    }
    if (b.grounded) {
        items.push(`<div class="vb-alert"><i class="fa-solid fa-globe"></i><span>${b.grounded} 次请求使用了联网搜索，搜索费由谷歌另行收取，未计入</span></div>`);
    }
    return items.join('');
}

function recordItemHtml(r) {
    const u = r.usage || {};
    const badges = [];
    if (!r.complete) badges.push('<span class="vb-badge vb-badge-warn" title="流式请求中途停止，用量可能不完整">中断</span>');
    if (!r.usage) badges.push('<span class="vb-badge vb-badge-warn">无用量</span>');
    if (r.stream) badges.push('<span class="vb-badge">流式</span>');
    if (r.cost?.tier === 'long') badges.push('<span class="vb-badge" title="提示词超过长上下文阈值，按高价档计费">长上下文</span>');
    if (r.cost?.regional) badges.push(`<span class="vb-badge" title="区域端点，按区域价计费">${esc(r.location)}</span>`);
    if (r.grounded) badges.push('<span class="vb-badge" title="使用了联网搜索">联网</span>');
    if (r.trafficType && r.trafficType !== 'ON_DEMAND') badges.push(`<span class="vb-badge">${esc(r.trafficType)}</span>`);
    const input = Math.max(0, (u.promptTokenCount || 0) - (u.cachedContentTokenCount || 0)) + (u.toolUsePromptTokenCount || 0);
    const costTitle = r.cost
        ? `输入 ${usd(r.cost.input)} · 缓存 ${usd(r.cost.cached)} · 输出 ${usd(r.cost.output)} · 思考 ${usd(r.cost.thoughts)}`
        : '该模型尚未定价';
    return `<div class="vb-record">
        <div class="vb-record-main">
            <div class="vb-record-title">
                <span class="vb-model" title="${esc(r.modelVersion || r.model)}">${esc(r.model)}</span>
                ${badges.join('')}
            </div>
            <div class="vb-record-cost" title="${esc(costTitle)}">${r.cost ? usd(r.cost.total) : '<span class="vb-warn-text">未定价</span>'}</div>
        </div>
        <div class="vb-record-sub">
            <span title="${esc(new Date(r.ts).toLocaleString())}">${timeLabel(r.ts)}</span>
            <span class="vb-tokens">
                <span title="未命中缓存的输入"><i class="fa-solid fa-arrow-right-to-bracket"></i>${fmt(input)}</span>
                ${u.cachedContentTokenCount ? `<span title="缓存命中"><i class="fa-solid fa-bolt"></i>${fmt(u.cachedContentTokenCount)}</span>` : ''}
                <span title="输出"><i class="fa-solid fa-arrow-right-from-bracket"></i>${fmt(u.candidatesTokenCount)}</span>
                ${u.thoughtsTokenCount ? `<span title="思考"><i class="fa-solid fa-brain"></i>${fmt(u.thoughtsTokenCount)}</span>` : ''}
            </span>
        </div>
    </div>`;
}

function renderOverview() {
    const $p = $root().find('[data-panel="overview"]');
    if (state.connected === false) return $p.html(disconnectedHtml());
    const s = state.summary;
    if (!s) return $p.html('<div class="vb-empty"><i class="fa-solid fa-spinner fa-spin"></i></div>');

    const b = s.period;
    const models = Object.entries(s.byModel).sort((a, c) => c[1].cost - a[1].cost || c[1].requests - a[1].requests);
    const maxCost = Math.max(...models.map(([, m]) => m.cost), 0);
    const last = s.latest?.at(-1);
    const unpricedInPeriod = s.unpricedModels.filter(m => s.byModel[m]?.unpriced);

    $p.html(`
        <div class="vb-chips vb-chips-full">
            ${PERIODS.map(p => `<div class="vb-chip ${state.period === p.id ? 'active' : ''}" data-period="${p.id}">${p.label}</div>`).join('')}
        </div>

        <div class="vb-hero">
            <div class="vb-hero-label">花费</div>
            <div class="vb-hero-cost">${usd(b.cost)}</div>
            ${converted(b.cost) ? `<div class="vb-hero-converted">${converted(b.cost)}</div>` : ''}
            <div class="vb-hero-sub">${fmt(b.requests)} 次请求 · 共 ${compact(b.totalTokens)} Token</div>
            <div class="vb-stats">
                <div class="vb-stat" title="未命中缓存的输入 Token（含工具调用上下文）"><div class="vb-stat-label">输入</div><div class="vb-stat-value">${compact(billableInput(b))}</div></div>
                <div class="vb-stat" title="命中缓存、按缓存价计费的输入 Token"><div class="vb-stat-label">缓存命中</div><div class="vb-stat-value">${compact(b.cachedTokens)}</div></div>
                <div class="vb-stat" title="模型正文输出 Token"><div class="vb-stat-label">输出</div><div class="vb-stat-value">${compact(b.outputTokens)}</div></div>
                <div class="vb-stat" title="思考 Token，按输出价计费"><div class="vb-stat-label">思考</div><div class="vb-stat-value">${compact(b.thoughtsTokens)}</div></div>
            </div>
        </div>

        ${warningsHtml(b, unpricedInPeriod)}

        ${last ? `<div class="vb-section-title">最近一次请求</div>${recordItemHtml(last)}` : ''}

        <div class="vb-section-title">按模型</div>
        ${models.length ? models.map(([name, m]) => `
            <div class="vb-model-row">
                <div class="vb-model-row-main">
                    <div class="vb-row-info">
                        <div class="vb-row-title">${esc(name)}</div>
                        <div class="vb-row-desc">${fmt(m.requests)} 次 · 输入 ${compact(billableInput(m))} · 缓存 ${compact(m.cachedTokens)} · 输出 ${compact(m.outputTokens + m.thoughtsTokens)}</div>
                    </div>
                    <div class="vb-model-cost">${m.unpriced === m.requests ? '<span class="vb-warn-text">未定价</span>' : money(m.cost)}</div>
                </div>
                <div class="vb-bar"><div style="width:${maxCost > 0 ? (m.cost / maxCost) * 100 : 0}%"></div></div>
            </div>`).join('') : '<div class="vb-placeholder">这段时间还没有 Agent Platform 请求</div>'}
    `);
}

/* ---------- records ---------- */

async function renderRecords() {
    const $p = $root().find('[data-panel="records"]');
    if (state.connected === false) return $p.html(disconnectedHtml());
    let data;
    try {
        data = await api('/records', { limit: state.recordLimit });
    } catch {
        return $p.html(disconnectedHtml());
    }
    if (!data.items.length) {
        return $p.html('<div class="vb-empty"><i class="fa-solid fa-receipt vb-empty-icon"></i><div class="vb-empty-title">暂无记录</div><div class="vb-empty-desc">使用 Agent Platform 发送消息后，每次请求的用量和花费会显示在这里。</div></div>');
    }
    $p.html(`
        <div class="vb-row-desc vb-records-head">共 ${fmt(data.total)} 条，显示最近 ${fmt(data.items.length)} 条 · 悬停金额可查看分项</div>
        <div class="vb-record-list">${data.items.map(recordItemHtml).join('')}</div>
        ${data.total > data.items.length ? '<div class="menu_button menu_button_icon vb-btn vb-btn-block" data-action="more"><i class="fa-solid fa-chevron-down"></i><span>加载更多</span></div>' : ''}
    `);
}

/* ---------- pricing ---------- */

function priceSummary(p) {
    const parts = [`输入 $${p.input ?? '—'}`, `输出 $${p.output ?? '—'}`];
    if (p.cachedInput != null) parts.push(`缓存 $${p.cachedInput}`);
    const tags = [];
    if (p.nonGlobal) tags.push('<span class="vb-badge" title="使用非 global 区域端点时按区域价计费">区域价</span>');
    if (p.longContextThreshold) tags.push(`<span class="vb-badge" title="提示词超过 ${fmt(p.longContextThreshold)} Token 时按高价档计费">长上下文</span>`);
    return `${parts.join(' · ')} ${tags.join('')}`;
}

function renderPricing() {
    const $p = $root().find('[data-panel="pricing"]');
    if (state.connected === false) return $p.html(disconnectedHtml());
    if (!state.settings) return $p.html('<div class="vb-empty"><i class="fa-solid fa-spinner fa-spin"></i></div>');
    const pricing = state.settings.pricing || {};
    const unpriced = state.summary?.unpricedModels || [];

    $p.html(`
        <div class="vb-row-desc vb-pricing-head">单位：美元 / 每百万 Token，均为官方标准价，限时优惠不计入。模型名按前缀匹配，例如 <code>gemini-3.1-pro</code> 也会匹配 <code>gemini-3.1-pro-preview</code>，多个都能匹配时取最长的那个。默认价格取自 Google Cloud 官方价格页（2026-11-02），官方调价时请自行修改。</div>
        ${unpriced.map(m => `<div class="vb-alert vb-alert-warn" data-action="add-price" data-model="${esc(m)}">
            <i class="fa-solid fa-tag"></i><span><b>${esc(m)}</b> 还没有价格</span><b>添加 ›</b>
        </div>`).join('')}
        <div class="vb-price-list">
            ${Object.entries(pricing).map(([key, p]) => `
                <div class="vb-row vb-price-row" data-action="edit-price" data-key="${esc(key)}">
                    <div class="vb-row-info">
                        <div class="vb-row-title">${esc(key)}</div>
                        <div class="vb-row-desc">${priceSummary(p)}</div>
                    </div>
                    <div class="vb-row-actions">
                        <div class="menu_button menu_button_icon vb-icon-btn" title="编辑"><i class="fa-solid fa-pen"></i></div>
                        <div class="menu_button menu_button_icon vb-icon-btn vb-danger-hover" data-action="delete-price" data-key="${esc(key)}" title="删除"><i class="fa-solid fa-trash-can"></i></div>
                    </div>
                </div>`).join('') || '<div class="vb-placeholder">还没有任何定价</div>'}
        </div>
        <div class="vb-btn-row">
            <div class="menu_button menu_button_icon vb-btn" data-action="add-price"><i class="fa-solid fa-plus"></i><span>添加模型</span></div>
            <div class="menu_button menu_button_icon vb-btn" data-action="restore-defaults"><i class="fa-solid fa-clock-rotate-left"></i><span>恢复默认价格</span></div>
        </div>
    `);
}

function priceField(name, label, value, hint = '') {
    const attrs = 'type="number" step="any" min="0"';
    return `<label class="vb-field">
        <span class="vb-field-label">${label}${hint ? ` <i class="fa-solid fa-circle-info vb-help" title="${esc(hint)}"></i>` : ''}</span>
        <input class="text_pole" ${attrs} name="${name}" value="${esc(value ?? '')}" placeholder="—">
    </label>`;
}

function toggleSection(name, label, hint, on, body) {
    return `<label class="vb-editor-section vb-editor-toggle">
            <input type="checkbox" name="${name}" ${on ? 'checked' : ''}>
            <span>${label}</span>
            <i class="fa-solid fa-circle-info vb-help" title="${esc(hint)}"></i>
        </label>
        <div class="vb-toggle-body" data-for="${name}" ${on ? '' : 'style="display:none"'}>${body}</div>`;
}

const getPath = (o, path) => path.split('.').reduce((x, k) => x?.[k], o);

function setPath(o, path, v) {
    const keys = path.split('.');
    let x = o;
    for (const k of keys.slice(0, -1)) x = (x[k] ??= {});
    if (v === undefined) delete x[keys.at(-1)];
    else x[keys.at(-1)] = v;
}

async function openPriceEditor(key = '', presetModel = '') {
    const { Popup, POPUP_TYPE, POPUP_RESULT } = ctx();
    const pricing = state.settings.pricing;
    const p = key ? pricing[key] : {};
    const f = (path, label, hint) => priceField(path, label, getPath(p, path), hint);

    const $form = $(`
        <div class="vb-editor">
            <h3>${key ? '编辑定价' : '添加模型定价'}</h3>
            <label class="vb-field">
                <span class="vb-field-label">模型名（前缀）</span>
                <input class="text_pole" name="key" value="${esc(key || presetModel)}" placeholder="例如 gemini-3.8-flash">
            </label>
            <div class="vb-editor-section">基础价格 <span class="vb-dim">（美元 / 每百万 Token，global 端点）</span></div>
            <div class="vb-grid">
                ${f('input', '输入 *')}
                ${f('output', '输出 *', '思考 Token 也按这个价格计算')}
                ${f('cachedInput', '缓存命中', '留空则按普通输入价计算')}
                ${f('inputAudio', '音频输入', '留空按普通输入价')}
                ${f('cachedInputAudio', '音频缓存命中', '留空按缓存命中价')}
                ${f('outputImage', '图片输出', '留空按普通输出价')}
            </div>
            ${toggleSection('hasRegional', '区域端点单独定价', '酒馆里区域选的不是 global 时（如 us-central1），按这里的价格计费；Gemini 3 及以后的正式版模型区域价通常比 global 高 10%', !!p.nonGlobal, `
                <div class="vb-grid">
                    ${f('nonGlobal.input', '输入')}
                    ${f('nonGlobal.output', '输出')}
                    ${f('nonGlobal.cachedInput', '缓存命中')}
                </div>`)}
            ${toggleSection('hasLong', '长上下文加价', '提示词 Token 超过阈值时，这次请求的输入、输出、缓存都改按下面的价格计算（如 Pro 系列超过 20 万 Token）', !!p.longContextThreshold, `
                <div class="vb-grid">
                    ${priceField('longContextThreshold', '阈值（Token）', p.longContextThreshold ?? 200000)}
                    ${f('long.input', '输入')}
                    ${f('long.output', '输出')}
                    ${f('long.cachedInput', '缓存命中')}
                </div>`)}
            <div class="vb-editor-error vb-danger"></div>
        </div>`);
    $form.find('.vb-editor-toggle input').on('change', function () {
        $form.find(`.vb-toggle-body[data-for="${this.name}"]`).toggle(this.checked);
    });

    let result = null;
    const popup = new Popup($form, POPUP_TYPE.CONFIRM, '', {
        okButton: '保存',
        cancelButton: '取消',
        allowVerticalScrolling: true,
        onClosing: (pp) => {
            if (pp.result !== POPUP_RESULT.AFFIRMATIVE) return true;
            const raw = n => String($form.find(`[name="${n}"]`).val() ?? '').trim();
            const val = n => (raw(n) === '' ? undefined : Number(raw(n)));
            const on = n => $form.find(`[name="${n}"]`).is(':checked');
            const err = (m) => { $form.find('.vb-editor-error').text(m); return false; };

            const newKey = raw('key');
            if (!newKey) return err('请填写模型名');
            if (newKey !== key && pricing[newKey]) return err('这个模型名已经存在');
            if (val('input') === undefined || val('output') === undefined) return err('基础价格的输入和输出必填');

            // Start from a copy so fields this form doesn't expose (e.g. regional audio rates) survive editing.
            const out = structuredClone(p);
            const apply = (paths) => paths.forEach(path => setPath(out, path, val(path)));
            apply(['input', 'output', 'cachedInput', 'inputAudio', 'cachedInputAudio', 'outputImage']);

            if (on('hasRegional')) {
                if (val('nonGlobal.input') === undefined || val('nonGlobal.output') === undefined) return err('区域价的输入和输出必填');
                apply(['nonGlobal.input', 'nonGlobal.output', 'nonGlobal.cachedInput']);
            } else delete out.nonGlobal;

            if (on('hasLong')) {
                if (!(val('longContextThreshold') > 0)) return err('请填写长上下文阈值');
                apply(['longContextThreshold', 'long.input', 'long.output', 'long.cachedInput']);
            } else { delete out.longContextThreshold; delete out.long; }

            result = { newKey, price: out };
            return true;
        },
    });
    await popup.show();
    if (!result) return;

    const next = {};
    for (const [k, v] of Object.entries(pricing)) {
        if (k === key) next[result.newKey] = result.price;
        else next[k] = v;
    }
    if (!key) next[result.newKey] = result.price;
    await savePricing(next, `已保存 ${result.newKey} 的价格`);
}

async function savePricing(pricing, message) {
    try {
        await api('/settings/save', { pricing });
        state.settings.pricing = pricing;
        const hasHistory = (state.summary?.total.requests || 0) > 0;
        if (hasHistory) {
            const { Popup, POPUP_RESULT } = ctx();
            const r = await Popup.show.confirm(message, '新价格会用于之后的请求。要不要也用新价格重新计算历史记录？', { okButton: '重算历史', cancelButton: '只用于以后' });
            if (r === POPUP_RESULT.AFFIRMATIVE) await api('/recalculate');
        } else {
            toastr.success(message);
        }
        await refresh();
    } catch (e) {
        toastr.error(e.message, '保存失败');
    }
}

/* ---------- settings ---------- */

function switchHtml(id, checked) {
    return `<label class="vb-switch"><input type="checkbox" id="${id}" ${checked ? 'checked' : ''}><span class="vb-switch-track"><span class="vb-switch-thumb"></span></span></label>`;
}

function renderSettings() {
    const $p = $root().find('[data-panel="settings"]');
    const p = prefs();
    const s = state.summary;
    const statusDesc = state.connected
        ? `已连接 · 共 ${fmt(s?.total.requests)} 条记录${s?.firstTs ? ` · 统计起点 ${new Date(s.firstTs).toLocaleDateString()}` : ''}`
        : '未连接：请安装服务端插件，在 config.yaml 启用 enableServerPlugins 并重启酒馆';

    $p.html(`
        <div class="vb-row">
            <div class="vb-row-info">
                <div class="vb-row-title">服务端插件</div>
                <div class="vb-row-desc">${statusDesc}</div>
            </div>
            <i class="fa-solid ${state.connected ? 'fa-circle-check vb-ok' : 'fa-circle-xmark vb-danger'} vb-status-icon"></i>
        </div>

        <div class="vb-section-title">显示</div>
        <div class="vb-row">
            <div class="vb-row-info">
                <div class="vb-row-title">请求后弹出花费提示</div>
                <div class="vb-row-desc">每次生成结束后，在右上角显示本次和今日花费</div>
            </div>
            ${switchHtml('vb_toast', p.toast)}
        </div>
        <div class="vb-row vb-row-stack">
            <div class="vb-row-info">
                <div class="vb-row-title">折算货币</div>
                <div class="vb-row-desc">在美元金额旁显示折算金额，汇率填 0 关闭</div>
            </div>
            <div class="vb-inline-inputs">
                <span class="vb-dim">1 USD =</span>
                <input id="vb_rate" class="text_pole vb-input-sm" type="number" step="any" min="0" value="${p.rate || ''}" placeholder="0">
                <input id="vb_currency" class="text_pole vb-input-xs" type="text" value="${esc(p.currency)}">
            </div>
        </div>

        <div class="vb-section-title">数据</div>
        <div class="vb-row">
            <div class="vb-row-info">
                <div class="vb-row-title">按当前定价重算历史</div>
                <div class="vb-row-desc">修改价格后，用新价格重新计算全部历史记录的花费</div>
            </div>
            <div class="menu_button menu_button_icon vb-btn" data-action="recalc"><i class="fa-solid fa-calculator"></i><span>重算</span></div>
        </div>
        <div class="vb-row">
            <div class="vb-row-info">
                <div class="vb-row-title">清零统计</div>
                <div class="vb-row-desc">清空所有历史请求记录，统计从零开始</div>
            </div>
            <div class="menu_button menu_button_icon vb-btn vb-btn-danger" data-action="reset"><i class="fa-solid fa-eraser"></i><span>清零</span></div>
        </div>

        <div class="vb-about">
            <div class="vb-about-icon"><i class="fa-solid fa-receipt"></i></div>
            <div class="vb-about-name">Agent Platform 费用统计</div>
            <div class="vb-about-version">Version ${VERSION}</div>
            <div class="vb-about-desc">SillyTavern Agent Platform 实时用量与费用统计扩展</div>
            <a href="${REPO_URL}" target="_blank" rel="noopener" class="vb-about-link">
                <i class="fa-brands fa-github"></i>
                <span>GitHub</span>
            </a>
            <div class="vb-about-copyright"><a href="https://www.erocraft.com" target="_blank" rel="noopener">艾萝工坊</a> © 2015 - 2026</div>
        </div>
    `);
}

/* ---------- data ---------- */

function updateHeader() {
    const s = state.summary;
    $('#vb_header_today').html(state.connected && s ? `今日 ${usd(s.today.cost)}` : '');
}

async function loadSettings() {
    try {
        state.settings = await api('/settings/get');
    } catch {
        state.settings = null;
    }
}

async function refresh({ toastNew = false } = {}) {
    try {
        state.summary = await api('/summary', {
            since: periodSince(state.period),
            todaySince: periodSince('today'),
            afterTs: state.lastSeenTs ?? 0,
        });
        state.connected = true;
    } catch (e) {
        console.warn('[agent-platform-billing]', e);
        state.connected = false;
        state.summary = null;
    }

    if (state.connected && toastNew && state.lastSeenTs !== null && prefs().toast) {
        for (const r of state.summary.latest) {
            const u = r.usage || {};
            toastr.info(
                `${esc(r.model)}<br>输入 ${fmt(u.promptTokenCount)} · 输出 ${fmt(u.candidatesTokenCount)}${u.thoughtsTokenCount ? ` · 思考 ${fmt(u.thoughtsTokenCount)}` : ''}<br>今日累计 ${money(state.summary.today.cost)}`,
                `本次花费 ${r.cost ? usd(r.cost.total) : '未定价'}`,
                { timeOut: 6000, escapeHtml: false },
            );
        }
    }
    if (state.connected) state.lastSeenTs = state.summary.lastTs;

    updateHeader();
    renderTab(state.tab);
}

/* ---------- events ---------- */

function bindEvents() {
    const $r = $root();

    $r.on('click', '.vb-tab', function () { switchTab(this.dataset.tab); });
    $r.on('click', '[data-period]', function () { state.period = this.dataset.period; refresh(); });
    $r.on('click', '[data-action="retry"]', async () => { await loadSettings(); refresh(); });
    $r.on('click', '[data-action="goto-pricing"]', () => switchTab('pricing'));
    $r.on('click', '[data-action="more"]', () => { state.recordLimit += 50; renderRecords(); });

    $r.on('click', '[data-action="add-price"]', function (e) {
        e.stopPropagation();
        openPriceEditor('', this.dataset.model || '');
    });
    $r.on('click', '[data-action="edit-price"]', function () { openPriceEditor(this.dataset.key); });
    $r.on('click', '[data-action="delete-price"]', async function (e) {
        e.stopPropagation();
        const key = this.dataset.key;
        const { Popup, POPUP_RESULT } = ctx();
        if (await Popup.show.confirm(`删除 ${key} 的定价？`, '之后这个模型的请求会显示为"未定价"。') !== POPUP_RESULT.AFFIRMATIVE) return;
        const next = { ...state.settings.pricing };
        delete next[key];
        await savePricing(next, `已删除 ${key} 的定价`);
    });
    $r.on('click', '[data-action="restore-defaults"]', async () => {
        const { Popup, POPUP_RESULT } = ctx();
        if (await Popup.show.confirm('恢复默认价格？', '你自定义的价格会被替换为插件内置的默认价格。') !== POPUP_RESULT.AFFIRMATIVE) return;
        await savePricing(structuredClone(state.settings.defaultPricing), '已恢复默认价格');
    });

    $r.on('change', '#vb_toast', function () { prefs().toast = this.checked; savePrefs(); });
    $r.on('change', '#vb_rate', function () { prefs().rate = Number(this.value) || 0; savePrefs(); updateHeader(); });
    $r.on('change', '#vb_currency', function () { prefs().currency = this.value.trim() || 'CNY'; savePrefs(); });

    $r.on('click', '[data-action="recalc"]', async () => {
        try {
            const r = await api('/recalculate');
            toastr.success(`已按当前定价重算 ${r.count} 条记录`);
            refresh();
        } catch (e) { toastr.error(e.message); }
    });
    $r.on('click', '[data-action="reset"]', async () => {
        const { Popup, POPUP_RESULT } = ctx();
        if (await Popup.show.confirm('清零 Agent Platform 费用统计？', '所有历史请求记录将被清空，此操作不可恢复。') !== POPUP_RESULT.AFFIRMATIVE) return;
        try {
            await api('/reset');
            state.lastSeenTs = null;
            toastr.success('统计已清零');
            refresh();
        } catch (e) { toastr.error(e.message); }
    });
}

jQuery(async () => {
    $('#extensions_settings2').append(shellHtml());
    bindEvents();
    switchTab('overview');
    await loadSettings();
    await refresh();

    const { eventSource, eventTypes } = ctx();
    const onGenerationDone = () => {
        // Streamed responses are recorded when the upstream SSE ends, which can land slightly after the client finishes.
        setTimeout(() => refresh({ toastNew: true }), 300);
        setTimeout(() => refresh({ toastNew: true }), 2000);
    };
    eventSource.on(eventTypes.GENERATION_ENDED, onGenerationDone);
    eventSource.on(eventTypes.GENERATION_STOPPED, onGenerationDone);
});
