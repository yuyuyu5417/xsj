// js/useStoryMode.js
// 引入 Vue 核心 (与主页保持一致，使用 CDN 版本的 ESM 导出)
import { ref, reactive, nextTick, computed, watch } from 'https://cdnjs.cloudflare.com/ajax/libs/vue/3.3.4/vue.esm-browser.js';

export function useStoryMode(allAgents, apiSettings, userProfile, saveDB, localforage, chats, memos = [], extraContext = {}) {
    // extraContext 可包含：{ videoMemories, worldBooks, getAgentVideoMemories, getScheduleContextForPrompt, buildUnifiedContext }
    const { videoMemories = [], worldBooks = [], getAgentVideoMemories = null, getScheduleContextForPrompt = null, buildUnifiedContext = null, addLog: addLog_Func = null } = extraContext;
    // 可选：接入系统日志（不影响主流程）
    // 高频模块日志去重：同类日志 2 秒内只记录一次，避免刷屏
    const __logLastMap = new Map(); // key -> ts
    const __shouldLog = (key, windowMs = 2000) => {
        const now = Date.now();
        const last = __logLastMap.get(key) || 0;
        if (now - last < windowMs) return false;
        __logLastMap.set(key, now);
        return true;
    };
    const log = (action, status, detail, dedupWindowMs = 2000) => {
        try {
            if (typeof addLog_Func !== 'function') return;
            if (status === 'warning' || status === 'warn' || status === 'error') {
                const d = String(detail || '');
                const sig = `${action}|${status}|${d.slice(0, 120)}`;
                if (!__shouldLog(sig, dedupWindowMs)) return;
            }
            addLog_Func(action, status, detail);
        } catch (_) {}
    };
    
    // === 状态定义 ===
    const showStoryMode = ref(false); // 这一层是控制全屏弹窗的开关
    const storyView = ref('lobby');   // 这一层是内部路由: lobby / stage / novel
    
    const currentEditingAgent = ref(null);
    const currentPlayingAgent = ref(null);
    const showSettingsDrawer = ref(false);
    const settingsTab = ref('assets');
    
    // 舞台状态
    const stageState = reactive({
        currentBg: 'https://images.unsplash.com/photo-1518837695005-2083093ee35b?w=1920',
        currentSprite: '',
        spriteScale: 1.0,
        spriteY: 0,
        breathSpeed: 4,
        displayObject: { text: '', html: '（演出准备中...）' },
        // 角色状态栏信息
        characterStatus: '', // 角色心声
        currentLocation: '', // 当前地点
        currentOutfit: '', // 当前着装
        locationEmoji: '📍', // 地点 emoji（默认）
        locationMode: false // 地点模式（是否只显示地点）
    });
    const stageInput = ref('');
    const isTyping = ref(false);
    const hasNextStep = ref(false);
    const pendingQueue = ref([]);
    
    // 历史与小说模式
    const historyLog = ref([]);
    const showLog = ref(false); // 舞台上的历史浮层
    const novelInput = ref('');
    const novelScroll = ref(null);
    const shouldAutoScroll = ref(true); // 是否应该自动滚动到底部
    
    // 记忆相关
    const isSummarizing = ref(false);
    
    // 状态栏弹窗
    const showStatusModal = ref(false);
    const showOutfitModal = ref(false);
    
    // 文库系统
    const showReader = ref(false);
    const isReaderEditing = ref(false);
    const currentReadingBook = ref(null);
    const excerptLength = ref(30); // 摘要长度控制

    // === 核心功能函数 ===

    // 1. 打开剧场模式 (主入口)
    const openStoryMode = () => {
        showStoryMode.value = true;
        storyView.value = 'lobby';
        log('剧场模式', 'info', '已进入剧场模式');
    };

    const closeStoryMode = () => {
        showStoryMode.value = false;
        currentPlayingAgent.value = null;
    };

    // 2. 进入演出舞台
    const enterStage = async (agent) => {
        currentPlayingAgent.value = agent;
        storyView.value = 'stage';
        log('剧场模式', 'info', `进入舞台: ${agent?.nickname || '未知角色'}`);
        historyLog.value = [];
        stageInput.value = '';
        pendingQueue.value = []; // 清空队列
        
        // 初始化配置
        stageState.breathSpeed = agent.storyConfig?.breathSpeed || 4;
        if (agent.storyConfig?.backgrounds?.length > 0) {
            stageState.currentBg = agent.storyConfig.backgrounds[0].url;
        }
        if (agent.storyConfig?.sprites?.length > 0) {
            applySprite(agent.storyConfig.sprites[0]);
        } else {
            stageState.currentSprite = agent.avatar;
            stageState.spriteScale = 1.0;
            stageState.spriteY = 0;
        }
        
        // 【修复】加载角色专属的状态栏信息（从角色数据或上次记录中读取）
        if (agent.storyConfig?.currentStatus) {
            stageState.characterStatus = agent.storyConfig.currentStatus.characterStatus || '';
            stageState.currentLocation = agent.storyConfig.currentStatus.currentLocation || '';
            stageState.currentOutfit = agent.storyConfig.currentStatus.currentOutfit || '';
            stageState.locationEmoji = agent.storyConfig.currentStatus.locationEmoji || '📍';
        } else {
            // 如果没有保存的状态，初始化为空
            stageState.characterStatus = '';
            stageState.currentLocation = '';
            stageState.currentOutfit = '';
            stageState.locationEmoji = '📍';
        }
        stageState.locationMode = false; // 重置地点模式
        
        hasNextStep.value = false;

        // 先加载历史记录（确保读取最新的50条）
        await loadHistoryToLog(agent);
        
        // 检查是否有历史记录，如果有，显示角色最后一段话
        if (historyLog.value.length > 0) {
             // 从后往前找最后一条 AI 的消息（非用户消息，且不是系统指令）
             const lastAIMessage = [...historyLog.value].reverse().find(m => !m.isUser && m.type !== 'system');
            if (lastAIMessage && lastAIMessage.content) {
                // 格式化显示最后一段话（使用 formatNovelText 或直接显示）
                const lastContent = lastAIMessage.content.replace(/<[^>]+>/g, '').trim(); // 移除HTML标签
                if (lastContent) {
                    // 如果内容太长，截取最后一部分
                    const displayText = lastContent.length > 100 
                        ? '...' + lastContent.slice(-100) 
                        : lastContent;
                    stageState.displayObject.html = `<span class="text-gray">${displayText}</span>`;
                } else {
                    stageState.displayObject.html = `<span class="text-gray">（${agent.nickname} 正在看着你...）</span>`;
                }
            } else {
                // 没有 AI 消息，显示默认提示
                stageState.displayObject.html = `<span class="text-gray">（${agent.nickname} 正在看着你...）</span>`;
            }
        } else {
            // 没有历史记录，显示默认提示（初次进入）
            stageState.displayObject.html = `<span class="text-gray">（${agent.nickname} 正在看着你...）</span>`;
        }
    };

    const applySprite = (spriteObj) => {
        // 如果是同一张图，不重置 (避免闪烁)，只更新位置
        if (stageState.currentSprite !== spriteObj.url) {
            stageState.currentSprite = spriteObj.url;
        }
        stageState.spriteScale = spriteObj.scale || 1.0;
        stageState.spriteY = spriteObj.y || 0;
    };

    // 3. 历史记录同步 - 【修复】直接使用传入的chats变量，避免数据不同步
    const loadHistoryToLog = async (agent) => {
        try {
            console.log("[loadHistoryToLog] 开始加载历史记录", { 
                agentId: agent?.id, 
                agentName: agent?.nickname 
            });
            
            // 【关键修复】直接使用传入的 chats 变量，确保数据同步
            console.log("[loadHistoryToLog] 从内存中读取聊天记录", { 
                totalChats: chats.length,
                chatIds: chats.map(c => ({ id: c.id, isGroup: c.isGroup, agentIds: c.agents?.map(a => a?.id) }))
            });
            
            // 【修复】更精确地查找聊天记录（确保通过角色ID匹配）
            const chat = chats.find(c => {
                if (c.isGroup) return false;
                return c.agents && c.agents.some(a => a && a.id === agent.id);
            });
            
            console.log("[loadHistoryToLog] 找到聊天记录", { 
                chatFound: !!chat, 
                chatId: chat?.id,
                historyLength: chat?.history?.length || 0,
                agentIdsInChat: chat?.agents?.map(a => a?.id)
            });
            
            if (chat && chat.history && Array.isArray(chat.history)) {
                // 1. 过滤：只显示剧场模式的消息 (mode === 'story')
                const storyMessages = chat.history.filter(m => m && m.mode === 'story');
                console.log("[loadHistoryToLog] 过滤后的剧场消息", { 
                    storyMessagesCount: storyMessages.length,
                    totalHistoryCount: chat.history.length
                });
                
                // 2. 截取：最近 50 条（确保每次进入都显示最新50条）
                const recent = storyMessages.slice(-50);
                console.log("[loadHistoryToLog] 截取最近50条", { 
                    recentCount: recent.length,
                    firstMessageTime: recent[0]?.timestamp,
                    lastMessageTime: recent[recent.length - 1]?.timestamp
                });
                
                // 3. 转换为显示格式
                let hasChanges = false;
                historyLog.value = recent.map((m, index) => {
                    // 智能识别指令消息
                    const isSystemCommand = m.content && m.content.trim().startsWith('(系统提示：');
                    let displayContent = m.content || '';
                    if (isSystemCommand) {
                        displayContent = m.content.replace(/^\(系统提示：|\)$/g, '').trim();
                    }
                    
                    // 【修复】确保ID类型一致：如果消息没有ID，需要为它生成一个
                    let msgId = m.id;
                    if (msgId == null || msgId === undefined) {
                        console.warn("警告：消息缺少ID，生成新ID", m);
                        // 使用时间戳+随机数生成新ID（确保唯一性）
                        msgId = Date.now() + Math.random();
                        m.id = msgId; // 直接修改内存中的消息
                        hasChanges = true;
                    }
                    
                    const logEntry = {
                        id: msgId, // 保持原始ID类型（数字）
                        isUser: m.isUser || false,
                        type: isSystemCommand ? 'system' : 'text',
                        content: displayContent,
                        timestamp: m.timestamp || Date.now()
                    };
                    
                    return logEntry;
                });
                
                // 【修复】如果有消息需要补充ID，保存到数据库
                if (hasChanges) {
                    await saveDB('bear_chats', chats);
                    console.log("已为缺少ID的消息批量保存新ID到数据库");
                }
                
                console.log("[loadHistoryToLog] 历史记录加载完成", { 
                    loadedCount: historyLog.value.length 
                });
            } else {
                // 【修复】如果没有聊天记录，初始化为空数组（确保 historyLog 始终存在）
                console.warn("[loadHistoryToLog] 未找到聊天记录或历史为空", {
                    chatExists: !!chat,
                    hasHistory: !!chat?.history,
                    isArray: Array.isArray(chat?.history)
                });
                log('剧场模式', 'warning', '未找到该角色的剧场历史记录（可能是第一次进入或数据为空）');
                historyLog.value = [];
            }
            
            // 滚动到底部
            scrollToNovelBottom();
        } catch (e) { 
            console.error("[loadHistoryToLog] 加载失败:", e);
            log('剧场模式', 'error', `加载历史失败: ${e?.message || e}`);
            // 【修复】出错时也要初始化 historyLog，避免后续出错
            historyLog.value = [];
        }
    };

    // 4. 【统一上下文】获取全量跨场景上下文 - 剧场模式专用
    // 包含：剧场原文 + LINE私聊 + LINE群聊 + INS + 随记 + 视频通话 + 世界书
    const getChatHistoryContext = async (agent, memosArr = []) => {
        const chat = chats.find(c => !c.isGroup && c.agents && c.agents.some(a => a && a.id === agent.id));
        if (!chat) return "";
        
        let contextParts = [];
        const formatTime = (ts) => {
            const d = new Date(ts);
            return `${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
        };
        
        // ========== 1. 世界书设定（放最前面） ==========
        if (worldBooks && worldBooks.length > 0) {
            const linkedBooks = worldBooks.filter(wb => wb.linkedAgentIds && wb.linkedAgentIds.includes(agent.id));
            if (linkedBooks.length > 0) {
                const combinedEntries = linkedBooks.flatMap(wb => wb.entries || []);
                const triggeredEntries = new Set();
                
                // 扫描最近剧场消息作为触发文本
                const recentMsgs = (chat.history || []).filter(m => m.mode === 'story').slice(-10);
                const scanText = recentMsgs.map(m => m.content || '').join('\n').toLowerCase();
                
                combinedEntries.forEach(ent => {
                    if (ent.strategy === 'global' || ent.constant === true) {
                        triggeredEntries.add(ent.content);
                        return;
                    }
                    if (!ent.keys || ent.keys.length === 0) return;
                    const keys = ent.keys.map(k => k.toLowerCase());
                    if (keys.some(k => scanText.includes(k))) {
                        triggeredEntries.add(ent.content);
                    }
                });
                
                if (triggeredEntries.size > 0) {
                    contextParts.push(`【🌍 世界书设定】\n${Array.from(triggeredEntries).join('\n')}`);
                }
            }
        }
        
        // ========== 2. 视频通话记忆（非常重要） ==========
        if (getAgentVideoMemories) {
            const vidMems = getAgentVideoMemories(agent.id);
            if (vidMems && vidMems.length > 0) {
                // 最近一次视频放前面
                const lastVid = vidMems[vidMems.length - 1];
                contextParts.push(`【📹 最近一次视频通话 ${formatTime(lastVid.timestamp)}】\n${lastVid.summary}`);
                
                // 其他历史视频
                if (vidMems.length > 1) {
                    const otherVids = vidMems.slice(0, -1).slice(-10); // 最多10条历史
                    const vidContext = otherVids.map(m => 
                        `[视频 ${formatTime(m.timestamp)}] ${m.summary}`
                    ).join('\n');
                    contextParts.push(`【📹 历史视频通话】\n${vidContext}`);
                }
            }
        }
        
        // ========== 3. LINE私聊消息（50条） ==========
        if (chat && chat.history) {
            const lineMsgs = chat.history
                .filter(m => (!m.source || m.source === 'line') && m.mode !== 'story' && !m.isHidden)
                .slice(-50);
            if (lineMsgs.length > 0) {
                const lineContext = lineMsgs.map(m => 
                    `[LINE私聊 ${formatTime(m.timestamp)}] ${m.isUser ? '用户' : agent.nickname}: ${(m.content || '').replace(/\n/g, ' ')}`
                ).join('\n');
                contextParts.push(`【💬 LINE私聊 最近${lineMsgs.length}条】\n${lineContext}`);
            }
        }
        
        // ========== 4. 剧场模式原文（100条） ==========
        if (chat && chat.history) {
            const storyMsgs = chat.history
                .filter(m => m.mode === 'story')
                .slice(-100);
            if (storyMsgs.length > 0) {
                const storyContext = storyMsgs.map((m, index) => {
                    let timeDiffDesc = "";
                    if (index > 0) {
                        const diffMs = m.timestamp - storyMsgs[index - 1].timestamp;
                        const diffMins = Math.floor(diffMs / 60000);
                        if (diffMins < 1) timeDiffDesc = "(紧接)";
                        else if (diffMins < 60) timeDiffDesc = `(过了${diffMins}分钟)`;
                        else if (diffMins < 1440) timeDiffDesc = `(过了${(diffMins/60).toFixed(1)}小时)`;
                        else timeDiffDesc = `(过了${Math.floor(diffMins/1440)}天)`;
                    }
                    return `[剧场 ${formatTime(m.timestamp)} ${timeDiffDesc}] ${m.isUser ? '用户' : agent.nickname}: ${(m.content || '').replace(/\n/g, ' ')}`;
                }).join('\n');
                contextParts.push(`【🎭 剧场模式原文 最近${storyMsgs.length}条】\n${storyContext}`);
            }
        }
        
        // ========== 5. LINE群聊消息（100条） ==========
        const groupChats = chats.filter(c => c.isGroup && c.agents && c.agents.some(a => a.id === agent.id));
        groupChats.forEach(gc => {
            if (gc.history) {
                const groupMsgs = gc.history
                    .filter(m => (!m.source || m.source === 'line') && !m.isHidden)
                    .slice(-100);
                if (groupMsgs.length > 0) {
                    const groupContext = groupMsgs.map(m => 
                        `[群聊「${gc.name}」 ${formatTime(m.timestamp)}] ${m.isUser ? '用户' : (m.senderName || agent.nickname)}: ${m.type === 'text' ? (m.content || '').replace(/\n/g, ' ') : '[媒体]'}`
                    ).join('\n');
                    contextParts.push(`【👥 LINE群聊「${gc.name}」 最近${groupMsgs.length}条】\n${groupContext}`);
                }
            }
        });
        
        // ========== 6. INS私聊消息（50条） ==========
        if (chat && chat.history) {
            const insMsgs = chat.history
                .filter(m => m.source === 'ins' && m.mode !== 'story' && !m.isHidden)
                .slice(-50);
            if (insMsgs.length > 0) {
                const insContext = insMsgs.map(m => 
                    `[INS私聊 ${formatTime(m.timestamp)}] ${m.isUser ? '用户' : agent.nickname}: ${(m.content || '').replace(/\n/g, ' ')}`
                ).join('\n');
                contextParts.push(`【📸 INS私聊 最近${insMsgs.length}条】\n${insContext}`);
            }
        }
        
        // ========== 7. 剧场模式记忆总结（50条） ==========
        if (agent.storyConfig && agent.storyConfig.memory) {
            const summaries = agent.storyConfig.memory.summaryHistory || [];
            if (summaries.length > 0) {
                const recentSummaries = summaries.slice(-50);
                const summaryContext = recentSummaries.map(s => 
                    `[剧场总结 ${formatTime(s.timestamp)}] ${s.content}`
                ).join('\n');
                contextParts.push(`【📖 剧场记忆总结 最近${recentSummaries.length}条】\n${summaryContext}`);
            }
        }
        
        // ========== 8. 随记（50条） ==========
        if (memosArr && memosArr.length > 0) {
            const agentMemos = memosArr.filter(m => m.agentId === agent.id);
            if (agentMemos.length > 0) {
                const sortedMemos = agentMemos.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 50);
                const memosContext = sortedMemos.map(m => 
                    `[随记 ${formatTime(m.createdAt || Date.now())}] ${m.content || m.text || ''}`
                ).join('\n');
                contextParts.push(`【📝 随记 最近${sortedMemos.length}条】\n${memosContext}`);
            }
        }

        return contextParts.join('\n\n');
    };

    // 5. 发送消息逻辑
    const sendStageMessage = async () => {
        if (!stageInput.value.trim() || isTyping.value) return;
        
        const userInput = stageInput.value;
        stageInput.value = '';
        
        // 1. 用户发言：直接上屏，清空旧文本
        stageState.displayObject.html = `<span class="text-[#5D4037] font-bold">我：</span><span class="text-[#5D4037]">${userInput}</span>`;
        
        // 记录历史（先保存到数据库获取消息ID，再添加到historyLog）
        const savedMsgId = await saveToChatHistory('user', userInput);
        historyLog.value.push({ id: savedMsgId, isUser: true, content: userInput }); 

        // 2. 准备 AI 上下文（日程 + 统一记忆 + 剧场上下文）
        const agent = currentPlayingAgent.value;
        const chat = chats.find(c => !c.isGroup && c.agents && c.agents.some(a => a && a.id === agent.id));
        const scanText = (chat?.history || []).filter(m => m.mode === 'story').slice(-10).map(m => m.content || '').join('\n');
        const scheduleCtx = (typeof getScheduleContextForPrompt === 'function' && agent.schedule?.events)
            ? getScheduleContextForPrompt(agent, 'story', { userName: userProfile?.nickname || '用户' })
            : '';
        const unifiedCtx = typeof buildUnifiedContext === 'function'
            ? buildUnifiedContext(agent, { currentScene: 'story', scanTextForWorldBook: scanText })
            : '';
        const summaries = agent.storyConfig?.memory?.summaryHistory || [];
        const longTermMemory = summaries.length > 0 ? `【长期记忆】\n${summaries.map(s => s.content).join('\n\n')}\n` : "";
        const shortTermContext = await getChatHistoryContext(agent, memos);
        
        const systemPrompt = `你正在出演一场【乙女向/恋爱向】的视觉小说。扮演：${agent.nickname}。
${agent.prompt}

【演出指令 - 必须严格遵守】
1. **沉浸式描写**：必须包含神态、微表情、肢体动作、心理活动。不要只写对话。
2. **格式规范**：
   - 对话内容必须用双引号 "..." 包裹。
   - 动作/旁白/心理活动直接写，或用圆括号 (...) 包裹。
   - 例如：(轻笑一声，手指缠绕着发丝) "怎么，看呆了？"
3. **视觉指令**：
   - 切换立绘：[SPRITE: 触发词] (可用: ${agent.storyConfig?.sprites?.map(s=>s.name).join(', ') || '无'})
   - 切换场景：[SCENE: 触发词] (可用: ${agent.storyConfig?.backgrounds?.map(b=>b.name).join(', ') || '无'})
4. **状态信息标记**（重要）：
   在输出正文之前，必须单独一行输出以下三个标记（如果某项没有变化可以省略，但建议每轮都输出）：
   - [STATUS: 角色当前的心理状态和心声，50-100字，可以包含内心独白]
   - [LOCATION: 当前地点名称，简洁明了]
   - [OUTFIT: 角色当前的着装描述，30字以内]
   这些标记会被自动移除，不会显示在正文中，只用于状态栏显示。
5. **节奏**：将一段话分成几个自然的断句，便于分屏显示。
${scheduleCtx ? `\n${scheduleCtx}` : ''}
${unifiedCtx ? `\n【全场景统一记忆】\n${unifiedCtx}` : ''}

【前情提要】
${shortTermContext}`;

        const messages = [{ role: 'system', content: systemPrompt }, { role: 'user', content: userInput }];

        // 3. 进入"思考中"状态
        isTyping.value = true;

        try {
            const response = await callAI(messages, 5000);
            await processAIResponse(response);
        } catch (e) {
            stageState.displayObject.html = `<span class="text-red-400">(连接中断: ${e.message})</span>`;
            isTyping.value = false;
            log('剧场模式', 'error', `舞台交互失败: ${e?.message || e}`);
        }
    };

    // 6. 小说模式发送
    const sendNovelMessage = async (type = 'dialogue') => {
        if (!novelInput.value.trim() || isTyping.value) return;
        const text = novelInput.value.trim();
        novelInput.value = '';
        
        if (type === 'command') {
            // === 发送指令 ===
            const storageContent = `(系统提示：${text})`;
            const savedMsgId = await saveToChatHistory('user', storageContent);
            historyLog.value.push({ id: savedMsgId, isUser: true, content: text, type: 'system' });
            await handleAIInteraction(text, true, true); // skipUserSave = true，因为已经保存过了
        } else {
            // === 发送对话 ===
            const savedMsgId = await saveToChatHistory('user', text);
            historyLog.value.push({ id: savedMsgId, isUser: true, content: text });
            await handleAIInteraction(text, false, true); // skipUserSave = true，因为已经保存过了
        }
        scrollToNovelBottom();
    };

    // 7. AI 交互处理 (增强版，用于小说模式)
    const handleAIInteraction = async (content, isCommand, skipUserSave = false) => {
        isTyping.value = true;
        
        // 1. 保存用户输入
        if (!skipUserSave) {
            const storageContent = isCommand ? `(系统提示：${content})` : content;
            const savedMsgId = await saveToChatHistory('user', storageContent);
            // 如果是小说模式，还需要添加到 historyLog（已经在 sendNovelMessage 中添加了，这里不需要重复）
        }

        // 2. 获取增强版上下文 (日程 + 统一记忆 + 剧场上下文)
        const agent = currentPlayingAgent.value;
        const chatForCtx = chats.find(c => !c.isGroup && c.agents && c.agents.some(a => a && a.id === agent.id));
        const scanTextNovel = (chatForCtx?.history || []).filter(m => m.mode === 'story').slice(-10).map(m => m.content || '').join('\n');
        const scheduleCtxNovel = (typeof getScheduleContextForPrompt === 'function' && agent.schedule?.events)
            ? getScheduleContextForPrompt(agent, 'story', { userName: userProfile?.nickname || '用户' })
            : '';
        const unifiedCtxNovel = typeof buildUnifiedContext === 'function'
            ? buildUnifiedContext(agent, { currentScene: 'story', scanTextForWorldBook: scanTextNovel })
            : '';
        const context = await getChatHistoryContext(agent, memos);
        
        // 3. 获取当前场景锚点
        let currentSceneName = "未知场景";
        const currentBgUrl = stageState.currentBg;
        const bgObj = currentPlayingAgent.value.storyConfig?.backgrounds?.find(b => b.url === currentBgUrl);
        if (bgObj) currentSceneName = bgObj.name;

        // 4. 获取真实当前时间
        const now = new Date();
        const currentTimeStr = `${now.getMonth()+1}月${now.getDate()}日 ${now.getHours()}点${now.getMinutes()}分`;

        // 5. 全知小说家 Prompt
        const systemPrompt = `你现在是【晋江文学城】的金榜作者，正在与用户共同创作一部【高沉浸感】的乙女向互动小说。

【当前环境状态 (State Snapshot)】
- 当前时间：${currentTimeStr}
- 当前场景：${currentSceneName} (除非剧情逻辑强制切换，否则请保持在此场景描写)
- 扮演角色：${currentPlayingAgent.value.nickname}
- 人设核心：${currentPlayingAgent.value.prompt}

【历史剧情回顾 (Context)】
(格式：[时间及间隔] 说话人: 内容)
----------------
${context}
----------------
${scheduleCtxNovel ? `\n${scheduleCtxNovel}\n` : ''}
${unifiedCtxNovel ? `\n【全场景统一记忆】\n${unifiedCtxNovel}\n` : ''}

【写作指令 - 必须严格遵守】
1. **绝对的时间感 (Time Awareness)**：
   - 请仔细观察历史记录中的 **(时间间隔)** 标记。
   - 如果间隔是 "(紧接上文)"：**严禁**描写天色变化或长时间流逝，剧情必须紧密衔接上一秒的动作。
   - 如果间隔是 "(过了XX小时/天)"：**必须**描写时间的流逝感（如"不知不觉天黑了"、"几天没见"），并自然过渡到当下。
   
2. **沉浸式文笔**：
   - 拒绝流水账。请用细腻的笔触描写光影、气味、温度和微小的肢体语言。
   - 深入角色的内心世界，描写那种欲言又止、占有欲或隐忍克制的微妙情绪。
   - ${isCommand ? '用户发来的是【剧情指令/旁白】，请根据指令强行推动剧情发展，描写环境突变或突发事件。' : '请承接用户的对话，通过角色的反应推动剧情。'}

3. **视觉指令（重要）**：
   - **场景切换**：当剧情发生场景变化时（如从教室到天台、从室内到室外），必须在文本中插入 [SCENE: 场景名] 指令。
     可用场景：${currentPlayingAgent.value.storyConfig?.backgrounds?.map(b => b.name).join(', ') || '无'}
   - **立绘切换**：当角色情绪、表情或状态发生明显变化时（如从平静到愤怒、从微笑到哭泣），必须在文本中插入 [SPRITE: 立绘名] 指令。
     可用立绘：${currentPlayingAgent.value.storyConfig?.sprites?.map(s => s.name).join(', ') || '无'}
   - **指令格式**：指令必须单独一行，格式为 [SCENE: 场景名] 或 [SPRITE: 立绘名]，指令会被自动移除，不会显示在文本中。
   - **使用时机**：
     * 场景切换：当角色移动位置、环境描述改变时使用 [SCENE:...]
     * 立绘切换：当角色情绪变化（开心→难过、平静→激动等）时使用 [SPRITE:...]

4. **状态信息标记**（重要）：
   在输出正文之前，必须单独一行输出以下三个标记（如果某项没有变化可以省略，但建议每轮都输出）：
   - [STATUS: 角色当前的心理状态和心声，50-100字，可以包含内心独白]
   - [LOCATION: 当前地点名称，简洁明了]
   - [OUTFIT: 角色当前的着装描述，30字以内]
   这些标记会被自动移除，不会显示在正文中，只用于状态栏显示。

5. **篇幅与格式**：
   - 字数：**200~500字**。
   - 格式：**纯文本**输出，对话用双引号 "..." 包裹。可以包含 [SCENE:...] 和 [SPRITE:...] 指令。
   - 分段：自然分段，合并连贯动作，不要每句都换行。
请开始你的创作。`;

        const messages = [{ role: 'system', content: systemPrompt }, { role: 'user', content: content }];

        try {
            const response = await callAI(messages, 5000); 
            await processAIResponse(response); 
        } catch (e) {
            // 错误消息不需要保存到数据库，只显示在UI中
            historyLog.value.push({ id: null, isUser: false, content: `(系统提示：AI 连接断开 - ${e.message})`, type: 'system' });
            log('剧场模式', 'error', `小说模式交互失败: ${e?.message || e}`);
        } finally {
            isTyping.value = false;
            scrollToNovelBottom();
        }
    };

    // 8. 流式请求 (完整版，带缓冲处理)
    // 【副API支持】剧场模式属于非聊天功能，优先使用副API
    // 如果副API URL/Key为空，回退到主API的URL/Key，但使用副API选择的模型
    const fetchStream = async (messages, onChunk, maxTokens = 2000) => {
        const useSecondary = apiSettings.secondaryEnabled;

        const activeKey = useSecondary ? (apiSettings.secondaryKey || apiSettings.key) : apiSettings.key;
        const activeUrl = useSecondary ? (apiSettings.secondaryUrl || apiSettings.url) : apiSettings.url;
        const activeModel = useSecondary ? (apiSettings.secondaryModel || apiSettings.textModel) : apiSettings.textModel;

        if (!activeKey) throw new Error('请先设置 API Key');
        const cleanKey = activeKey.replace(/[^\x00-\x7F]/g, "").trim();
        const finalKey = cleanKey.startsWith("Bearer ") ? cleanKey : "Bearer " + cleanKey;
        const endpoint = (activeUrl || 'https://api.openai.com/v1').replace(/\/$/, "");
        const response = await fetch(`${endpoint}/chat/completions`, {
            method: 'POST', 
            headers: { 'Content-Type': 'application/json', 'Authorization': finalKey },
            body: JSON.stringify({ 
                model: activeModel || 'gpt-4o', 
                messages: messages, 
                temperature: 0.8, 
                max_tokens: maxTokens, 
                stream: true 
            })
        });
        if (!response.ok) throw new Error(`API Error`);
        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buffer = "";
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop(); 
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed.startsWith("data: ")) continue;
                const dataStr = trimmed.slice(6);
                if (dataStr === "[DONE]") return;
                try {
                    const json = JSON.parse(dataStr);
                    const content = json.choices[0]?.delta?.content || "";
                    if (content) onChunk(content);
                } catch (e) {}
            }
        }
    };

    // 9. callAI (完整版)
    const callAI = async (msgs, maxTokens = 2000) => {
        let fullText = "";
        await fetchStream(msgs, (chunk) => fullText += chunk, maxTokens);
        return fullText.replace(/<think>[\s\S]*?<\/think>/g, "").trim(); 
    };

    // 10. 结果处理 & 演出队列
    const processAIResponse = async (text) => {
        // 1. 提取状态信息标记 (STATUS / LOCATION / OUTFIT)
        const statusRegex = /\[STATUS:\s*(.*?)\]/i;
        const locationRegex = /\[LOCATION:\s*(.*?)\]/i;
        const outfitRegex = /\[OUTFIT:\s*(.*?)\]/i;
        
        // 提取并更新状态信息（如果存在则更新，不存在则保留上次的值）
        const statusMatch = text.match(statusRegex);
        if (statusMatch) {
            stageState.characterStatus = statusMatch[1].trim();
            text = text.replace(statusMatch[0], ''); // 从正文移除
        }
        
        const locationMatch = text.match(locationRegex);
        if (locationMatch) {
            const locationName = locationMatch[1].trim();
            stageState.currentLocation = locationName;
            // 根据地点名称自动匹配 emoji
            stageState.locationEmoji = getLocationEmoji(locationName);
            text = text.replace(locationMatch[0], ''); // 从正文移除
        }
        
        const outfitMatch = text.match(outfitRegex);
        if (outfitMatch) {
            stageState.currentOutfit = outfitMatch[1].trim();
            text = text.replace(outfitMatch[0], ''); // 从正文移除
        }
        
        // 【修复】将状态信息保存到角色数据中（实现角色独立的状态栏）
        const currentAgent = currentPlayingAgent.value;
        if (currentAgent && currentAgent.storyConfig) {
            if (!currentAgent.storyConfig.currentStatus) {
                currentAgent.storyConfig.currentStatus = {};
            }
            // 只更新有变化的字段
            if (statusMatch) currentAgent.storyConfig.currentStatus.characterStatus = stageState.characterStatus;
            if (locationMatch) {
                currentAgent.storyConfig.currentStatus.currentLocation = stageState.currentLocation;
                currentAgent.storyConfig.currentStatus.locationEmoji = stageState.locationEmoji;
            }
            if (outfitMatch) currentAgent.storyConfig.currentStatus.currentOutfit = stageState.currentOutfit;
            // 异步保存到数据库（不阻塞主流程）
            saveAgentData().catch(e => console.error("保存状态失败:", e));
        }
        
        // 2. 提取并执行指令 (SPRITE / SCENE)
        let cleanText = text;
        const spriteRegex = /\[SPRITE:\s*(.*?)\]/i;
        const sceneRegex = /\[SCENE:\s*(.*?)\]/i;
        
        // 执行立绘切换
        const spriteMatch = cleanText.match(spriteRegex);
        if (spriteMatch) {
            const target = currentPlayingAgent.value.storyConfig?.sprites?.find(s => s.name === spriteMatch[1].trim());
            if (target) applySprite(target);
            cleanText = cleanText.replace(spriteMatch[0], '');
        }
        // 执行场景切换
        const sceneMatch = cleanText.match(sceneRegex);
        if (sceneMatch) {
            const target = currentPlayingAgent.value.storyConfig?.backgrounds?.find(b => b.name === sceneMatch[1].trim());
            if (target) stageState.currentBg = target.url;
            cleanText = cleanText.replace(sceneMatch[0], '');
        }

        // 2. 存入历史 & 记忆 (存纯文本，不带HTML标签)
        cleanText = cleanText.trim();
        // 简单的格式处理：把 AI 的 ||| 替换为换行，方便阅读
        const logContent = cleanText.replace(/\|\|\|/g, '\n');
        // 先保存到数据库获取消息ID，再添加到historyLog
        const savedMsgId = await saveToChatHistory('ai', logContent);
        historyLog.value.push({ id: savedMsgId, isUser: false, content: logContent }); 

        // 3. 智能拆分文本 (Parser)
        const segments = parseDialogue(cleanText);
        
        // 4. 加入播放队列
        pendingQueue.value = segments;
        
        // 5. 立即开始播放第一句
        stageState.displayObject.html = ""; 
        isTyping.value = false; // 重置状态，允许 nextStep 执行
        nextStep();
        
        // 6. 更新记忆计数器
        const agent = currentPlayingAgent.value;
        if (!agent.storyConfig.memory) agent.storyConfig.memory = {};
        if (!agent.storyConfig.memory.messageCounter) agent.storyConfig.memory.messageCounter = 0;
        
        // 每次 AI 回复结束，代表完成了一轮 (用户发+AI回)，计数器+1
        agent.storyConfig.memory.messageCounter += 1;
        
        await saveAgentData();
        triggerAutoSummary(agent); // 尝试触发总结
    };

    // 11. 文本解析器 (完整版，按句号拆分)
    const parseDialogue = (rawText) => {
        // 1. 预处理：将中文引号替换为英文，统一格式
        let text = rawText.replace(/"/g, '"').replace(/"/g, '"');
        
        // 2. 移除可能残留的 ||| 分隔符
        text = text.replace(/\|\|\|/g, ' ');

        // 3. 拆分逻辑：按引号拆分，提取对话和旁白
        const parts = text.split(/(".*?")/g).filter(p => p.trim());
        
        let queue = [];
        
        parts.forEach(part => {
            part = part.trim();
            if (!part) return;

            if (part.startsWith('"') && part.endsWith('"')) {
                // === 对话部分 ===
                const content = part.slice(1, -1);
                queue.push(`<span class="text-pink">"${content}"</span>`);
            } else {
                // === 旁白/动作部分 ===
                // 进一步按句号/换行拆分，增加点击频率，避免一屏字太多
                const subSentences = part.split(/([。！？…]+)/).filter(s => s.trim());
                let buffer = "";
                
                for (let i = 0; i < subSentences.length; i++) {
                    const s = subSentences[i];
                    // 如果是标点，追加到上一句 buffer
                    if (/^[。！？…]+$/.test(s)) {
                        buffer += s;
                        // 形成完整句子，推入队列
                        if (buffer) {
                            let cleanS = buffer.replace(/[\(\)（）]/g, ''); // 去掉动作括号
                            if (cleanS) queue.push(`<span class="text-gray">${cleanS}</span>`);
                            buffer = "";
                        }
                    } else {
                        // 如果 buffer 里还有上一句没发出去的，先发出去
                        if (buffer) {
                            let cleanS = buffer.replace(/[\(\)（）]/g, '');
                            if (cleanS) queue.push(`<span class="text-gray">${cleanS}</span>`);
                        }
                        buffer = s; // 开始新句子
                    }
                }
                // 处理最后剩余的 buffer
                if (buffer) {
                    let cleanS = buffer.replace(/[\(\)（）]/g, '');
                    if (cleanS) queue.push(`<span class="text-gray">${cleanS}</span>`);
                }
            }
        });

        return queue;
    };

    // 11.5. 地点 emoji 映射函数
    const getLocationEmoji = (locationName) => {
        const name = locationName.toLowerCase();
        // 默认 emoji 映射
        if (name.includes('家') || name.includes('房间') || name.includes('卧室') || name.includes('客厅')) return '🏠';
        if (name.includes('学校') || name.includes('教室') || name.includes('校园')) return '🏫';
        if (name.includes('咖啡') || name.includes('餐厅') || name.includes('食堂')) return '☕';
        if (name.includes('公园') || name.includes('花园')) return '🌳';
        if (name.includes('海边') || name.includes('沙滩') || name.includes('海滩')) return '🏖️';
        if (name.includes('商店') || name.includes('商场') || name.includes('超市')) return '🏪';
        if (name.includes('医院') || name.includes('诊所')) return '🏥';
        if (name.includes('图书馆') || name.includes('书店')) return '📚';
        if (name.includes('天台') || name.includes('屋顶')) return '🏙️';
        if (name.includes('街道') || name.includes('路边')) return '🛣️';
        if (name.includes('电影院') || name.includes('影院')) return '🎬';
        if (name.includes('游乐园') || name.includes('乐园')) return '🎠';
        // 默认
        return '📍';
    };

    // 11.6. 切换地点模式
    const toggleLocationMode = () => {
        if (stageState.currentLocation) {
            stageState.locationMode = !stageState.locationMode;
        }
    };

    // 12. 点击继续 / 下一步
    const nextStep = () => {
        // 如果正在打字，瞬间完成当前句
        if (isTyping.value) {
             window._skipTyping = true;
             return; 
        }

        // 如果队列里还有内容
        if (pendingQueue.value.length > 0) {
            const nextHTML = pendingQueue.value.shift();
            
            // 单句显示模式
            stageState.displayObject.html = ""; 
            
            typeWriterHTML(nextHTML);
            
            // 更新 hasNextStep 状态
            hasNextStep.value = pendingQueue.value.length > 0;
        } else {
            // 队列播完了，允许用户输入
            hasNextStep.value = false;
            isTyping.value = false;
        }
    };

    // 13. 支持 HTML 的打字机 (完整版，带时间计算)
    const typeWriterHTML = async (htmlContent) => {
        isTyping.value = true;
        window._skipTyping = false; 
        
        // 解析纯文本用于计算时间
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = htmlContent;
        const text = tempDiv.innerText || tempDiv.textContent; 
        
        // 包裹淡入动画
        const animatedHTML = `<span class="fade-in-text">${htmlContent}</span>`;
        
        stageState.displayObject.html = animatedHTML;
        
        // 模拟打字时间 (单句模式下可以稍微慢一点，更有沉浸感)
        const delay = Math.max(1000, text.length * 80); // 最少停留1秒，或根据字数
        
        const startTime = Date.now();
        const checkTimer = setInterval(() => {
            const elapsed = Date.now() - startTime;
            if (window._skipTyping || elapsed >= delay) {
                clearInterval(checkTimer);
                isTyping.value = false;
            }
        }, 50);
    };

    // 14. 保存到聊天记录（返回消息ID）- 【修复】直接操作内存中的chats变量，避免数据覆盖问题
    const saveToChatHistory = async (role, content) => {
        // 【关键修复】直接使用传入的 chats 变量，而不是从 localforage 读取
        // 这样可以确保 Line 和剧场模式操作的是同一份数据
        let chatIdx = chats.findIndex(c => !c.isGroup && c.agents && c.agents.some(a => a && a.id === currentPlayingAgent.value.id));
        
        // 如果找不到聊天记录，自动创建新的
        if (chatIdx === -1) {
            const newChat = {
                id: Date.now().toString(),
                name: currentPlayingAgent.value.nickname,
                isGroup: false,
                agents: [currentPlayingAgent.value],
                history: [],
                lastTime: Date.now(),
                lastPreview: "[剧场演出中...]",
                unreadCount: 0
            };
            chats.unshift(newChat);
            chatIdx = 0;
            console.log("[saveToChatHistory] 创建新聊天记录:", newChat.id);
        }
        
        // 【修复】生成唯一消息ID（使用时间戳+随机数，避免ID冲突）
        const msgId = Date.now() + Math.random();
        const newMsg = { 
            id: msgId, 
            isUser: role === 'user', 
            senderId: role === 'user' ? 'user' : currentPlayingAgent.value.id, 
            content: content, 
            timestamp: Date.now(), 
            mode: 'story', 
            isHidden: true 
        };
        chats[chatIdx].history.push(newMsg);
        chats[chatIdx].lastPreview = "[剧场演出中...]";
        chats[chatIdx].lastTime = Date.now();
        
        // 【修复】使用 saveDB 保存，与 Line 保持一致
        await saveDB('bear_chats', chats);
        console.log("[saveToChatHistory] 保存成功, 消息ID:", msgId, "历史长度:", chats[chatIdx].history.length);
        return msgId; // 返回消息ID
    };

    // 15. 删除最后一条消息
    // 18. 删除最后一条消息（用于撤回功能）- 【修复】直接使用chats变量
    const deleteLastMessageFromDB = async (msgId = null) => {
        // 【关键修复】直接使用传入的 chats 变量
        const chatIdx = chats.findIndex(c => !c.isGroup && c.agents && c.agents.some(a => a && a.id === currentPlayingAgent.value.id));
        
        if (chatIdx !== -1) {
            const chat = chats[chatIdx];
            if (chat.history && chat.history.length > 0) {
                let deleted = false;
                
                // 【修复】如果提供了消息ID，通过ID匹配删除（更准确）
                if (msgId) {
                    const msgIdx = chat.history.findIndex(m => m && m.id === msgId);
                    if (msgIdx !== -1) {
                        chat.history.splice(msgIdx, 1);
                        deleted = true;
                    }
                } else {
                    // 如果没有提供ID，删除最后一条剧场模式的消息（保持兼容）
                    const storyMessages = chat.history.filter(m => m && m.mode === 'story');
                    if (storyMessages.length > 0) {
                        const lastStoryMsg = storyMessages[storyMessages.length - 1];
                        const lastMsgIdx = chat.history.findIndex(m => m && m.id === lastStoryMsg.id);
                        if (lastMsgIdx !== -1) {
                            chat.history.splice(lastMsgIdx, 1);
                            deleted = true;
                        }
                    }
                }
                
                if (deleted) {
                    // 更新预览（基于剧场模式的消息）
                    const storyMessages = chat.history.filter(m => m && m.mode === 'story');
                    const newLast = storyMessages.length > 0 ? storyMessages[storyMessages.length - 1] : null;
                    if (newLast) {
                        chat.lastPreview = newLast.mode === 'story' ? '(剧情更新)' : newLast.content;
                        chat.lastTime = newLast.timestamp || Date.now();
                    } else {
                        chat.lastPreview = '';
                    }
                    
                    // 【重要】同步回数据库
                    await saveDB('bear_chats', chats);
                }
            }
        }
    };

    // 16. 记忆系统：增量自动总结 - 【修复】直接使用chats变量
    const triggerAutoSummary = async (agent, force = false) => {
        if (!agent.storyConfig.memory) agent.storyConfig.memory = {};
        const interval = agent.storyConfig.memory.summaryInterval || 20;
        // 只有当 (计数器 >= 阈值) 或 (强制触发) 时才执行
        if (!force && ((agent.storyConfig.memory.messageCounter || 0) < interval || isSummarizing.value)) return;

        console.log(`[Memory] 准备增量总结...`);
        isSummarizing.value = true;

        try {
            // 【关键修复】直接使用传入的 chats 变量
            const chat = chats.find(c => !c.isGroup && c.agents && c.agents.some(a => a && a.id === agent.id));
            if (!chat) throw new Error("无聊天记录");

            // 1. 筛选剧场消息
            const storyMsgs = chat.history.filter(m => m.mode === 'story');
            if (storyMsgs.length === 0) return;

            // 2. 寻找增量切入点 (Bookmark)
            let startIndex = 0;
            const lastId = agent.storyConfig.memory.lastSummarizedMsgId;
            
            if (lastId) {
                const lastIndex = storyMsgs.findIndex(m => m.id === lastId);
                if (lastIndex !== -1) {
                    startIndex = lastIndex + 1; // 从下一条开始
                }
            }

            // 3. 提取未总结的新消息
            const newMsgs = storyMsgs.slice(startIndex);
            
            if (newMsgs.length === 0) {
                console.log("[Memory] 没有新的增量内容需总结");
                return; 
            }

            // 4. 构建 Prompt
            const textBlock = newMsgs.map(m => `${m.isUser ? '用户' : agent.nickname}: ${m.content}`).join('\n');
            const defaultPrompt = `你是一个专业的小说编辑。请阅读以下【新增剧情片段】，将其改写为一段精炼的剧情梗概。
要求：
1. 承接上文，概括这段新发生的剧情。
2. 保留关键转折、地点变迁。
3. 采用第三人称。字数200字以内。
4. 直接输出总结。`;
            const userPrompt = agent.storyConfig.memory.summaryPrompt || defaultPrompt;

            // 5. 调用 AI - 【修改】将token限制从500调整为3000，允许生成更详细的总结
            const summaryText = await callAI([{ role: 'system', content: userPrompt }, { role: 'user', content: `新增剧情：\n${textBlock}` }], 3000);

            if (summaryText) {
                // 存入记忆
                if (!agent.storyConfig.memory.summaryHistory) agent.storyConfig.memory.summaryHistory = [];
                agent.storyConfig.memory.summaryHistory.push({
                    id: Date.now(),
                    range: `新增剧情 (${new Date().toLocaleTimeString()})`,
                    content: summaryText.trim(),
                    timestamp: Date.now()
                });
                
                // 更新书签 ID 为这批消息的最后一条
                agent.storyConfig.memory.lastSummarizedMsgId = newMsgs[newMsgs.length - 1].id;
                
                // 归零计数器
                agent.storyConfig.memory.messageCounter = 0;
                
                // 刷新当前编辑视图
                if (currentEditingAgent.value && currentEditingAgent.value.id === agent.id) {
                    currentEditingAgent.value.storyConfig.memory.summaryHistory = [...agent.storyConfig.memory.summaryHistory];
                    currentEditingAgent.value.storyConfig.memory.messageCounter = 0;
                }
                
                await saveAgentData();
                if(force) alert(`增量总结完成！收录了 ${newMsgs.length} 条新对话。`);
            }
        } catch (e) { console.error(e); } finally { isSummarizing.value = false; }
    };

    const forceTriggerSummary = (agent) => triggerAutoSummary(agent, true);
    
    const deleteMemory = (agent, trueIdx) => {
        if(confirm("确定删除这条记忆吗？")) {
            agent.storyConfig.memory.summaryHistory.splice(trueIdx, 1);
        }
    };

    // 17. 保存角色数据 (带安全检查)
    const saveAgentData = async () => {
        // 安全锁：绝对禁止保存空数组！
        if (!allAgents || allAgents.length === 0) {
            console.warn("[Story] 触发了保存保护机制：当前角色列表为空，跳过保存，防止数据丢失。");
            return;
        }

        try {
            // 使用 JSON.parse/stringify 去除 Vue 的 Proxy 包装，确保存储纯净数据
            const dataToSave = JSON.parse(JSON.stringify(allAgents));
            await localforage.setItem('bear_agents', dataToSave);
            console.log("[Story] 数据已安全保存");
        } catch (e) {
            console.error("[Story] 保存失败:", e);
        }
    };

    // 18. 辅助功能
    const scrollToNovelBottom = () => {
        if (novelScroll.value && shouldAutoScroll.value) {
            // 使用 requestAnimationFrame 确保在 DOM 更新后执行
            requestAnimationFrame(() => {
                if (novelScroll.value) {
                    const scrollHeight = novelScroll.value.scrollHeight;
                    const clientHeight = novelScroll.value.clientHeight;
                    // 直接设置 scrollTop，确保立即滚动到底部
                    novelScroll.value.scrollTop = scrollHeight - clientHeight;
                    // 备用方案：使用 scrollTo
                    novelScroll.value.scrollTo({
                        top: scrollHeight,
                        behavior: 'auto'
                    });
                }
            });
        }
    };
    
    // 处理用户手动滚动，如果用户向上滚动，则暂停自动滚动
    const handleNovelScroll = () => {
        if (novelScroll.value) {
            const scrollTop = novelScroll.value.scrollTop;
            const scrollHeight = novelScroll.value.scrollHeight;
            const clientHeight = novelScroll.value.clientHeight;
            // 如果用户滚动到底部附近（距离底部小于 100px），则恢复自动滚动
            const isNearBottom = (scrollHeight - scrollTop - clientHeight) < 100;
            shouldAutoScroll.value = isNearBottom;
        }
    };
    
    const autoResizeTextarea = (e) => { 
        e.target.style.height = 'auto'; 
        e.target.style.height = e.target.scrollHeight + 'px'; 
    };
    
    // 19. 小说文本渲染器 (安全版)
    const formatNovelText = (text) => {
        if (!text) return '';
        
        let clean = text;

        // 1. 暴力去脏：移除所有可能残留的 HTML 标签和实体
        clean = clean.replace(/<[^>]+>/g, ''); // 删掉所有 <...>
        clean = clean.replace(/&[a-z]+;/gi, ''); // 删掉 &nbsp; 等
        
        // 2. 清理 AI 可能输出的 CSS 类名残留
        clean = clean.replace(/["']?[\w-]+["']?>/g, ''); 

        // 3. 压缩空行：将所有连续换行变成单个换行
        clean = clean.replace(/(\r\n|\n|\r)+/g, '\n');
        
        // 4. 安全标记：使用最简单的 <b> 标签包裹对话
        clean = clean.replace(/“([^”]+)”/g, '<b>“$1”</b>');
        clean = clean.replace(/"([^"]+)"/g, '<b>"$1"</b>');

        // 5. 排版：处理换行
        clean = clean.trim().replace(/\n/g, '<br>');
        
        return clean;
    };

    // 20. 打开小说模式并自动吸附底部 - 修复版：重新加载历史记录
    const openNovelMode = async () => {
        storyView.value = 'novel';
        
        // 【修复】如果 currentPlayingAgent 存在，重新从数据库加载历史记录
        if (currentPlayingAgent.value) {
            console.log("[openNovelMode] 重新加载剧情记录历史", { 
                agentId: currentPlayingAgent.value.id, 
                agentName: currentPlayingAgent.value.nickname 
            });
            await loadHistoryToLog(currentPlayingAgent.value);
        } else {
            console.warn("[openNovelMode] currentPlayingAgent 为空，无法加载历史记录");
        }
        
        // 使用多次延迟确保滚动到底部（等待 DOM 渲染完成）
        nextTick(() => {
            scrollToNovelBottom();
            setTimeout(() => scrollToNovelBottom(), 50);
            setTimeout(() => scrollToNovelBottom(), 200);
            setTimeout(() => scrollToNovelBottom(), 500);
        });
    };
    
    // 监听 storyView 变化，当切换到 novel 模式时自动滚动到底部 - 修复版：重新加载历史记录
    watch(storyView, async (newView) => {
        if (newView === 'novel') {
            shouldAutoScroll.value = true; // 切换到 novel 模式时，恢复自动滚动
            
            // 【修复】重新从数据库加载历史记录（确保数据最新）
            if (currentPlayingAgent.value) {
                console.log("[watch storyView] 切换到剧情记录模式，重新加载历史记录", { 
                    agentId: currentPlayingAgent.value.id, 
                    agentName: currentPlayingAgent.value.nickname 
                });
                await loadHistoryToLog(currentPlayingAgent.value);
            } else {
                console.warn("[watch storyView] currentPlayingAgent 为空，无法加载历史记录");
            }
            
            nextTick(() => {
                scrollToNovelBottom();
                setTimeout(() => scrollToNovelBottom(), 100);
                setTimeout(() => scrollToNovelBottom(), 300);
                setTimeout(() => scrollToNovelBottom(), 600);
            });
        }
    });
    
    // 监听 historyLog 变化，当有新内容时自动滚动到底部（仅在 novel 模式下）
    watch(historyLog, () => {
        if (storyView.value === 'novel' && shouldAutoScroll.value) {
            nextTick(() => {
                scrollToNovelBottom();
            });
        }
    }, { deep: true });
    
    // 21. 撤回
    // 21. 撤回上一条 - 增强版：通过消息ID精确删除
    const undoLast = async () => {
        if(!confirm("确定撤回上一条吗？")) return;
        if (historyLog.value.length === 0) return;
        
        const lastLog = historyLog.value[historyLog.value.length - 1];
        const lastMsgId = lastLog?.id;
        
        // 从 UI 删除
        historyLog.value.pop();
        
        // 【修复】通过消息ID精确删除数据库中的记录
        await deleteLastMessageFromDB(lastMsgId);
    };
    
    // 22. 编辑（通过消息ID匹配数据库记录）- 【修复】直接使用chats变量
    const editLog = async (idx) => {
        const logItem = historyLog.value[idx];
        // 移除HTML标签获取纯文本
        const originalContent = logItem.content.replace(/<[^>]+>/g, '').trim();
        const newText = prompt("修改这段内容：", originalContent);
        if(newText && newText.trim() !== originalContent) {
            // 【重要】先更新数据库，再更新UI（确保数据一致性）
            if (logItem.id) {
                // 【关键修复】直接使用传入的 chats 变量
                const chat = chats.find(c => {
                    if (c.isGroup) return false;
                    return c.agents && c.agents.some(a => a && a.id === currentPlayingAgent.value.id);
                });
                if (chat && chat.history) {
                    // 【修复】使用字符串比较确保ID匹配（兼容数字和字符串类型）
                    const msgIdx = chat.history.findIndex(m => {
                        if (!m || !m.id) return false;
                        // 使用字符串比较，确保类型一致
                        return String(m.id) === String(logItem.id);
                    });
                    if (msgIdx !== -1) {
                        // 更新数据库中的内容
                        chat.history[msgIdx].content = newText.trim();
                        console.log("已更新数据库中的消息:", {
                            id: chat.history[msgIdx].id,
                            oldContent: originalContent.substring(0, 30),
                            newContent: newText.trim().substring(0, 30)
                        });
                        
                        // 如果编辑的是最后一条消息，更新预览
                        const storyMessages = chat.history.filter(m => m && m.mode === 'story');
                        const lastStoryMsg = storyMessages.length > 0 ? storyMessages[storyMessages.length - 1] : null;
                        if (lastStoryMsg && String(lastStoryMsg.id) === String(logItem.id)) {
                            chat.lastPreview = lastStoryMsg.mode === 'story' ? '(剧情更新)' : lastStoryMsg.content;
                            chat.lastTime = lastStoryMsg.timestamp || Date.now();
                        }
                        
                        // 【重要】立即保存到数据库
                        await saveDB('bear_chats', chats);
                        console.log("编辑操作已保存到数据库");
                    } else {
                        console.error("编辑失败：找不到匹配的消息", {
                            logItemId: logItem.id,
                            logItemTimestamp: logItem.timestamp,
                            historyIds: chat.history.map(m => ({ id: m?.id, timestamp: m?.timestamp }))
                        });
                        alert("编辑失败：找不到匹配的消息记录，可能消息已被删除");
                        return;
                    }
                }
            }
            
            // 更新 UI（在数据库更新成功后）
            historyLog.value[idx].content = newText.trim();
        }
    };
    
    // 23. 删除日志（通过消息ID匹配数据库记录）- 【修复】直接使用chats变量
    const deleteLog = async (idx) => {
        if(!confirm("删除此条？")) return;
        
        const logItem = historyLog.value[idx];
        if (!logItem || !logItem.id) {
            console.error("删除失败：消息ID不存在", logItem);
            alert("删除失败：无法找到消息ID");
            return;
        }
        
        // 【关键修复】直接使用传入的 chats 变量
        const chat = chats.find(c => {
            if (c.isGroup) return false;
            return c.agents && c.agents.some(a => a && a.id === currentPlayingAgent.value.id);
        });
        
        if (!chat) {
            console.error("删除失败：找不到聊天记录", currentPlayingAgent.value.id);
            alert("删除失败：找不到聊天记录");
            return;
        }
        
        if (!chat.history || !Array.isArray(chat.history)) {
            console.error("删除失败：聊天记录历史为空或格式错误");
            alert("删除失败：聊天记录历史为空");
            return;
        }
        
        // 【修复】使用严格匹配：同时匹配ID和时间戳（确保匹配到正确的消息）
        const msgIdx = chat.history.findIndex(m => {
            if (!m) return false;
            // 优先使用ID匹配（更准确）
            if (m.id != null && logItem.id != null) {
                return String(m.id) === String(logItem.id);
            }
            // 如果ID不存在，使用时间戳匹配（备用方案）
            if (m.timestamp && logItem.timestamp) {
                return m.timestamp === logItem.timestamp;
            }
            return false;
        });
        
        if (msgIdx === -1) {
            console.error("删除失败：找不到匹配的消息", {
                logItemId: logItem.id,
                logItemTimestamp: logItem.timestamp,
                historyIds: chat.history.map(m => ({ id: m?.id, timestamp: m?.timestamp }))
            });
            alert("删除失败：找不到匹配的消息记录");
            return;
        }
        
        // 从数据库删除
        const deletedMsg = chat.history[msgIdx];
        chat.history.splice(msgIdx, 1);
        console.log("已从数据库删除消息:", deletedMsg);
        
        // 更新预览（基于剧场模式的消息）
        const storyMessages = chat.history.filter(m => m && m.mode === 'story');
        const newLast = storyMessages.length > 0 ? storyMessages[storyMessages.length - 1] : null;
        if (newLast) {
            chat.lastPreview = newLast.mode === 'story' ? '(剧情更新)' : newLast.content;
            chat.lastTime = newLast.timestamp || Date.now();
        } else {
            chat.lastPreview = '';
        }
        
        // 【重要】立即保存到数据库
        await saveDB('bear_chats', chats);
        console.log("删除操作已保存到数据库");
        
        // 从 UI 删除（在数据库删除成功后）
        historyLog.value.splice(idx, 1);
        
        // 【新增】如果当前在剧情记录模式，强制重新加载历史记录（确保UI和数据库完全同步）
        if (storyView.value === 'novel' && currentPlayingAgent.value) {
            console.log("重新加载历史记录以确保同步");
            await loadHistoryToLog(currentPlayingAgent.value);
        }
    };
    
    // 24. 重写功能（完整版，参考 story4.html）
    const regenerate = async () => {
        if (isTyping.value) return; // 防止重复点击
        if (historyLog.value.length === 0) return;

        const lastMsg = historyLog.value[historyLog.value.length - 1];

        // 2. 只有当最后一条是 AI (非 User) 的时候，才有"重写"的意义
        if (!lastMsg.isUser) {
            if (!confirm("确定要删除并重写最后一段剧情吗？")) return;

            // A. 从 UI 列表删除
            const deletedMsgId = lastMsg.id;
            historyLog.value.pop();
            
            // B. 从数据库彻底删除这条 AI 消息（通过消息ID精确删除）
            await deleteLastMessageFromDB(deletedMsgId);

            // C. 找到上一条用户发的内容 (作为重写的 Trigger)
            // 从后往前找第一条是 User 的消息
            const lastUserMsg = historyLog.value.slice().reverse().find(m => m.isUser);
            
            if (lastUserMsg) {
                let contentToResend = lastUserMsg.content;
                // 如果上一条是系统指令，需要判断
                const isCmd = (lastUserMsg.type === 'system') || contentToResend.startsWith('(系统提示：');
                
                // D. 触发 AI 生成
                // 传入 true 表示跳过保存用户消息，因为用户消息还在那里，不需要删了重发
                console.log("正在重写，基于用户消息:", contentToResend);
                await handleAIInteraction(contentToResend, isCmd, true);
            } else {
                alert("找不到前置用户消息，无法重写。");
            }
        } else {
            // 如果最后一条是用户发的（比如刚才生成失败了），直接重试
            const contentToResend = lastMsg.content;
            const isCmd = (lastMsg.type === 'system') || contentToResend.startsWith('(系统提示：');
            // 用户消息已存，但AI没存，所以也是 skipUserSave = true
            await handleAIInteraction(contentToResend, isCmd, true);
        }
    };

    // 25. 设置抽屉逻辑
    const openSettings = (agent) => { 
        currentEditingAgent.value = JSON.parse(JSON.stringify(agent)); 
        // 确保 storyConfig 存在并初始化默认值
        if (!currentEditingAgent.value.storyConfig) {
            currentEditingAgent.value.storyConfig = {
                sprites: [],
                backgrounds: [],
                breathSpeed: 4,
                memory: {},
                archives: []
            };
        }
        // 确保 memory 对象存在并初始化默认值
        if (!currentEditingAgent.value.storyConfig.memory) {
            currentEditingAgent.value.storyConfig.memory = {
                summaryInterval: 20,
                messageCounter: 0,
                summaryHistory: [],
                chatContextLimit: 50,
                summaryPrompt: '',
                summaryLimit: 6,  // 线上读取剧场总结的上限（条）
                rawLimit: 5000,   // 线上读取剧场原文的上限（句）
                onlineInsContextLimit: 0,      // 线上读取INS消息上下文数量（上限10000）
                onlineLineContextLimit: 0,     // 线上读取LINE消息上下文数量（上限10000）
                onlineLineSummaryLimit: 0       // 线上读取LINE记忆总结（memos）数量（上限3000）
            };
        } else {
            // 如果 memory 对象已存在，确保新字段有默认值
            if (currentEditingAgent.value.storyConfig.memory.summaryLimit === undefined) {
                currentEditingAgent.value.storyConfig.memory.summaryLimit = 6;
            }
            if (currentEditingAgent.value.storyConfig.memory.rawLimit === undefined) {
                currentEditingAgent.value.storyConfig.memory.rawLimit = 5000;
            }
            if (currentEditingAgent.value.storyConfig.memory.onlineInsContextLimit === undefined) {
                currentEditingAgent.value.storyConfig.memory.onlineInsContextLimit = 0;
            }
            if (currentEditingAgent.value.storyConfig.memory.onlineLineContextLimit === undefined) {
                currentEditingAgent.value.storyConfig.memory.onlineLineContextLimit = 0;
            }
            if (currentEditingAgent.value.storyConfig.memory.onlineLineSummaryLimit === undefined) {
                currentEditingAgent.value.storyConfig.memory.onlineLineSummaryLimit = 0;
            }
        }
        // 确保 archives 数组存在
        if (!currentEditingAgent.value.storyConfig.archives) {
            currentEditingAgent.value.storyConfig.archives = [];
        }
        // 确保 lastArchivedMsgId 字段存在（如果不存在，第一次收录会从第一条开始）
        if (currentEditingAgent.value.storyConfig.lastArchivedMsgId === undefined) {
            currentEditingAgent.value.storyConfig.lastArchivedMsgId = null;
        }
        // 确保 sprites 和 backgrounds 数组存在
        if (!currentEditingAgent.value.storyConfig.sprites) {
            currentEditingAgent.value.storyConfig.sprites = [];
        }
        if (!currentEditingAgent.value.storyConfig.backgrounds) {
            currentEditingAgent.value.storyConfig.backgrounds = [];
        }
        settingsTab.value = 'assets'; 
        showSettingsDrawer.value = true; 
    };
    
    const closeSettings = () => { 
        showSettingsDrawer.value = false; 
        currentEditingAgent.value = null; 
    };
    
    // 26. 图片压缩（支持透明背景）
    const compressImage = (base64) => {
        return new Promise((resolve) => {
            const img = new Image(); 
            img.src = base64;
            img.onload = () => {
                const cvs = document.createElement('canvas');
                const ctx = cvs.getContext('2d');
                const scale = 800 / img.width;
                cvs.width = 800; 
                cvs.height = img.height * scale;
                
                // 先清空画布（对于透明图片很重要）
                ctx.clearRect(0, 0, cvs.width, cvs.height);
                
                // 绘制图片
                ctx.drawImage(img, 0, 0, cvs.width, cvs.height);
                
                // 检测是否有透明像素
                const imageData = ctx.getImageData(0, 0, cvs.width, cvs.height);
                const data = imageData.data;
                let hasTransparency = false;
                
                // 检查前 1000 个像素（采样检测，提高性能）
                const sampleSize = Math.min(1000, data.length / 4);
                for (let i = 0; i < sampleSize; i++) {
                    const alpha = data[i * 4 + 3]; // alpha 通道
                    if (alpha < 255) {
                        hasTransparency = true;
                        break;
                    }
                }
                
                // 如果有透明通道，使用 PNG 格式保留透明度；否则使用 JPEG 节省空间
                if (hasTransparency) {
                    // PNG 格式，保留透明背景
                    resolve(cvs.toDataURL('image/png'));
                } else {
                    // JPEG 格式，压缩率更高
                    resolve(cvs.toDataURL('image/jpeg', 0.85));
                }
            };
            img.onerror = () => {
                // 如果图片加载失败，返回原始 base64
                resolve(base64);
            };
        });
    };
    
    // 27. 文件上传处理 (完整版)
    const handleUpload = (e, type) => {
        const f = e.target.files[0];
        if(!f) return;
        const r = new FileReader();
        r.onload = async (evt) => {
            const res = await compressImage(evt.target.result);
            if (!currentEditingAgent.value.storyConfig[type]) {
                currentEditingAgent.value.storyConfig[type] = [];
            }
            currentEditingAgent.value.storyConfig[type].push({ 
                id: Date.now(), 
                name: type==='sprites'?'新立绘':'新场景', 
                url: res, 
                scale: 1.0, 
                y: 0 
            });
        };
        r.readAsDataURL(f);
    };

    const deleteAsset = (type, idx) => { 
        currentEditingAgent.value.storyConfig[type].splice(idx, 1); 
    };
    
    // 28. 保存设置
    const saveSettings = async () => {
        // 找到原对象并更新
        const agentIdx = allAgents.findIndex(a => a.id === currentEditingAgent.value.id);
        if (agentIdx !== -1) {
            allAgents[agentIdx] = JSON.parse(JSON.stringify(currentEditingAgent.value));
            await saveAgentData();
            alert("保存成功");
            showSettingsDrawer.value = false;
        }
    };
    
    const hasStoryConfig = (a) => a.storyConfig && a.storyConfig.sprites && a.storyConfig.sprites.length > 0;

    // 29. 文库系统：收录当前历史（增量收录）- 【修复】直接使用chats变量
    const archiveCurrentStory = async () => {
        // 【关键修复】直接使用传入的 chats 变量
        const chat = chats.find(c => !c.isGroup && c.agents && c.agents.some(a => a && a.id === currentEditingAgent.value.id));
        
        if (!chat || !chat.history || chat.history.length === 0) { 
            alert("暂无剧场记录"); 
            return; 
        }
        
        // 1. 筛选剧场消息（只收录剧场模式的消息）
        const storyMsgs = chat.history.filter(m => m.mode === 'story');
        
        if (storyMsgs.length === 0) {
            alert("暂无剧场记录");
            return;
        }
        
        // 2. 寻找增量切入点（从上次收录的位置之后开始）
        let startIndex = 0;
        // 从 allAgents 读取最新的 lastArchivedMsgId，而不是从 currentEditingAgent（深拷贝）读取
        const actualAgent = allAgents.find(a => a.id === currentEditingAgent.value.id);
        const lastArchivedId = actualAgent?.storyConfig?.lastArchivedMsgId;
        
        if (lastArchivedId) {
            // 查找上次收录的最后一条消息的位置
            const lastIndex = storyMsgs.findIndex(m => m.id === lastArchivedId);
            if (lastIndex !== -1) {
                // 从下一条开始收录
                startIndex = lastIndex + 1;
            } else {
                // 如果找不到上次收录的消息ID（可能被删除了），从第一条开始
                console.warn('[Archive] 未找到上次收录的消息ID，将从第一条开始收录');
                startIndex = 0;
            }
        }
        
        // 3. 提取新内容（从 startIndex 开始到结尾）
        const newMsgs = storyMsgs.slice(startIndex);
        
        // 4. 检查是否有新内容
        if (newMsgs.length === 0) {
            alert("暂无新章节可收录，所有内容已收录完毕。");
            return;
        }
        
        // 5. 清洗文本（移除HTML标签，保留纯文本）
        let rawContent = newMsgs.map(m => {
            let txt = m.content.replace(/<[^>]+>/g, '').trim();
            // 移除多余的空白行
            txt = txt.replace(/\n{3,}/g, '\n\n');
            return txt;
        }).filter(txt => txt.length > 0).join('\n\n');
        
        if (!rawContent || rawContent.trim().length === 0) {
            alert("暂无新章节可收录，所有内容已收录完毕。");
            return;
        }

        // 6. 生成默认标题并让用户确认
        const date = new Date();
        const defaultTitle = `${date.getMonth() + 1}月${date.getDate()}日 - 新增章节`;
        const title = prompt(`检测到 ${newMsgs.length} 条新剧情（从第 ${startIndex + 1} 条开始），请输入章节标题：`, defaultTitle);
        
        if (!title || title.trim().length === 0) {
            return; // 用户取消或输入为空
        }

        // 7. 存入文库
        if (!currentEditingAgent.value.storyConfig.archives) {
            currentEditingAgent.value.storyConfig.archives = [];
        }
        
        const newBook = {
            id: Date.now(),
            title: title.trim(),
            date: Date.now(),
            content: rawContent,
            excerpt: rawContent.substring(0, 30).replace(/\n/g, ' ').trim()
        };
        
        // 如果摘要长度小于内容长度，添加省略号
        if (rawContent.length > 30) {
            newBook.excerpt += "...";
        }
        
        currentEditingAgent.value.storyConfig.archives.push(newBook);
        
        // 8. 更新归档书签（记录本次收录的最后一条消息ID）
        currentEditingAgent.value.storyConfig.lastArchivedMsgId = newMsgs[newMsgs.length - 1].id;
        
        // 9. 保存设置
        await saveSettings();
        alert(`收录成功！已收录 ${newMsgs.length} 条新剧情。`);
    };

    // 30. 打开阅读器
    const openReader = (book) => {
        currentReadingBook.value = JSON.parse(JSON.stringify(book)); 
        isReaderEditing.value = false;
        showReader.value = true;
    };

    // 31. 保存编辑
    const saveReaderChanges = async () => {
        const archives = currentEditingAgent.value.storyConfig.archives;
        const idx = archives.findIndex(b => b.id === currentReadingBook.value.id);
        if (idx !== -1) {
            archives[idx] = JSON.parse(JSON.stringify(currentReadingBook.value));
            // 更新摘要，使用可配置的长度
            const len = excerptLength.value || 30;
            archives[idx].excerpt = archives[idx].content.substring(0, len).replace(/\n/g, ' ').trim();
            if (archives[idx].content.length > len) {
                archives[idx].excerpt += "...";
            }
            
            await saveSettings();
            isReaderEditing.value = false;
            alert("保存成功");
        }
    };

    // 32. 删除文章
    const deleteArchive = async (viewIndex) => {
        if (!confirm("确定撕毁这一页吗？(无法恢复)")) return;
        
        const archives = currentEditingAgent.value.storyConfig.archives;
        const trueIndex = archives.length - 1 - viewIndex;
        
        archives.splice(trueIndex, 1);
        await saveSettings();
    };

    // 33. 导出剧场模式数据 - 【修复】直接使用chats和allAgents变量
    const exportStoryData = async () => {
        try {
            // 【关键修复】直接使用传入的变量
            const savedChats = chats;
            const savedAgents = allAgents;
            
            // 过滤出剧场模式相关的聊天记录
            const storyChats = savedChats.filter(chat => {
                if (!chat.history || chat.history.length === 0) return false;
                // 检查是否有剧场模式的消息
                return chat.history.some(msg => msg.mode === 'story');
            }).map(chat => ({
                ...chat,
                // 只保留剧场模式的消息
                history: chat.history.filter(msg => msg.mode === 'story')
            }));
            
            // 过滤出有剧场配置的角色
            const storyAgents = (savedAgents || []).filter(agent => 
                agent.storyConfig && 
                (agent.storyConfig.sprites?.length > 0 || 
                 agent.storyConfig.backgrounds?.length > 0 ||
                 agent.storyConfig.archives?.length > 0 ||
                 agent.storyConfig.memory?.summaryHistory?.length > 0)
            );
            
            const exportData = {
                version: '1.0',
                exportTime: new Date().toISOString(),
                chats: storyChats,
                agents: storyAgents,
                metadata: {
                    totalChats: storyChats.length,
                    totalAgents: storyAgents.length,
                    totalMessages: storyChats.reduce((sum, chat) => sum + (chat.history?.length || 0), 0)
                }
            };
            
            // 生成 JSON 文件并下载
            const dataStr = JSON.stringify(exportData, null, 2);
            const dataBlob = new Blob([dataStr], { type: 'application/json' });
            const url = URL.createObjectURL(dataBlob);
            const link = document.createElement('a');
            link.href = url;
            link.download = `剧场模式数据_${new Date().toISOString().split('T')[0]}.json`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);
            
            alert(`导出成功！\n- 聊天记录：${storyChats.length} 条\n- 角色配置：${storyAgents.length} 个\n- 总消息数：${exportData.metadata.totalMessages} 条`);
        } catch (e) {
            console.error("导出失败:", e);
            alert(`导出失败：${e.message}`);
        }
    };

    // 34. 导入剧场模式数据
    const importStoryData = async () => {
        try {
            // 创建文件输入元素
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'application/json';
            input.style.display = 'none';
            
            input.onchange = async (e) => {
                const file = e.target.files[0];
                if (!file) return;
                
                try {
                    const text = await file.text();
                    const importData = JSON.parse(text);
                    
                    // 验证数据格式
                    if (!importData.version || !importData.chats || !importData.agents) {
                        throw new Error('无效的数据格式');
                    }
                    
                    // 确认导入
                    const confirmMsg = `准备导入：\n- 聊天记录：${importData.chats.length} 条\n- 角色配置：${importData.agents.length} 个\n- 总消息数：${importData.metadata?.totalMessages || 0} 条\n\n注意：导入会合并现有数据，不会删除已有记录。\n确定要继续吗？`;
                    if (!confirm(confirmMsg)) return;
                    
                    // 【关键修复】直接使用传入的 chats 和 allAgents 变量
                    
                    // 合并聊天记录
                    for (const importedChat of importData.chats) {
                        const existingIdx = chats.findIndex(c => c.id === importedChat.id);
                        if (existingIdx !== -1) {
                            // 合并历史记录
                            const existingChat = chats[existingIdx];
                            const existingMsgIds = new Set(existingChat.history.map(m => m.id));
                            const newMsgs = importedChat.history.filter(m => !existingMsgIds.has(m.id));
                            if (newMsgs.length > 0) {
                                existingChat.history.push(...newMsgs);
                                // 按时间戳排序
                                existingChat.history.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
                            }
                        } else {
                            // 添加新聊天
                            chats.push(importedChat);
                        }
                    }
                    
                    // 合并角色配置
                    for (const importedAgent of importData.agents) {
                        const existingIdx = allAgents.findIndex(a => a.id === importedAgent.id);
                        if (existingIdx !== -1) {
                            // 合并剧场配置
                            const existingAgent = allAgents[existingIdx];
                            if (!existingAgent.storyConfig) {
                                existingAgent.storyConfig = {};
                            }
                            
                            // 合并立绘
                            if (importedAgent.storyConfig?.sprites) {
                                existingAgent.storyConfig.sprites = [
                                    ...(existingAgent.storyConfig.sprites || []),
                                    ...importedAgent.storyConfig.sprites
                                ];
                                // 去重
                                const spriteMap = new Map();
                                existingAgent.storyConfig.sprites.forEach(s => {
                                    if (!spriteMap.has(s.url)) {
                                        spriteMap.set(s.url, s);
                                    }
                                });
                                existingAgent.storyConfig.sprites = Array.from(spriteMap.values());
                            }
                            
                            // 合并背景
                            if (importedAgent.storyConfig?.backgrounds) {
                                existingAgent.storyConfig.backgrounds = [
                                    ...(existingAgent.storyConfig.backgrounds || []),
                                    ...importedAgent.storyConfig.backgrounds
                                ];
                                const bgMap = new Map();
                                existingAgent.storyConfig.backgrounds.forEach(b => {
                                    if (!bgMap.has(b.url)) {
                                        bgMap.set(b.url, b);
                                    }
                                });
                                existingAgent.storyConfig.backgrounds = Array.from(bgMap.values());
                            }
                            
                            // 合并文库
                            if (importedAgent.storyConfig?.archives) {
                                existingAgent.storyConfig.archives = [
                                    ...(existingAgent.storyConfig.archives || []),
                                    ...importedAgent.storyConfig.archives
                                ];
                                // 按时间戳排序并去重
                                const archiveMap = new Map();
                                existingAgent.storyConfig.archives.forEach(a => {
                                    if (!archiveMap.has(a.id)) {
                                        archiveMap.set(a.id, a);
                                    }
                                });
                                existingAgent.storyConfig.archives = Array.from(archiveMap.values())
                                    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
                            }
                            
                            // 合并记忆
                            if (importedAgent.storyConfig?.memory?.summaryHistory) {
                                if (!existingAgent.storyConfig.memory) {
                                    existingAgent.storyConfig.memory = {};
                                }
                                if (!existingAgent.storyConfig.memory.summaryHistory) {
                                    existingAgent.storyConfig.memory.summaryHistory = [];
                                }
                                existingAgent.storyConfig.memory.summaryHistory.push(
                                    ...importedAgent.storyConfig.memory.summaryHistory
                                );
                                // 去重并按时间排序
                                const memoryMap = new Map();
                                existingAgent.storyConfig.memory.summaryHistory.forEach(m => {
                                    if (!memoryMap.has(m.timestamp)) {
                                        memoryMap.set(m.timestamp, m);
                                    }
                                });
                                existingAgent.storyConfig.memory.summaryHistory = Array.from(memoryMap.values())
                                    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
                            }
                        } else {
                            // 添加新角色
                            allAgents.push(importedAgent);
                        }
                    }
                    
                    // 【关键修复】保存合并后的数据
                    await saveDB('bear_chats', chats);
                    await saveDB('bear_agents', allAgents);
                    
                    // 如果当前正在编辑的角色被更新了，刷新它
                    if (currentEditingAgent.value) {
                        const updatedAgent = allAgents.find(a => a.id === currentEditingAgent.value.id);
                        if (updatedAgent) {
                            currentEditingAgent.value = updatedAgent;
                        }
                    }
                    
                    alert(`导入成功！\n- 已合并聊天记录\n- 已合并角色配置\n- 请刷新页面查看更新`);
                } catch (err) {
                    console.error("导入失败:", err);
                    alert(`导入失败：${err.message}`);
                } finally {
                    document.body.removeChild(input);
                }
            };
            
            document.body.appendChild(input);
            input.click();
        } catch (e) {
            console.error("导入失败:", e);
            alert(`导入失败：${e.message}`);
        }
    };

    return {
        showStoryMode, storyView, openStoryMode, closeStoryMode,
        currentPlayingAgent, enterStage, stageState, stageInput, isTyping, sendStageMessage, hasNextStep, nextStep,
        showLog, historyLog,
        novelInput, novelScroll, sendNovelMessage, autoResizeTextarea, formatNovelText, openNovelMode, handleNovelScroll,
        undoLast, editLog, deleteLog, regenerate,
        // Settings
        showSettingsDrawer, storyActiveTab: settingsTab, currentEditingAgent, openSettings, closeSettings, saveSettings, deleteAsset, hasStoryConfig,
        handleUpload,
        // Memory
        isSummarizing, triggerAutoSummary, forceTriggerSummary, deleteMemory,
        // Archive
        showReader, isReaderEditing, currentReadingBook, excerptLength, archiveCurrentStory, openReader, saveReaderChanges, deleteArchive,
        // Import/Export
        exportStoryData, importStoryData,
        // Status Bar
        showStatusModal, showOutfitModal, toggleLocationMode
    };
}
