/**
 * TalkFree Analytics — 轻量前端埋点模块
 * 自动上报用户行为到 CF Worker，不影响主线程性能
 */
(function () {
    'use strict';

    var API = 'https://talkfree-analytics-api.2785142729.workers.dev';
    var queue = [];
    var BATCH = 10;       // 攒满 10 条就发
    var INTERVAL = 30000; // 或者每 30 秒发一次

    function did() { return localStorage.getItem('bear_device_id') || ''; }
    function ver() { return localStorage.getItem('app_version') || ''; }

    function platform() {
        var ua = navigator.userAgent || '';
        if (/iPad|iPhone|iPod/.test(ua)) return 'iOS';
        if (/Android/i.test(ua)) return 'Android';
        if (/Windows/i.test(ua)) return 'Windows';
        if (/Mac/i.test(ua)) return 'Mac';
        return 'Other';
    }

    // 注册 / 更新用户信息
    function identify() {
        var d = did();
        if (!d) return;
        try {
            fetch(API + '/api/identify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    device_id: d,
                    activated: localStorage.getItem('bear_is_activated') === 'true' ? 1 : 0,
                    platform: platform(),
                    version: ver()
                })
            }).catch(function () { });
        } catch (e) { }
    }

    // 上报一条事件
    function track(event, data) {
        var d = did();
        if (!d || !event) return;
        data = data || {};
        queue.push({
            device_id: d,
            event: event,
            feature: data.feature || '',
            agent_id: data.agent_id || '',
            metadata: data.metadata || {}
        });
        if (queue.length >= BATCH) flush();
    }

    // 把队列里的事件批量发送
    function flush(useBeacon) {
        if (!queue.length) return;
        var batch = queue.splice(0);
        var body = JSON.stringify(batch);
        var url = API + '/api/track';

        if (useBeacon && navigator.sendBeacon) {
            navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
        } else {
            fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: body
            }).catch(function () {
                queue = batch.concat(queue); // 失败就放回队列
            });
        }
    }

    // 定时 flush
    setInterval(flush, INTERVAL);

    // 页面切到后台 / 关闭时立刻 flush
    document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'hidden') flush(true);
    });

    // 初始化：identify + app_open
    function init() {
        identify();
        track('app_open');
    }

    // 页面加载后自动 init（仅限已有 device_id 的老用户）
    if (did()) {
        if (window.requestIdleCallback) {
            requestIdleCallback(init);
        } else {
            setTimeout(init, 100);
        }
    }

    // 暴露全局接口
    window.TFAnalytics = { track: track, flush: flush, init: init, identify: identify };
})();
