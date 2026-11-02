const API = '/api/plugins/vertex-billing';
const MODULE = 'vertex_billing';
const PRICE_FIELDS = [
    ['input', '输入'],
    ['inputAudio', '输入(音频)'],
    ['cachedInput', '缓存输入'],
    ['cachedInputAudio', '缓存(音频)'],
    ['output', '输出/思考'],
    ['outputImage', '输出(图片)'],
    ['longContextThreshold', '长上下文阈值'],
    ['long.input', '长·输入'],
    ['long.cachedInput', '长·缓存'],
    ['long.output', '长·输出'],
];

const ctx = () => SillyTavern.getContext();
let lastSeenTs = null;
let serverOk = false;

function localSettings() {
    const s = ctx().extensionSettings;
    s[MODULE] ??= { toast: true, rate: 0, currency: 'CNY' };
    return s[MODULE];
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

function money(usd) {
    const s = localSettings();
    const base = `$${usd.toFixed(usd !== 0 && Math.abs(usd) < 0.01 ? 6 : 4)}`;
    return s.rate > 0 ? `${base} ≈ ${(usd * s.rate).toFixed(4)} ${s.currency}` : base;
}

const fmt = n => Number(n || 0).toLocaleString();
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function startOfToday() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
}

function bucketHtml(title, b) {
    const warn = [];
    if (b.unpriced) warn.push(`${b.unpriced} 条未匹配定价`);
    if (b.incomplete) warn.push(`${b.incomplete} 条流式中断`);
    if (b.grounded) warn.push(`${b.grounded} 次联网搜索(搜索费另计)`);
    return `<div class="vb-card">
        <div class="vb-card-title">${title}</div>
        <div class="vb-cost">${money(b.cost)}</div>
        <div class="vb-sub">${fmt(b.requests)} 次请求 · 输入 ${fmt(b.promptTokens)}(缓存 ${fmt(b.cachedTokens)}) · 输出 ${fmt(b.outputTokens)} · 思考 ${fmt(b.thoughtsTokens)}</div>
        ${warn.length ? `<div class="vb-warn">${warn.join(' · ')}</div>` : ''}
    </div>`;
}

function recordRow(r) {
    const u = r.usage || {};
    const flags = [];
    if (!r.complete) flags.push('中断');
    if (!r.usage) flags.push('无用量');
    if (r.cost?.tier === 'long') flags.push('长上下文');
    if (r.grounded) flags.push('联网');
    if (r.trafficType && r.trafficType !== 'ON_DEMAND') flags.push(r.trafficType);
    return `<tr>
        <td>${new Date(r.ts).toLocaleString()}</td>
        <td title="${esc(r.modelVersion || '')}">${esc(r.model)}</td>
        <td>${fmt(u.promptTokenCount)}</td>
        <td>${fmt(u.cachedContentTokenCount)}</td>
        <td>${fmt(u.candidatesTokenCount)}</td>
        <td>${fmt(u.thoughtsTokenCount)}</td>
        <td>${r.cost ? money(r.cost.total) : '<span class="vb-warn">未定价</span>'}</td>
        <td>${flags.join(' ')}</td>
    </tr>`;
}

async function refresh({ toastNew = false } = {}) {
    let data;
    try {
        data = await api('/summary', { since: startOfToday(), afterTs: lastSeenTs ?? 0 });
        serverOk = true;
    } catch (e) {
        serverOk = false;
        $('#vb_status').html('<span class="vb-warn">无法连接服务端插件：请确认 config.yaml 中 enableServerPlugins: true 且已安装 plugins/vertex-billing 并重启酒馆</span>');
        console.warn('[vertex-billing]', e);
        return;
    }
    $('#vb_status').text(data.firstTs ? `统计起点：${new Date(data.firstTs).toLocaleString()}` : '暂无记录');
    $('#vb_cards').html(bucketHtml('今日', data.period) + bucketHtml('累计', data.total));

    const models = Object.entries(data.byModel).sort((a, b) => b[1].cost - a[1].cost);
    $('#vb_models tbody').html(models.map(([m, b]) => `<tr>
        <td>${esc(m)}</td><td>${fmt(b.requests)}</td><td>${fmt(b.promptTokens)}</td><td>${fmt(b.cachedTokens)}</td>
        <td>${fmt(b.outputTokens)}</td><td>${fmt(b.thoughtsTokens)}</td><td>${money(b.cost)}${b.unpriced ? ' <span class="vb-warn">*</span>' : ''}</td>
    </tr>`).join('') || '<tr><td colspan="7">暂无</td></tr>');

    if (toastNew && lastSeenTs !== null && localSettings().toast) {
        for (const r of data.latest) {
            const u = r.usage || {};
            const text = `${r.model}：输入 ${fmt(u.promptTokenCount)} / 输出 ${fmt(u.candidatesTokenCount)} / 思考 ${fmt(u.thoughtsTokenCount)}`;
            toastr.info(text, `本次 ${r.cost ? money(r.cost.total) : '未定价'}　今日 ${money(data.period.cost)}`, { timeOut: 6000 });
        }
    }
    lastSeenTs = data.lastTs;

    const recs = await api('/records', { limit: 30 });
    $('#vb_records tbody').html(recs.map(recordRow).join('') || '<tr><td colspan="8">暂无</td></tr>');
}

function getPath(obj, p) {
    return p.split('.').reduce((o, k) => o?.[k], obj);
}

function setPath(obj, p, v) {
    const keys = p.split('.');
    let o = obj;
    for (const k of keys.slice(0, -1)) o = (o[k] ??= {});
    o[keys.at(-1)] = v;
}

function priceRowHtml(key, price) {
    return `<tr>
        <td><input class="text_pole vb-key" value="${esc(key)}" placeholder="模型ID前缀"></td>
        ${PRICE_FIELDS.map(([f]) => `<td><input class="text_pole vb-num" data-field="${f}" type="number" step="any" min="0" value="${getPath(price, f) ?? ''}"></td>`).join('')}
        <td><div class="menu_button fa-solid fa-trash vb-del" title="删除"></div></td>
    </tr>`;
}

async function loadPricing(useDefaults = false) {
    const s = await api('/settings/get');
    const pricing = useDefaults ? s.defaultPricing : s.pricing;
    $('#vb_pricing tbody').html(Object.entries(pricing).map(([k, p]) => priceRowHtml(k, p)).join(''));
    $('#vb_host').val(s.hostPattern);
}

function collectPricing() {
    const pricing = {};
    $('#vb_pricing tbody tr').each(function () {
        const key = $(this).find('.vb-key').val().trim();
        if (!key) return;
        const p = {};
        $(this).find('.vb-num').each(function () {
            const v = $(this).val();
            if (v !== '' && Number.isFinite(Number(v))) setPath(p, $(this).data('field'), Number(v));
        });
        pricing[key] = p;
    });
    return pricing;
}

function panelHtml() {
    return `<div class="vertex-billing-settings">
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>Vertex AI 精确计费</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <div id="vb_status" class="vb-sub"></div>
            <div id="vb_cards" class="vb-cards"></div>
            <div class="flex-container">
                <div id="vb_refresh" class="menu_button"><i class="fa-solid fa-rotate"></i> 刷新</div>
                <div id="vb_reset" class="menu_button redWarningBG"><i class="fa-solid fa-eraser"></i> 清零</div>
            </div>
            <label class="checkbox_label"><input id="vb_toast" type="checkbox"> 每次请求后弹出花费提示</label>
            <div class="flex-container alignItemsCenter">
                <span>显示折算：1 USD =</span>
                <input id="vb_rate" class="text_pole vb-rate" type="number" step="any" min="0" placeholder="0=不折算">
                <input id="vb_currency" class="text_pole vb-rate" type="text">
            </div>

            <h4>按模型汇总</h4>
            <div class="vb-scroll"><table id="vb_models" class="vb-table">
                <thead><tr><th>模型</th><th>请求</th><th>输入</th><th>缓存</th><th>输出</th><th>思考</th><th>花费</th></tr></thead><tbody></tbody>
            </table></div>

            <h4>最近记录</h4>
            <div class="vb-scroll vb-tall"><table id="vb_records" class="vb-table">
                <thead><tr><th>时间</th><th>模型</th><th>输入</th><th>缓存</th><th>输出</th><th>思考</th><th>花费</th><th>备注</th></tr></thead><tbody></tbody>
            </table></div>

            <h4>定价表（美元 / 每百万 Token）</h4>
            <div class="vb-sub">模型按"完全一致 → 最长前缀"匹配。思考 Token 按输出价计费；提示词超过"长上下文阈值"时整次请求改用"长·"价格；留空的缓存价按普通输入价计算。默认价格仅供参考，请以 Google Cloud 官方价格页为准。</div>
            <div class="vb-scroll"><table id="vb_pricing" class="vb-table vb-pricing">
                <thead><tr><th>模型</th>${PRICE_FIELDS.map(([, l]) => `<th>${l}</th>`).join('')}<th></th></tr></thead><tbody></tbody>
            </table></div>
            <div class="flex-container">
                <div id="vb_add" class="menu_button"><i class="fa-solid fa-plus"></i> 添加模型</div>
                <div id="vb_save" class="menu_button"><i class="fa-solid fa-floppy-disk"></i> 保存定价</div>
                <div id="vb_defaults" class="menu_button">载入默认价格</div>
                <div id="vb_recalc" class="menu_button" title="用当前定价重新计算所有历史记录的花费">按当前定价重算历史</div>
            </div>
            <details>
                <summary>高级</summary>
                <label>匹配的 Vertex 主机名（正则）</label>
                <input id="vb_host" class="text_pole" type="text">
            </details>
        </div>
    </div>
</div>`;
}

function bindUi() {
    const s = localSettings();
    $('#vb_toast').prop('checked', !!s.toast).on('change', function () { s.toast = this.checked; ctx().saveSettingsDebounced(); });
    $('#vb_rate').val(s.rate || '').on('input', function () { s.rate = Number(this.value) || 0; ctx().saveSettingsDebounced(); refresh(); });
    $('#vb_currency').val(s.currency).on('input', function () { s.currency = this.value; ctx().saveSettingsDebounced(); refresh(); });
    $('#vb_refresh').on('click', () => refresh());
    $('#vb_reset').on('click', async () => {
        const { Popup } = ctx();
        const ok = await Popup.show.confirm('清零 Vertex 计费记录？', '当前账本会被归档为备份文件（插件 data 目录下），统计从零重新开始。');
        if (!ok) return;
        await api('/reset');
        lastSeenTs = null;
        toastr.success('已清零');
        refresh();
    });
    $('#vb_add').on('click', () => $('#vb_pricing tbody').append(priceRowHtml('', {})));
    $('#vb_pricing').on('click', '.vb-del', function () { $(this).closest('tr').remove(); });
    $('#vb_defaults').on('click', () => loadPricing(true).then(() => toastr.info('已载入默认价格，点击"保存定价"后生效')));
    $('#vb_save').on('click', async () => {
        try {
            await api('/settings/save', { pricing: collectPricing(), hostPattern: $('#vb_host').val().trim() });
            toastr.success('定价已保存（仅影响之后的请求；如需更新历史请点"按当前定价重算历史"）');
        } catch (e) {
            toastr.error(e.message);
        }
    });
    $('#vb_recalc').on('click', async () => {
        const r = await api('/recalculate');
        toastr.success(`已重算 ${r.count} 条记录`);
        refresh();
    });
}

jQuery(async () => {
    $('#extensions_settings2').append(panelHtml());
    bindUi();
    await refresh();
    if (serverOk) await loadPricing();

    const { eventSource, eventTypes } = ctx();
    const onGenerationDone = () => {
        // Streamed responses are recorded when the upstream SSE ends, which can land slightly after the client finishes.
        setTimeout(() => refresh({ toastNew: true }), 300);
        setTimeout(() => refresh({ toastNew: true }), 2000);
    };
    eventSource.on(eventTypes.GENERATION_ENDED, onGenerationDone);
    eventSource.on(eventTypes.GENERATION_STOPPED, onGenerationDone);
});

