// js/useAgentSchedule.js
import { reactive } from 'https://cdnjs.cloudflare.com/ajax/libs/vue/3.3.4/vue.esm-browser.js';

/**
 * 核心 Prompt：生活流导演系统 V3.0
 * - 60/20/20 法则（60% 主线 / 20% 意外 / 20% 用户相关）
 * - 支持跨日（dayOffset 字段）
 * - 心声以角色独立性为主，偶尔提及用户
 */
const SCHEDULE_SYSTEM_PROMPT = `
你是一个【超现实生活轨迹生成器】。
你的任务是为角色生成详细的日程表。

【角色人设】
{{PERSONA}}

【用户称呼】
{{USER_NAME}}

【生成法则：60/20/20 黄金比例】
1. **60% 主线事件**：必须符合职业和日常习惯（如上课、工作、通勤、吃饭、睡觉）。
2. **20% 意外偏差**：必须包含非日常的小意外（如突然下雨躲雨、路边看到可爱的狗、咖啡洒了、突然想去书店）。
3. **20% 用户相关**：在这 20% 的事件中**偶尔**提及用户 {{USER_NAME}}（如翻看合照、想念对方）。

【心声独立性原则】（非常重要）
- 角色是独立的个体，有自己的生活和想法
- **大多数事件的心声不应该提及用户**，只有在确实与用户相关的事件中才自然地想到用户
- 例如：工作时心声应该是关于工作的，吃饭时心声应该是关于食物的
- 只有在特定事件（如看到情侣、翻手机、睡前等）才可能自然想到用户
- 禁止在每个事件都强行关联用户

【时间范围与跨日说明】
- 日程可以跨越到次日（如夜班工作者：22:00 上班 → 01:30 下班 → 02:30 睡觉）
- 使用 **dayOffset** 字段标记日期：0 = 今天，1 = 明天，2 = 后天
- 时间按 24 小时制，跨日后时间从 00:00 开始，dayOffset 加 1
- 示例：今天 23:00 睡觉 → 明天 07:00 起床 = dayOffset 分别是 0 和 1

【输出要求】
1. 输出一个严格的 JSON 数组。
2. 必须包含 **12-15 个** 时间节点，覆盖角色的完整生活周期。
3. 时间必须连续且逻辑通顺。

【JSON 格式示例】
[
  {
    "time": "08:30",
    "dayOffset": 0,
    "activity": "地铁通勤中",
    "location": "3号线车厢",
    "outfit": "米色风衣，戴着降噪耳机",
    "mood": "没睡醒，微烦躁",
    "inner_thought": "今天人好多，挤死了...希望今天工作顺利。",
    "allow_chat": true,
    "type": "routine"
  },
  {
    "time": "23:30",
    "dayOffset": 0,
    "activity": "睡前刷手机",
    "location": "卧室",
    "outfit": "睡衣",
    "mood": "放松，有点困",
    "inner_thought": "明天周末可以睡懒觉...不知道{{USER_NAME}}睡了没。",
    "allow_chat": true,
    "type": "user_related"
  },
  {
    "time": "01:30",
    "dayOffset": 1,
    "activity": "深夜加班结束",
    "location": "办公室",
    "outfit": "皱巴巴的衬衫",
    "mood": "疲惫",
    "inner_thought": "终于搞完了，明天再也不加班了...",
    "allow_chat": false,
    "type": "routine"
  }
]

**type 取值**：routine（主线）| surprise（意外）| user_related（用户相关）
**注意**：只要 JSON，不要 Markdown，不要废话。
`;

/**
 * 重新生成未来日程的 Prompt（保持连贯性 + 跨日支持）
 */
const REGENERATE_FUTURE_PROMPT = `
你是一个【日程重排专家】。
角色刚刚因为用户的请求而改变了原有计划，你需要重新生成从【变更时间点】之后的日程。

【角色人设】
{{PERSONA}}

【用户称呼】
{{USER_NAME}}

【变更事件】
时间：{{CHANGE_TIME}}（dayOffset: {{CHANGE_DAY_OFFSET}}）
新活动：{{NEW_ACTIVITY}}
原因：{{REASON}}

【之前的日程（供参考连贯性）】
{{PREVIOUS_EVENTS}}

【生成要求】
1. 从变更时间点开始，生成之后的 5-8 个节点。
2. 第一个节点必须是变更事件本身。
3. 后续节点要与变更事件**逻辑连贯**：
   - 如果是去照顾生病的用户，后续可能是：买药、做饭、陪伴、返回等。
   - 如果是紧急见面，后续可能是：约会活动、送用户回家、自己返回等。
4. 体现「代价」机制：因为改变计划，可能需要弥补（如加班、改期、被老板责备等）。
5. 支持跨日：使用 dayOffset 字段（0=今天，1=明天），凌晨时间 dayOffset 应为 1。
6. **心声独立性**：除了直接与用户相关的事件，其他事件的心声不要提及用户。
7. 只输出 JSON 数组，不要 Markdown。

【JSON 格式】
[
  { "time": "{{CHANGE_TIME}}", "dayOffset": {{CHANGE_DAY_OFFSET}}, "activity": "{{NEW_ACTIVITY}}", "location": "...", "outfit": "...", "mood": "...", "inner_thought": "...", "allow_chat": true, "type": "user_related" },
  { "time": "...", "dayOffset": 0或1, "activity": "...", ... },
  ...
]
`;

export function useAgentSchedule(callAI, saveDB) {
    
    const scheduleState = reactive({
        showModal: false,
        currentAgent: null,
        isLoading: false,
        displayDate: '',
        selectedDate: null,      // 当前选中的日期（用于日历）
        showCalendar: false,     // 是否显示日历
        showConfigPanel: false   // 是否显示配置面板
    });

    /**
     * 【内部权限检查函数】检查 agent 是否具有某项日程权限
     * @param agent - 角色对象
     * @param permission - 'read' | 'modify' | 'autoGenerate' | 'enabled'
     * @returns boolean
     */
    const checkPermission = (agent, permission = 'enabled') => {
        if (!agent) return false;
        
        const config = agent.scheduleConfig;
        
        // 兼容旧版数据
        if (!config) {
            if (agent.scheduleEnabled !== undefined) {
                return agent.scheduleEnabled !== false;
            }
            return true; // 默认启用
        }
        
        // 总开关关闭时，所有权限都为 false
        if (!config.enabled) return false;
        
        // 检查具体权限
        if (permission === 'enabled') return config.enabled;
        
        return config.permissions?.[permission] ?? true;
    };

    const getTodayString = () => {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };

    /**
     * 获取日期字符串（支持 dayOffset）
     */
    const getDateString = (dayOffset = 0) => {
        const d = new Date();
        d.setDate(d.getDate() + dayOffset);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };

    /**
     * 统一排序函数：先按 dayOffset，再按时间
     */
    const sortEvents = (events) => {
        return events.sort((a, b) => {
            const dayA = a.dayOffset || 0;
            const dayB = b.dayOffset || 0;
            if (dayA !== dayB) return dayA - dayB;
            
            const [h1, m1] = (a.time || '00:00').split(':').map(Number);
            const [h2, m2] = (b.time || '00:00').split(':').map(Number);
            return (h1 * 60 + m1) - (h2 * 60 + m2);
        });
    };

    /**
     * 计算事件的绝对时间值（用于比较）
     * dayOffset * 1440 + hours * 60 + minutes
     */
    const getAbsoluteTimeVal = (event) => {
        const dayOffset = event.dayOffset || 0;
        const [h, m] = (event.time || '00:00').split(':').map(Number);
        return dayOffset * 1440 + h * 60 + m;
    };

    /**
     * 获取当前的绝对时间值
     */
    const getCurrentAbsoluteTimeVal = () => {
        const now = new Date();
        return now.getHours() * 60 + now.getMinutes();
    };

    /**
     * 检查并生成（增加 force 参数支持强制重生成）
     */
    const checkAndGenerateSchedule = async (agent, force = false, userName = '用户') => {
        if (!agent) return;
        
        // 检查自动生成权限
        if (!checkPermission(agent, 'autoGenerate')) {
            console.log(`[Schedule] 自动生成权限已禁用，跳过生成`);
            return;
        }
        
        if (!agent.schedule) {
            agent.schedule = { date: '', timestamp: 0, events: [], history: [], lastModifyTime: 0, lastModifyReason: '' };
        }
        // 兼容旧数据：确保新字段存在
        if (agent.schedule.lastModifyTime === undefined) agent.schedule.lastModifyTime = 0;
        if (agent.schedule.lastModifyReason === undefined) agent.schedule.lastModifyReason = '';

        const now = Date.now();
        const lastGenTime = agent.schedule.timestamp || 0;
        const oneDay = 24 * 60 * 60 * 1000;

        if (force || now - lastGenTime > oneDay || agent.schedule.events.length === 0) {
            // 归档当前日程到历史
            if (agent.schedule.events.length > 0 && agent.schedule.date) {
                archiveCurrentSchedule(agent);
            }
            await generateNewSchedule(agent, userName);
        } else {
            console.log(`[Schedule] 日程尚在有效期内 (${new Date(lastGenTime).toLocaleString()})`);
        }
    };

    /**
     * 归档当前日程到历史记录
     */
    const archiveCurrentSchedule = (agent) => {
        if (!agent.schedule.history) {
            agent.schedule.history = [];
        }
        
        // 只保留最近 7 天的历史
        const maxHistory = 7;
        
        // 将当前日程归档（只保留终版，不含被修改的部分）
        const archivedSchedule = {
            date: agent.schedule.date,
            events: JSON.parse(JSON.stringify(agent.schedule.events)),
            archivedAt: Date.now()
        };
        
        agent.schedule.history.unshift(archivedSchedule);
        
        // 限制历史记录数量
        if (agent.schedule.history.length > maxHistory) {
            agent.schedule.history = agent.schedule.history.slice(0, maxHistory);
        }
        
        console.log(`[Schedule] 已归档日程: ${agent.schedule.date}, 历史记录数: ${agent.schedule.history.length}`);
    };

    /**
     * 生成新日程（续接模式：从当前时间继续生成）
     */
    const generateNewSchedule = async (agent, userName = '用户', continueMode = false) => {
        // 检查自动生成权限
        if (!checkPermission(agent, 'autoGenerate')) {
            console.log(`[Schedule] 自动生成权限已禁用，跳过生成`);
            return;
        }
        
        scheduleState.isLoading = true;
        console.log(`[Schedule] 正在为 ${agent.nickname} 生成新日程...${continueMode ? '（续接模式）' : ''}`);

        try {
            const filledPrompt = SCHEDULE_SYSTEM_PROMPT
                .replace('{{PERSONA}}', agent.prompt || '')
                .replace(/\{\{USER_NAME\}\}/g, userName);

            let userPrompt = `今天是 ${getTodayString()}，请生成角色的 12-15 个日程节点。`;
            
            // 续接模式：从当前最后一个事件继续
            if (continueMode && agent.schedule?.events?.length > 0) {
                const lastEvent = agent.schedule.events[agent.schedule.events.length - 1];
                const lastTime = lastEvent.time;
                const lastDayOffset = lastEvent.dayOffset || 0;
                userPrompt = `今天是 ${getTodayString()}，角色最后的日程是 ${lastTime}（dayOffset: ${lastDayOffset}）：${lastEvent.activity}。请从这个时间点之后继续生成 8-10 个日程节点，保持逻辑连贯。`;
            }

            const response = await callAI([
                { role: 'system', content: filledPrompt },
                { role: 'user', content: userPrompt }
            ], 2500, 0.9);

            let jsonStr = (response || '').replace(/```json|```/g, '').trim();
            const firstBracket = jsonStr.indexOf('[');
            const lastBracket = jsonStr.lastIndexOf(']');
            if (firstBracket !== -1 && lastBracket !== -1) {
                jsonStr = jsonStr.substring(firstBracket, lastBracket + 1);
            }

            let newEvents = JSON.parse(jsonStr);
            
            // 确保每个事件都有 dayOffset 字段
            newEvents = newEvents.map(e => ({
                ...e,
                dayOffset: e.dayOffset ?? 0
            }));

            if (continueMode && agent.schedule?.events?.length > 0) {
                // 续接模式：合并现有事件和新事件
                agent.schedule.events = [...agent.schedule.events, ...newEvents];
            } else {
                // 全新生成
                agent.schedule = {
                    date: getTodayString(),
                    timestamp: Date.now(),
                    events: newEvents,
                    history: agent.schedule?.history || []
                };
            }

            // 统一排序
            agent.schedule.events = sortEvents(agent.schedule.events);
            agent.schedule.timestamp = Date.now();

            console.log(`[Schedule] 生成成功:`, agent.schedule.events.length, '个节点');

        } catch (e) {
            console.error(`[Schedule] 生成失败:`, e);
            agent.schedule = agent.schedule || { date: '', timestamp: 0, events: [], history: [] };
            agent.schedule.events = [
                { time: "09:00", dayOffset: 0, activity: "发呆", location: "未知", outfit: "-", mood: "-", inner_thought: "AI 接口好像出问题了...", allow_chat: true, type: "routine" }
            ];
        } finally {
            scheduleState.isLoading = false;
        }
    };

    /**
     * 【核心】重新生成未来日程（保持连贯性 + 支持跨日 + 最后一项续接）
     */
    const regenerateFutureSchedule = async (agent, targetTime, newActivity, reason, userName = '用户') => {
        // 检查修改权限
        if (!checkPermission(agent, 'modify')) {
            return { success: false, message: '日程修改权限已禁用，AI 无法改变日程', oldActivity: null };
        }
        
        if (!agent || !agent.schedule || !agent.schedule.events) {
            return { success: false, message: '日程数据不存在', oldActivity: null };
        }

        const now = new Date();
        const currentHour = now.getHours();
        const currentMin = now.getMinutes();
        const currentTimeVal = currentHour * 60 + currentMin;

        const [targetH, targetM] = (targetTime || '').split(':').map(Number);
        if (isNaN(targetH) || isNaN(targetM)) {
            return { success: false, message: '时间格式错误', oldActivity: null };
        }
        const targetTimeVal = targetH * 60 + targetM;

        // 判断目标时间的 dayOffset
        // 如果目标时间小于当前时间（如当前 23:00，目标 03:00），则为次日
        let targetDayOffset = 0;
        if (targetTimeVal < currentTimeVal && targetH < 12) {
            targetDayOffset = 1;
        }

        // 1. 找出已发生的事件（保留）
        const pastEvents = agent.schedule.events.filter(e => {
            const eventAbsVal = getAbsoluteTimeVal(e);
            return eventAbsVal <= currentTimeVal;
        });

        // 2. 找出未来的事件
        const futureEvents = agent.schedule.events.filter(e => {
            const eventAbsVal = getAbsoluteTimeVal(e);
            return eventAbsVal > currentTimeVal;
        });

        // 3. 检查是否是最后一项（或没有更多未来事件）
        const isLastItem = futureEvents.length === 0 || futureEvents.length === 1;

        // 找出被替换的事件
        const replacedEvent = futureEvents.find(e => {
            const [h, m] = (e.time || '').split(':').map(Number);
            const evtVal = h * 60 + m + (e.dayOffset || 0) * 1440;
            const targetAbsVal = targetTimeVal + targetDayOffset * 1440;
            return Math.abs(evtVal - targetAbsVal) < 60;
        });
        const oldActivity = replacedEvent ? replacedEvent.activity : null;

        // 4. 构建之前事件的简述
        const lastTwoEvents = pastEvents.slice(-2);
        const previousEventsStr = lastTwoEvents.length > 0
            ? lastTwoEvents.map(e => `[${e.time}${e.dayOffset ? ' 次日' : ''}] ${e.activity}`).join(' → ')
            : '（今天刚开始）';

        // 5. 调用 AI 生成新的未来日程
        scheduleState.isLoading = true;
        console.log(`[Schedule] 正在重新生成 ${agent.nickname} 从 ${targetTime}（dayOffset: ${targetDayOffset}）开始的日程...${isLastItem ? '（最后一项，将顺延生成）' : ''}`);

        try {
            const filledPrompt = REGENERATE_FUTURE_PROMPT
                .replace('{{PERSONA}}', agent.prompt || '')
                .replace(/\{\{USER_NAME\}\}/g, userName)
                .replace(/\{\{CHANGE_TIME\}\}/g, targetTime)
                .replace(/\{\{CHANGE_DAY_OFFSET\}\}/g, String(targetDayOffset))
                .replace('{{NEW_ACTIVITY}}', newActivity)
                .replace('{{REASON}}', reason)
                .replace('{{PREVIOUS_EVENTS}}', previousEventsStr);

            const promptSuffix = isLastItem 
                ? `请生成从 ${targetTime}（dayOffset: ${targetDayOffset}）开始的 5-8 个日程节点。由于这是当天最后的安排，请继续顺延生成后续活动，可以跨到次日（dayOffset 递增）。`
                : `请生成从 ${targetTime}（dayOffset: ${targetDayOffset}）开始的日程（5-8 个节点）。`;

            const response = await callAI([
                { role: 'system', content: filledPrompt },
                { role: 'user', content: promptSuffix }
            ], 2000, 0.85);

            let jsonStr = (response || '').replace(/```json|```/g, '').trim();
            const firstBracket = jsonStr.indexOf('[');
            const lastBracket = jsonStr.lastIndexOf(']');
            if (firstBracket !== -1 && lastBracket !== -1) {
                jsonStr = jsonStr.substring(firstBracket, lastBracket + 1);
            }

            let newFutureEvents = JSON.parse(jsonStr);
            
            // 确保每个事件都有 dayOffset 字段
            newFutureEvents = newFutureEvents.map(e => ({
                ...e,
                dayOffset: e.dayOffset ?? targetDayOffset
            }));

            // 6. 合并：过去事件 + 新生成的未来事件
            agent.schedule.events = [...pastEvents, ...newFutureEvents];
            agent.schedule.timestamp = Date.now();

            // 统一排序
            agent.schedule.events = sortEvents(agent.schedule.events);

            console.log(`[Schedule] 重新生成成功: 保留 ${pastEvents.length} 个过去事件，新增 ${newFutureEvents.length} 个未来事件`);

            // 【冷却机制】记录本次修改时间和原因
            agent.schedule.lastModifyTime = Date.now();
            agent.schedule.lastModifyReason = reason || newActivity;
            console.log(`[Schedule] 已记录修改时间，冷却期开始`);

            const dayLabel = targetDayOffset > 0 ? `次日 ` : '';
            return {
                success: true,
                message: `📅 日程已变更：${dayLabel}${targetTime} → 「${newActivity}」${oldActivity ? `（原定：${oldActivity}）` : ''}`,
                oldActivity: oldActivity
            };

        } catch (e) {
            console.error(`[Schedule] 重新生成失败:`, e);
            return { success: false, message: '日程生成失败', oldActivity: null };
        } finally {
            scheduleState.isLoading = false;
        }
    };

    /**
     * 动态修改未来日程（简单版，只改单个时间点）
     */
    const modifyFutureSchedule = (agent, targetTime, newActivity, reason) => {
        if (!agent || !agent.schedule || !agent.schedule.events) return null;

        const now = new Date();
        const currentHour = now.getHours();
        const currentMin = now.getMinutes();
        const currentTimeVal = currentHour * 60 + currentMin;

        const [targetH, targetM] = (targetTime || '').split(':').map(Number);
        if (isNaN(targetH) || isNaN(targetM)) return null;

        const targetTimeVal = targetH * 60 + targetM;

        // 判断目标时间的 dayOffset
        let targetDayOffset = 0;
        if (targetTimeVal < currentTimeVal && targetH < 12) {
            targetDayOffset = 1;
        }

        let targetEventIndex = -1;
        let minDiff = Infinity;

        agent.schedule.events.forEach((evt, idx) => {
            const eventAbsVal = getAbsoluteTimeVal(evt);
            if (eventAbsVal > currentTimeVal) {
                const targetAbsVal = targetTimeVal + targetDayOffset * 1440;
                const diff = Math.abs(eventAbsVal - targetAbsVal);
                if (diff < minDiff) {
                    minDiff = diff;
                    targetEventIndex = idx;
                }
            }
        });

        if (targetEventIndex !== -1) {
            const oldEvent = agent.schedule.events[targetEventIndex];
            
            agent.schedule.events[targetEventIndex] = {
                ...oldEvent,
                time: targetTime,
                dayOffset: targetDayOffset,
                activity: newActivity,
                inner_thought: `(计划变更) ${reason}。虽然原来的事情「${oldEvent.activity}」也重要，但还是决定改变行程。`,
                type: 'user_related',
                allow_chat: true
            };

            agent.schedule.events = sortEvents(agent.schedule.events);
            
            const dayLabel = targetDayOffset > 0 ? '次日 ' : '';
            return `📅 日程已变更：${dayLabel}${targetTime} 改为「${newActivity}」`;
        }
        
        return null;
    };

    const getCurrentStatusContext = (agent) => {
        if (!agent || !agent.schedule || !agent.schedule.events || agent.schedule.events.length === 0) return null;
        const now = new Date();
        const curVal = now.getHours() * 60 + now.getMinutes();
        
        // 只考虑今天的事件（dayOffset = 0）
        const todayEvents = agent.schedule.events.filter(e => (e.dayOffset || 0) === 0);
        
        let currentEvent = null;
        for (let evt of todayEvents) {
            const [h, m] = (evt.time || '').split(':').map(Number);
            if (curVal >= h * 60 + m) currentEvent = evt;
            else break;
        }
        return currentEvent || todayEvents[0] || agent.schedule.events[0];
    };

    /**
     * 获取日程上下文字符串，供多模式（LINE/INS/剧场）动态注入 System Prompt
     * @param {Object} agent 角色对象
     * @param {string} mode 'line' | 'ins' | 'story' 模式
     * @param {Object} opts { userName, futureEventsStr } 可选
     * @returns {string} 可注入的日程上下文
     */
    const getScheduleContextForPrompt = (agent, mode = 'line', opts = {}) => {
        const { userName = '用户', futureEventsStr = '' } = opts;
        const currentStatus = getCurrentStatusContext(agent);
        if (!currentStatus) return '';

        const base = `【🕒 当前日程状态 (LifeOS)】
当前时间：${currentStatus.time}。你正在：${currentStatus.activity} @ ${currentStatus.location}。
心情：${currentStatus.mood || '-'}。内心：${currentStatus.inner_thought || '-'}。`;

        if (mode === 'ins') {
            return base + `

【INS 发帖一致性】发帖内容必须与当前日程一致。例如日程显示"14:00 去看画展"，不能发"刚睡醒"，应发画展相关照片或心情。`;
        }
        if (mode === 'story') {
            return base + `

【剧场背景板】见面场景的描写应结合当前日程。例如日程是"晚上有空"，可描写"处理完一整天的工作，终于见到了你"。`;
        }
        if (mode === 'video') {
            return base + `

【视频通话背景】你当前正在进行的活动会影响回复。例如刚开完会可以说累，在看画展可以分享看到的作品。`;
        }
        // line: 返回基础版，完整版（含动态决策引擎）由 index 单独构建
        return base + (futureEventsStr ? `\n接下来的安排：${futureEventsStr}。` : '');
    };

    const getActiveEventIndex = (agent) => {
        if (!agent || !agent.schedule?.events) return -1;
        const current = getCurrentStatusContext(agent);
        if (!current) return -1;
        return agent.schedule.events.findIndex(e => 
            e === current || (e.time === current.time && e.activity === current.activity && (e.dayOffset || 0) === (current.dayOffset || 0))
        );
    };

    /**
     * 获取指定日期的历史日程
     */
    const getHistorySchedule = (agent, date) => {
        if (!agent?.schedule?.history) return null;
        return agent.schedule.history.find(h => h.date === date);
    };

    /**
     * 获取所有有日程的日期列表
     */
    const getScheduleDates = (agent) => {
        if (!agent?.schedule) return [];
        
        const dates = [];
        
        // 当前日程
        if (agent.schedule.date) {
            dates.push(agent.schedule.date);
        }
        
        // 历史日程
        if (agent.schedule.history) {
            for (const h of agent.schedule.history) {
                if (h.date && !dates.includes(h.date)) {
                    dates.push(h.date);
                }
            }
        }
        
        return dates.sort((a, b) => new Date(b) - new Date(a));
    };

    return {
        scheduleState,
        checkAndGenerateSchedule,
        generateNewSchedule,
        regenerateFutureSchedule,
        modifyFutureSchedule,
        getCurrentStatusContext,
        getScheduleContextForPrompt,
        getActiveEventIndex,
        getTodayString,
        getDateString,
        getHistorySchedule,
        getScheduleDates,
        archiveCurrentSchedule,
        sortEvents
    };
}
