// js/useVideoCall.js
import { ref, reactive, watch, nextTick } from 'https://cdnjs.cloudflare.com/ajax/libs/vue/3.3.4/vue.esm-browser.js';
import { useAudioQueue } from './useAudioQueue.js';

export function useVideoCall(apiSettings, userProfile, callAI_Func, callTTS_Func, buildContext_Func, saveMemory_Func, onCallEnded_Func = null, addLog_Func = null) {
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
            // 仅对 warning/error 做去重，info/success 保持原样（便于追踪流程）
            if (status === 'warning' || status === 'warn' || status === 'error') {
                const d = String(detail || '');
                const sig = `${action}|${status}|${d.slice(0, 120)}`;
                if (!__shouldLog(sig, dedupWindowMs)) return;
            }
            addLog_Func(action, status, detail);
        } catch (_) {}
    };
    
    // === 核心状态 ===
    const callState = reactive({
        isActive: false,       
        isEnding: false,       // 挂断后短暂保留界面展示提示
        targetAgent: null,     
        localStream: null,     
        isMicMuted: false,     
        isCameraOff: false,    
        isAiSpeaking: false,   
        statusText: "正在建立连接...", 
        visionIntervalMs: 30000, 
        durationSec: 0,
        isInputBlocked: false,
        facingMode: 'user', // [新增] 'user'(前置) 或 'environment'(后置)
        // === 特效功能相关状态 ===
        showEffectDrawer: false,    // 控制上拉卡片显示
        selectedVideoUrl: null,     // 当前选择的视频URL
        selectedImageUrl: null,      // 当前选择的图片URL
        savedMedia: [],             // 保存的媒体列表
        isEditMode: false,          // 编辑模式状态
        videoUrlInput: '',          // 通过链接添加视频时的输入
        // === 按住说话（Push-to-Talk）兜底 ===
        sttFallbackMode: false,     // true = Web Speech 不可用，显示按住说话按钮
        isPTTRecording: false       // 正在按住录音中
    });

    // === 【新增】本次通话的短期记忆 (Session Memory) ===
    // 只在本次通话有效，挂断即清空，不存入数据库
    let sessionHistory = []; 
    const MAX_HISTORY_LENGTH = 50; // 记忆长度限制

    // === 防重入：确保一次只处理一轮交互 ===
    let interactionSeq = 0; // 递增 token，丢弃过期返回

    // === 视频通话专用：强力清洗模型输出，避免思维链/JSON/tool 残留外露 ===
    const tryExtractTextFromJson = (s) => {
        if (!s) return null;
        let t = String(s).trim();
        // 去掉代码围栏
        t = t.replace(/^```(?:json|JSON)?\s*/i, '').replace(/```$/g, '').trim();
        // 常见：整段就是 JSON
        try {
            const obj = JSON.parse(t);
            const pick = (o) => {
                if (!o || typeof o !== 'object') return null;
                const candidates = [
                    o.answer, o.final, o.response, o.content, o.text, o.output,
                    o?.data?.text, o?.data?.content,
                    o?.message?.content,
                    o?.choices?.[0]?.message?.content,
                    o?.choices?.[0]?.text
                ];
                for (const c of candidates) {
                    if (typeof c === 'string' && c.trim()) return c.trim();
                }
                return null;
            };
            return pick(obj);
        } catch (_) {
            // 尝试抽取第一段 {...} 再 parse
            const m = t.match(/\{[\s\S]*\}/);
            if (m && m[0]) {
                try {
                    const obj2 = JSON.parse(m[0]);
                    const c2 = obj2?.answer || obj2?.final || obj2?.response || obj2?.text || obj2?.content;
                    if (typeof c2 === 'string' && c2.trim()) return c2.trim();
                } catch (_) {}
            }
            return null;
        }
    };

    const cleanVideoCallReply = (raw) => {
        let text = (raw === null || raw === undefined) ? '' : String(raw);

        // 1) 去除思维链/分析块（多种常见格式）
        text = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
        text = text.replace(/<analysis>[\s\S]*?<\/analysis>/gi, '');
        text = text.replace(/\*\*思考\*\*[\s\S]*?\n\n/gi, '');
        text = text.replace(/【思考】[\s\S]*?【\/思考】/gi, '');

        // 2) 去掉代码块围栏，避免把 JSON 当正文读出来
        text = text.replace(/```[\s\S]*?```/g, (block) => {
            // 若代码块里是 JSON，尝试提取 answer/text；否则直接丢弃
            const extracted = tryExtractTextFromJson(block);
            return extracted ? extracted : '';
        });

        // 3) 若整体看起来是 JSON（或包含 JSON 且带 answer/text），尝试抽取正文
        const extractedWhole = tryExtractTextFromJson(text);
        if (extractedWhole) text = extractedWhole;

        // 4) 去除工具调用/函数调用残留
        text = text.replace(/\[TOOL_USE\][\s\S]*?\[\/TOOL_USE\]/gi, '');
        text = text.replace(/\[TOOL\][\s\S]*?\[\/TOOL\]/gi, '');
        text = text.replace(/\b(tool_calls?|function_call|tool_code)\b[\s\S]*$/gim, '');

        // 5) 去掉常见前缀
        text = text.replace(/^\s*(final|answer|回复|回答|assistant)\s*[:：]\s*/i, '');

        // 6) 压缩空白，取第一段（视频通话要短）
        text = text.replace(/\r/g, '').replace(/[ \t]{2,}/g, ' ').trim();
        const para = text.split(/\n{2,}/).map(s => s.trim()).filter(Boolean);
        if (para.length > 0) text = para[0];

        // 7) 极端情况：仍包含明显 JSON 键值形态，直接清空避免念出来
        if (/"\w+"\s*:/.test(text) || /\b\w+\s*:\s*\{/.test(text)) {
            text = '';
        }

        // 8) 限长（避免一口气说太多）
        if (text.length > 80) text = text.slice(0, 80);
        return text.trim();
    };

    // === 【新增】时间感知函数（照搬聊天框的实现） ===
    const getBeijingTime = () => {
        const now = new Date();
        const formatter = new Intl.DateTimeFormat('zh-CN', {
            timeZone: 'Asia/Shanghai',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            weekday: 'long',
            hour12: false // 使用24小时制
        });

        const parts = formatter.formatToParts(now);
        const year = parts.find(p => p.type === 'year').value;
        const month = parts.find(p => p.type === 'month').value;
        const day = parts.find(p => p.type === 'day').value;
        const hourNum = parseInt(parts.find(p => p.type === 'hour').value);
        const hour = String(hourNum).padStart(2, '0');
        const minute = parts.find(p => p.type === 'minute').value;
        const weekdayZh = parts.find(p => p.type === 'weekday').value;
        const weekdayMap = { '星期日': '日', '星期一': '一', '星期二': '二', '星期三': '三', '星期四': '四', '星期五': '五', '星期六': '六' };
        const weekday = weekdayMap[weekdayZh] || '日';

        return {
            date: `${year}年${month}月${day}日`,
            time: `${hour}:${minute}`,
            weekday: `星期${weekday}`,
            hour: hourNum,
            full: `${year}年${month}月${day}日 ${weekday} ${hour}:${minute}`
        };
    };

    // === 【新增】格式化时间戳函数（照搬聊天框的实现） ===
    const formatTimestampForAI = (timestamp) => {
        if (!timestamp) return '';
        const date = new Date(timestamp);
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        const seconds = String(date.getSeconds()).padStart(2, '0');
        return `[${year}-${month}-${day} ${hours}:${minutes}:${seconds}]`;
    };

    const { enqueue, clearQueue, isPlaying, unlockAudioContext } = useAudioQueue();
    
    // 监听播放状态
    watch(isPlaying, (val) => {
        callState.isAiSpeaking = val;
        
        if (val) {
            // AI 开始说话 -> 立即静音
            callState.isInputBlocked = true;
            callState.statusText = "对方正在说话...";
            if (silenceTimer) clearTimeout(silenceTimer);
            userTranscriptBuffer = ""; 
        } else {
            // AI 停止说话 -> 延迟 3 秒解除静音
            callState.statusText = "等待回声消除...";
            
            setTimeout(() => {
                if (callState.isActive) {
                    callState.isInputBlocked = false;
                    callState.statusText = "正在聆听...";
                    console.log("[Audio] 解除输入阻塞，开始聆听");
                }
            }, 3000); 
        }
    });

    let visionTimer = null;
    let durationTimer = null;
    let recognition = null;
    /** 遇到 not-allowed 等不可恢复错误时设为 true，不再自动重启 STT，避免刷屏 */
    let sttPermanentlyDisabled = false;

    // === 【修改点1】延长气口时间 ===
    // 2500ms (2.5秒) 的静音才算你说完了一段完整的话
    // 这样能把你的长难句一次性收录，避免AI抢话
    let silenceTimer = null;      
    let userTranscriptBuffer = ""; 
    const SILENCE_THRESHOLD = 2500; 

    // === 1. 媒体控制 ===
    const initMedia = async () => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ 
                video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
                audio: {
                    echoCancellation: true, 
                    noiseSuppression: true, 
                    autoGainControl: true   
                }
            });
            callState.localStream = stream;
            return stream;
        } catch (e) {
            console.error("[VideoCall] 媒体获取失败:", e);
            const errName = e?.name || 'MediaError';
            log('视频通话', 'error', `获取摄像头/麦克风失败: ${errName} - ${e?.message || e}`);
            alert("无法访问摄像头或麦克风，请检查权限。");
            endCall();
            return null;
        }
    };

    const toggleMic = () => {
        if (callState.localStream) {
            const track = callState.localStream.getAudioTracks()[0];
            if (track) {
                track.enabled = !track.enabled;
                callState.isMicMuted = !track.enabled;
            }
        }
    };

    const toggleCamera = () => {
        if (callState.localStream) {
            const track = callState.localStream.getVideoTracks()[0];
            if (track) {
                track.enabled = !track.enabled;
                callState.isCameraOff = !track.enabled;
            }
        }
    };

    // === [新增] 切换前后置摄像头 ===
    const switchCamera = async () => {
        if (callState.isCameraOff) {
            alert("请先开启摄像头");
            return;
        }

        if (callState.localStream) {
            callState.localStream.getVideoTracks().forEach(track => track.stop());
        }

        callState.facingMode = callState.facingMode === 'user' ? 'environment' : 'user';
        console.log(`[VideoCall] 切换摄像头至: ${callState.facingMode}`);
        log('视频通话', 'info', `切换摄像头: ${callState.facingMode === 'user' ? '前置' : '后置'}`);

        try {
            const newStream = await navigator.mediaDevices.getUserMedia({
                video: { 
                    facingMode: { exact: callState.facingMode },
                    width: { ideal: 640 }, 
                    height: { ideal: 480 } 
                },
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                }
            });

            callState.localStream = newStream;
            
            const audioTrack = newStream.getAudioTracks()[0];
            if (audioTrack) {
                audioTrack.enabled = !callState.isMicMuted;
            }

        } catch (e) {
            console.error("[VideoCall] 切换摄像头失败:", e);
            log('视频通话', 'error', `切换摄像头失败: ${e?.message || e}`);
            if (callState.facingMode === 'environment') {
                alert("切换失败：未找到后置摄像头");
                callState.facingMode = 'user';
                try {
                    const fallbackStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
                    callState.localStream = fallbackStream;
                } catch (_) {}
            }
        }
    };

    // === 2. 视觉分析 ===
    const captureAndAnalyze = async (manualTrigger = false) => {
        if (!callState.isActive || callState.isCameraOff) return;

        const videoEl = document.getElementById('local-user-video');
        if (!videoEl) return;

        try {
            const canvas = document.createElement('canvas');
            canvas.width = 512; 
            canvas.height = 512 * (videoEl.videoHeight / videoEl.videoWidth);
            const ctx = canvas.getContext('2d');
            ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
            const base64 = canvas.toDataURL('image/jpeg', 0.6);
            
            // 自动轮询时不触发对话，只做静默观察（或者你可以开启）
            if (!manualTrigger && !callState.isAiSpeaking) {
                callState.statusText = "正在观察环境...";
            }
            
            return base64; 
        } catch (e) {
            console.error("[VideoCall] 截图失败:", e);
            log('视频通话', 'warning', `截图失败: ${e?.message || e}`);
            return null;
        }
    };

    // === 3. 语音识别 (STT) ===
    const initSTT = () => {
        sttPermanentlyDisabled = false; // 每次进入通话重新尝试 STT
        // aborted 频繁出现通常代表该浏览器/机型的 Web Speech 不稳定：累计触发后切换到按住说话
        let abortedCount = 0;
        let abortedWindowStart = 0;
        let abortedNotified = false;
        if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
            log('视频通话', 'warning', '当前浏览器不支持语音识别（STT），将无法语音输入');
            return;
        }
        
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        recognition = new SpeechRecognition();
        recognition.continuous = true; 
        recognition.interimResults = true; 
        recognition.lang = 'zh-CN'; 

        recognition.onend = () => {
            if (!callState.isActive || sttPermanentlyDisabled) return;
            console.log("[STT] 自动重启...");
            // 小延迟避免某些浏览器 end->start 立刻 aborted
            setTimeout(() => {
                if (!callState.isActive || sttPermanentlyDisabled) return;
                try { recognition.start(); } catch (e) {
                    console.error("[STT] 自动重启失败:", e);
                    if (!sttPermanentlyDisabled) log('视频通话', 'warning', `STT 自动重启失败: ${e?.message || e}`);
                }
            }, 400);
        };

        // STT 错误：
        // - not-allowed 多为权限/环境限制：只记一次并停止重试，避免刷屏
        // - aborted 多为系统/焦点/并发导致的中断：应允许 onend 自动重启，不要永久禁用
        recognition.onerror = (event) => {
            const err = event?.error || 'unknown';
            if (err === 'not-allowed') {
                if (!sttPermanentlyDisabled) {
                    sttPermanentlyDisabled = true;
                    // 切换到按住说话兜底模式
                    callState.sttFallbackMode = true;
                    log('视频通话', 'warning', '免按键语音不可用，已切换为按住说话模式');
                    if (callState.isActive) callState.statusText = '请按住「说话」按钮发言';
                }
                return;
            }
            if (err === 'aborted') {
                const now = Date.now();
                if (!abortedWindowStart || (now - abortedWindowStart) > 8000) {
                    abortedWindowStart = now;
                    abortedCount = 0;
                }
                abortedCount += 1;
                // 8秒内 aborted >= 3 次：判定 Web Speech 不稳定，切换按住说话并停止重启
                if (abortedCount >= 3 && !callState.sttFallbackMode) {
                    sttPermanentlyDisabled = true;
                    callState.sttFallbackMode = true;
                    if (!abortedNotified) {
                        abortedNotified = true;
                        log('视频通话', 'warning', '检测到免按键语音频繁中断，已切换为按住说话模式');
                    }
                    if (callState.isActive) callState.statusText = '请按住「说话」按钮发言';
                    try { recognition.onend = null; recognition.stop(); } catch (_) {}
                    return;
                }
                // 轻量提示（log 内部对 warning 有去重保护）
                log('视频通话', 'warning', '语音识别被中断，正在尝试恢复…');
                return;
            }
            log('视频通话', 'error', `STT 错误: ${err}`);
        };
        recognition.onnomatch = () => {
            log('视频通话', 'warning', 'STT 未识别到有效语音');
        };

        recognition.onresult = (event) => {
            if (!callState.isActive) return;

            // 阻塞期间忽略
            if (callState.isInputBlocked) {
                userTranscriptBuffer = ""; 
                if (silenceTimer) clearTimeout(silenceTimer);
                return;
            }

            const result = event.results[event.results.length - 1];
            const transcript = result[0].transcript;

            callState.statusText = `聆听: ${transcript}`;

            if (result.isFinal) {
                if (callState.isInputBlocked) return;

                userTranscriptBuffer += transcript + "，";
                console.log(`[STT Buffer] 缓冲: ${userTranscriptBuffer}`);
                
                if (silenceTimer) clearTimeout(silenceTimer);
                
                // ⏳ 状态提示：让用户知道 AI 在等你说完
                callState.statusText = "聆听中...";

                silenceTimer = setTimeout(() => {
                    if (callState.isInputBlocked) return;

                    if (userTranscriptBuffer.trim().length > 0) {
                        const finalContent = userTranscriptBuffer;
                        userTranscriptBuffer = ""; 
                        // 将收集到的【完整段落】发给 AI
                        handleUserInteraction(finalContent); 
                    }
                }, SILENCE_THRESHOLD);
            }
        };

        try { recognition.start(); } catch (e) {
            console.error("[STT] 启动失败:", e);
            log('视频通话', 'error', `STT 启动失败: ${e?.message || e}`);
        }
    };

    // === 4. 交互逻辑 ===
    const handleUserInteraction = async (text) => {
        if (!callState.isActive) return;

        // 截图
        const currentFrame = await captureAndAnalyze(true); 

        // Prompt
        // 【关键】这里不需要手动拼凑历史，我们在 performAIInteraction 里统一处理
        // 30%概率主动挑起话题
        const shouldInitiateTopic = Math.random() < 0.3;
        const topicInstruction = shouldInitiateTopic 
            ? `\n【主动话题提示】如果对话氛围自然，可以结合你的记忆、人设或用户画面中的细节，自然地开启一个新话题。话题要自然过渡，不要生硬。`
            : '';
        
        const prompt = `[视频通话模式]
用户画面：[Image]
用户说："${text}"
${topicInstruction}

请直接回复，像真人视频通话一样自然。不要输出思考过程，口语化表达，简短精炼（10-30字）。`;
        
        // 传递用户文本，用于存入记忆
        await performAIInteraction(prompt, currentFrame, text);
    };

    // === 【修改点2】带记忆的 AI 请求 ===
    const performAIInteraction = async (prompt, imageBase64, originalUserText) => {
        if (!callState.isActive) return;

        callState.statusText = "思考中...";
        // 思考期间阻塞输入，避免用户继续说话触发并发请求
        callState.isInputBlocked = true;
        const mySeq = ++interactionSeq;

        try {
            // 1. 构建 System Prompt
            // 【关键修改】获取全局上下文
            let globalContext = "";
            if (typeof buildContext_Func === 'function' && callState.targetAgent) {
                globalContext = buildContext_Func(callState.targetAgent);
            }

            // === 【改进】时间感知计算（使用实际时间戳） ===
            const beijingTime = getBeijingTime();
            let timeAwarenessContext = "";
            let timeDiffDesc = "这是我们第一次对话。";

            // 找到用户之前的最后一条消息（用于计算时间间隔）
            const prevUserMsgs = sessionHistory.filter(m => m.role === 'user' && m.timestamp);
            if (prevUserMsgs.length > 0) {
                // 使用实际的时间戳计算时间间隔
                const lastUserMsg = prevUserMsgs[prevUserMsgs.length - 1];
                const lastUserMsgTime = lastUserMsg.timestamp;
                const nowTime = Date.now();
                const diffMs = nowTime - lastUserMsgTime;

                const minutes = Math.floor(diffMs / (1000 * 60));
                const hours = Math.floor(diffMs / (1000 * 60 * 60));
                const days = Math.floor(hours / 24);

                // 生成给 AI 的心理暗示（更细腻的情感层次）
                if (days > 60) {
                    timeAwarenessContext = `[内心戏：漫长的等待] 距离上次对话已经过去了 ${days} 天（将近 ${Math.floor(days / 30)} 个月）。
心理模拟：你可能会感到：
- 惊喜：终于回来了！
- 委屈：这么久都不理人家……
- 担心：是不是发生了什么事？
- 矜持：哼，现在才想起来找我
根据你的人设选择最符合性格的反应。绝对不要像什么都没发生一样平淡地打招呼。`;
                    timeDiffDesc = `⏰ 已分别 ${days} 天（约 ${Math.floor(days / 30)} 个月）`;
                } else if (days > 30) {
                    timeAwarenessContext = `[内心戏：久别重逢] 距离上次对话已经过去了 ${days} 天（超过一个月）。
心理模拟：这是一次"久别重逢"的场景。根据你的人设，你可能：
- 表现出强烈的思念
- 略带生气地质问
- 故作冷淡但暗自开心
用行动和语气表达情感，而不是直接说"我们一个月没说话了"。`;
                    timeDiffDesc = `⏰ 已分别 ${days} 天`;
                } else if (days >= 7) {
                    timeAwarenessContext = `[内心戏：一周未见] 距离上次对话已经过去了 ${days} 天。
心理模拟：就像一周没联系的朋友突然发消息。自然地询问最近发生了什么，带着"好久不见"的亲切感。`;
                    timeDiffDesc = `⏰ 已分别 ${days} 天`;
                } else if (days >= 3) {
                    timeAwarenessContext = `[内心戏：隔了几天] 距离上次对话过去了 ${days} 天。
心理模拟：像隔了几天再见的日常。可以自然提起"这几天"发生的事，体现时间流逝。`;
                    timeDiffDesc = `⏰ 已分别 ${days} 天`;
                } else if (days >= 1) {
                    timeAwarenessContext = `[内心戏：隔天对话] 距离上次对话过去了 ${days} 天。
心理模拟：就像昨天聊过，今天又来了。可以用"早/晚安"、"今天怎么样"等自然衔接。`;
                    timeDiffDesc = `⏰ 隔天对话`;
                } else if (hours >= 6) {
                    timeAwarenessContext = `[内心戏：当天间隔] 距离上次对话过去了 ${hours} 小时。
心理模拟：对方可能刚忙完回来。当前是${beijingTime.hour < 6 ? '凌晨' : beijingTime.hour < 12 ? '上午' : beijingTime.hour < 18 ? '下午' : '晚上'}，根据时间段调整语气。`;
                    timeDiffDesc = `⏰ 间隔 ${hours} 小时`;
                } else if (hours >= 1) {
                    timeAwarenessContext = `[内心戏：短暂间隔] 对话间隔了 ${hours} 小时左右。
心理模拟：就像中途有事离开了一会儿。自然衔接之前的话题。`;
                    timeDiffDesc = `⏰ 间隔 ${hours} 小时`;
                } else {
                    timeAwarenessContext = `[内心戏：连续对话] 对话正在热烈进行中（间隔 ${minutes} 分钟）。
心理模拟：保持热度和连贯性，紧接着上一句的话题深入聊下去。`;
                    timeDiffDesc = `💬 持续对话中`;
                }
            }

            // === 【新增】构建带时间戳的消息历史 ===
            const historyWithTimestamps = sessionHistory.map(msg => {
                if (!msg.timestamp) return msg; // 如果没有时间戳，直接返回
                const timePrefix = formatTimestampForAI(msg.timestamp);
                // 如果是文本消息，添加时间戳前缀
                if (typeof msg.content === 'string') {
                    return {
                        ...msg,
                        content: `${timePrefix} ${msg.content}`
                    };
                }
                // 如果是多模态消息（包含图片），在文本部分添加时间戳
                if (Array.isArray(msg.content)) {
                    const textPart = msg.content.find(c => c.type === 'text');
                    if (textPart) {
                        return {
                            ...msg,
                            content: msg.content.map(c => 
                                c.type === 'text' 
                                    ? { ...c, text: `${timePrefix} ${c.text}` }
                                    : c
                            )
                        };
                    }
                }
                return msg;
            });

            const systemMsg = { 
                role: 'system', 
                content: `你是${callState.targetAgent.nickname}，正在和用户进行视频通话。

【记忆上下文】
${globalContext}

【本次通话历史】
(见下方消息历史)

【当前时空环境】
当前时间：${beijingTime.full}
时段：${beijingTime.hour < 6 ? '凌晨' : beijingTime.hour < 12 ? '上午' : beijingTime.hour < 14 ? '中午' : beijingTime.hour < 18 ? '下午' : beijingTime.hour < 22 ? '晚上' : '深夜'}
${timeDiffDesc}

【时间与情感感知系统 (Time Awareness)】
${timeAwarenessContext}

【输出规范 - 必须严格遵守】

一、禁止事项（违反会导致对话不自然）
1. 禁止输出任何思考过程、推理步骤、分析过程
2. 禁止使用"我觉得"、"我认为"、"让我想想"、"我想想"、"嗯..."等思考性表达
3. 禁止使用Markdown格式（**、*、#、\`\`\`等）
4. 禁止使用代码块、列表、表格等格式化内容
5. 禁止分段输出，必须一次性说完

二、输出要求（确保对话自然真实）
1. 回复长度：10-30字，简短精炼
2. 输出格式：纯文本，就像说话一样
3. 语言风格：口语化，可以使用语气词（"嗯"、"啊"、"哦"、"诶"等）
4. 情感表达：可以自然地表达情绪、反应、好奇、关心等真实情感
5. 画面感知：如果用户画面有值得注意的细节（背景、表情、动作、物品等），可以自然地提及

三、对话方式（像真人视频通话）
1. 直接回应：看到用户说的话和画面，直接给出反应，不要先思考
2. 自然互动：像朋友视频聊天一样，可以问问题、表达看法、分享感受
3. 保持人设：根据你的记忆和人设特点，以真实对话的方式呈现
4. 话题过渡：如果主动开启新话题，要自然过渡，不要生硬切换

【主动话题规则】
- 当对话氛围自然、轻松时，有30%概率可以主动开启新话题
- 话题来源：你的记忆、人设特点、当前聊天环境、用户画面中的细节
- 话题示例：
  * 看到用户背景有书："你在看什么书？"
  * 根据记忆："上次说的那件事怎么样了？"
  * 画面细节："你那边天气怎么样？"
  * 人设相关："我最近在学...，你呢？"

【时间感知规则 - 必须严格遵守】
1. **默默感知时间，不要生硬报时**：
   - 你非常清楚时间过去了多久，要在语气中自然流露（比如久别重逢的热情、被冷落的委屈、或老朋友的自然寒暄）
   - 但**绝对不要**像报时器一样说"我们已经30天2小时没说话了"、"距离上次对话已经X天了"等
   - 除非用户主动问，否则不要汇报具体时间数字
   - 通过情感和语气体现时间感知，而不是直接说出来

2. **根据时间段调整语气**：
   - 当前是${beijingTime.hour < 6 ? '凌晨' : beijingTime.hour < 12 ? '上午' : beijingTime.hour < 14 ? '中午' : beijingTime.hour < 18 ? '下午' : beijingTime.hour < 22 ? '晚上' : '深夜'}
   - 根据时间段自然调整话题和语气（例如：早上可以问"吃早餐了吗"，晚上可以问"准备睡了吗"）
   - 但不要生硬地说"现在是晚上X点"

3. **消息时间戳说明**：
   - 聊天记录中每条消息前的 [YYYY-MM-DD HH:mm:ss] 是该消息的发送时间
   - 你可以通过这些时间戳感知对话的密度和时间流逝
   - 但不要在回复中提及这些时间戳格式，也不要直接引用时间戳

【回复示例】
❌ 错误示例："我觉得...让我想想...嗯，应该是这样..."
✅ 正确示例："哦，这样啊！那你现在感觉怎么样？"

记住：直接说话，不要思考，就像真人视频通话一样自然。` 
            };

            // 2. 构建 User Message
            const userMsg = { 
                role: 'user', 
                content: [
                    { type: 'text', text: prompt },
                    ...(imageBase64 ? [{ type: 'image_url', image_url: { url: imageBase64 } }] : [])
                ]
            };

            // 3. 【核心】拼接消息数组：System -> History -> Current User
            // 使用带时间戳的消息历史
            const messages = [systemMsg, ...historyWithTimestamps, userMsg];

            // 4. 调用 AI
            const responseText = await callAI_Func(messages, 200, 0.7, imageBase64 ? 'vision' : 'text');
            
            // 过期/被新一轮覆盖的返回，直接丢弃
            if (!callState.isActive || mySeq !== interactionSeq) return;

            if (responseText && responseText.trim().length > 0) {
                // 先强力清洗，避免把思维链/JSON 传给 TTS 或写入记忆
                const cleanedReply = cleanVideoCallReply(responseText);
                if (!cleanedReply) {
                    log('视频通话', 'warning', 'AI回复疑似包含思维链/JSON，已丢弃本轮输出');
                    if (callState.isActive) callState.statusText = "没听清，再说一遍？";
                    return;
                }

                // 5. 【改进】将本轮对话存入记忆（添加时间戳）
                const nowTimestamp = Date.now();
                if (originalUserText) {
                    sessionHistory.push({ 
                        role: 'user', 
                        content: originalUserText,
                        timestamp: nowTimestamp 
                    });
                }
                sessionHistory.push({ 
                    role: 'assistant', 
                    content: cleanedReply,
                    timestamp: Date.now() 
                });

                // 6. 【新增】限制记忆长度 (FIFO)
                // 限制为最近 50 条消息 (25轮)
                if (sessionHistory.length > MAX_HISTORY_LENGTH) {
                    // 删除最旧的，保留最新的
                    sessionHistory = sessionHistory.slice(sessionHistory.length - MAX_HISTORY_LENGTH);
                }

                callState.statusText = "准备说话...";
                const cleanText = cleanedReply;
                
                // 一次性发送 TTS
                const audioUrl = await callTTS_Func(cleanText, callState.targetAgent);
                if (!audioUrl) log('视频通话', 'warning', 'TTS 返回空音频，本轮可能无语音播放');
                
                if (callState.isActive && audioUrl) {
                    enqueue(audioUrl);
                }
            }

        } catch (e) {
            console.error("[VideoCall] 交互失败:", e);
            log('视频通话', 'error', `交互失败: ${e?.message || e}`);
            if(callState.isActive) callState.statusText = "连接抖动...";
        } finally {
            // 只有最后一轮才解除阻塞，避免并发错位
            if (callState.isActive && mySeq === interactionSeq && !callState.isAiSpeaking) {
                callState.isInputBlocked = false;
            }
        }
    };

    // === 5. 生命周期 ===
    const startCall = async (agent) => {
        console.log("[VideoCall startCall] 收到的 agent:", agent);
        console.log("[VideoCall startCall] agent.avatar:", agent?.avatar);
        console.log("[VideoCall startCall] agent.voiceId:", agent?.voiceId);
        
        // 🔴 核心修复：移动端音频激活
        // 必须放在 async 操作（如 initMedia）之前，确保是在点击事件的堆栈中直接执行
        unlockAudioContext(); 

        if (!agent) {
            console.error("[VideoCall startCall] agent 为空，无法启动通话");
            log('视频通话', 'error', '启动失败：未选择角色（agent为空）');
            return;
        }
        callState.targetAgent = agent;
        console.log("[VideoCall startCall] callState.targetAgent 设置完成:", callState.targetAgent);
        log('视频通话', 'info', `开始通话: ${agent.nickname || agent.id || '未知角色'}`);
        
        callState.isEnding = false;
        callState.isActive = true;
        callState.durationSec = 0;
        callState.statusText = "正在连接...";
        // 每次通话重置 STT 兜底状态
        callState.sttFallbackMode = false;
        callState.isPTTRecording = false;
        
        userTranscriptBuffer = "";
        sessionHistory = []; // 🔴 每次新通话，清空记忆

        // ✅ iOS 关键：必须在点击触发后，第一时间调用 getUserMedia（避免被判定为非用户手势）
        // 不要在 getUserMedia 之前 await 任何异步任务（如读取本地媒体选择）。
        const mediaPromise = initMedia(); // 内部会立刻触发 getUserMedia
        // 媒体选择加载可并行进行（不影响手势判定）
        const lastMediaPromise = loadLastSelectedMedia();

        await mediaPromise;
        await lastMediaPromise;
        initSTT();

        durationTimer = setInterval(() => {
            callState.durationSec++;
        }, 1000);

        visionTimer = setInterval(() => {
            if (callState.isActive) {
                captureAndAnalyze(false);
            }
        }, callState.visionIntervalMs);

        callState.statusText = "通话已连接";
        log('视频通话', 'success', '通话已连接');
    };

    const endCall = async () => {
        if (!callState.isActive) return;
        
        console.log("[VideoCall] 挂断，开始生成记忆...");
        log('视频通话', 'info', '通话结束：正在整理通话记录');
        callState.isEnding = true;
        callState.isInputBlocked = true;
        callState.statusText = "通话结束，正在归档记忆...";
        // 使所有在途交互失效，避免挂断后仍回写/继续播报
        interactionSeq++;
        const agent = callState.targetAgent;
        const duration = callState.durationSec;
        const timestamp = Date.now();

        // 先做资源清理/停止采集，避免 UI 已挂断但仍在继续识别/截图/播放
        // （界面会因 isEnding 保留一小段时间显示提示条）
        callState.isActive = false;
        if (silenceTimer) clearTimeout(silenceTimer);
        if (durationTimer) clearInterval(durationTimer);
        if (visionTimer) clearInterval(visionTimer);
        clearQueue();
        if (callState.localStream) {
            callState.localStream.getTracks().forEach(track => track.stop());
            callState.localStream = null;
        }
        if (recognition) {
            recognition.onend = null;
            recognition.stop();
            recognition = null;
        }
        
        // 1. 整理对话记录 (sessionHistory)
        const dialogue = sessionHistory
            .filter(m => m.role === 'user' || m.role === 'assistant')
            .map(m => `${m.role === 'user' ? '用户' : agent.nickname}: ${m.content}`)
            .join('\n');

        // 2. 只有当有对话且 agent 存在时才生成总结
        let didArchive = false;
        if (agent && dialogue.length > 10 && typeof saveMemory_Func === 'function' && typeof callAI_Func === 'function') {
            try {
                log('视频通话', 'info', '正在生成通话总结（记忆）');
                const summaryPrompt = [
                    { role: 'system', content: '你是一个记忆助理。请总结这段视频通话的关键内容、用户的情绪、以及双方约定的事项。' },
                    { role: 'user', content: `对话记录：\n${dialogue}\n\n请用一段简练的话总结（包含时间${new Date().toLocaleString()}），并提取关键信息。` }
                ];
                
                const summary = await callAI_Func(summaryPrompt, 300, 0.5);
                
                // 3. 保存记忆
                const memoryObj = {
                    id: 'vid_mem_' + Date.now(),
                    agentId: agent.id,
                    timestamp: timestamp,
                    duration: duration,
                    summary: summary,
                    rawTranscript: dialogue
                };
                
                saveMemory_Func(memoryObj);
                didArchive = true;
                console.log("[VideoCall] 记忆已保存");
                log('视频通话', 'success', `通话记忆已归档（时长 ${duration}s）`);
                
            } catch (e) {
                console.error("[VideoCall] 记忆生成失败:", e);
                log('视频通话', 'error', `通话记忆生成失败: ${e?.message || e}`);
            }
        } else {
            // 不改变原有流程：仅提示为什么未生成记忆
            if (!agent) log('视频通话', 'warning', '未生成通话记忆：agent为空');
            else if (dialogue.length <= 10) log('视频通话', 'warning', '未生成通话记忆：对话内容太少');
            else if (typeof saveMemory_Func !== 'function') log('视频通话', 'warning', '未生成通话记忆：缺少保存回调');
        }

        // 通知外部：让聊天对话框插入「通话结束」系统提示（无论是否归档）
        try {
            if (typeof onCallEnded_Func === 'function') {
                onCallEnded_Func({
                    agentId: agent?.id,
                    duration,
                    archived: didArchive
                });
            }
        } catch (_) {}

        // 提示条：给用户可见反馈（因为 overlay 会短暂保留）
        callState.statusText = didArchive
            ? `通话结束：记忆已归档（${duration}s）`
            : `通话结束（${duration}s）：本次未归档记忆`;
        log('视频通话', 'info', '通话已结束');

        userTranscriptBuffer = "";
        sessionHistory = [];
        callState.isInputBlocked = false; 
        
        // 清理特效相关状态（但不清除最后一次选择，下次通话时会自动加载）
        callState.selectedVideoUrl = null;
        callState.selectedImageUrl = null;
        callState.showEffectDrawer = false;

        // 让用户看到提示条再关闭界面
        await new Promise(r => setTimeout(r, 1200));
        callState.isEnding = false;
    };

    // === 6. 特效功能 ===
    const openEffectDrawer = () => {
        callState.showEffectDrawer = true;
        // 加载已保存的媒体
        loadSavedMedia();
    };

    const closeEffectDrawer = () => {
        callState.showEffectDrawer = false;
        // 关闭时退出编辑模式
        callState.isEditMode = false;
    };

    // 加载已保存的媒体
    const loadSavedMedia = async () => {
        try {
            // 使用全局 localforage
            const localforage = window.localforage || window.localForage;
            if (!localforage) {
                console.warn("[VideoCall] localforage 未找到，使用内存存储");
                callState.savedMedia = [];
                return;
            }
            const saved = await localforage.getItem('bear_call_media_library');
            if (saved && Array.isArray(saved)) {
                callState.savedMedia = saved;
            } else {
                callState.savedMedia = [];
            }
        } catch (e) {
            console.error("[VideoCall] 加载媒体库失败:", e);
            callState.savedMedia = [];
        }
    };

    // 保存最后一次选择的媒体
    const saveLastSelectedMedia = async (videoUrl, imageUrl) => {
        try {
            const localforage = window.localforage || window.localForage;
            if (!localforage) {
                console.warn("[VideoCall] localforage 未找到，无法保存最后一次选择");
                return;
            }
            const lastSelection = {
                videoUrl: videoUrl,
                imageUrl: imageUrl,
                timestamp: Date.now()
            };
            await localforage.setItem('bear_call_last_selection', lastSelection);
            console.log("[VideoCall] 最后一次选择已保存");
        } catch (e) {
            console.error("[VideoCall] 保存最后一次选择失败:", e);
        }
    };

    // 加载最后一次选择的媒体
    const loadLastSelectedMedia = async () => {
        try {
            const localforage = window.localforage || window.localForage;
            if (!localforage) {
                return;
            }
            const lastSelection = await localforage.getItem('bear_call_last_selection');
            if (lastSelection) {
                if (lastSelection.videoUrl) {
                    callState.selectedVideoUrl = lastSelection.videoUrl;
                    callState.selectedImageUrl = null;
                    console.log("[VideoCall] 已加载最后一次选择的视频");
                } else if (lastSelection.imageUrl) {
                    callState.selectedImageUrl = lastSelection.imageUrl;
                    callState.selectedVideoUrl = null;
                    console.log("[VideoCall] 已加载最后一次选择的照片");
                }
            }
        } catch (e) {
            console.error("[VideoCall] 加载最后一次选择失败:", e);
        }
    };

    // 是否移动端（用于避免大视频在移动端闪退）
    const isMobile = () => /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || (typeof window !== 'undefined' && window.innerWidth < 768);

    // 保存媒体到库
    const saveMediaToLibrary = async (url, type) => {
        try {
            const localforage = window.localforage || window.localForage;
            if (!localforage) {
                console.warn("[VideoCall] localforage 未找到，无法保存");
                return;
            }
            let thumbnail = url;
            if (type === 'video') {
                const isRemoteUrl = typeof url === 'string' && (url.startsWith('http://') || url.startsWith('https://'));
                // 远程 URL 不生成缩略图（CORS），移动端和大视频也不生成，避免内存问题
                if (!isRemoteUrl && !isMobile()) {
                    try {
                        thumbnail = await generateVideoThumbnail(url);
                    } catch (e) {
                        console.warn("[VideoCall] 缩略图生成失败，使用原URL:", e);
                    }
                }
            }
            const mediaItem = {
                id: 'media_' + Date.now(),
                type: type, // 'video' 或 'image'
                url: url,
                thumbnail: thumbnail,
                timestamp: Date.now()
            };
            
            callState.savedMedia.push(mediaItem);
            
            // 【关键修复】使用 JSON.parse/stringify 去除 Vue 的 Proxy 包装，确保存储纯净数据
            const dataToSave = JSON.parse(JSON.stringify(callState.savedMedia));
            await localforage.setItem('bear_call_media_library', dataToSave);
            console.log("[VideoCall] 媒体已保存到库");
        } catch (e) {
            console.error("[VideoCall] 保存媒体失败:", e);
        }
    };

    // 生成视频缩略图
    const generateVideoThumbnail = (videoUrl) => {
        return new Promise((resolve) => {
            const video = document.createElement('video');
            video.src = videoUrl;
            video.muted = true;
            video.playsInline = true;
            video.crossOrigin = 'anonymous';
            
            const handleLoadedData = () => {
                try {
                    video.currentTime = 0.1; // 取第一帧
                } catch (e) {
                    video.currentTime = 0;
                }
            };
            
            const handleSeeked = () => {
                try {
                    const canvas = document.createElement('canvas');
                    canvas.width = video.videoWidth || 320;
                    canvas.height = video.videoHeight || 240;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                    resolve(canvas.toDataURL('image/jpeg', 0.7));
                } catch (e) {
                    console.warn("[VideoCall] 生成缩略图失败:", e);
                    resolve(videoUrl); // 失败时返回原URL
                }
            };
            
            video.addEventListener('loadeddata', handleLoadedData);
            video.addEventListener('seeked', handleSeeked);
            video.onerror = () => {
                resolve(videoUrl); // 失败时返回原URL
            };
            
            // 超时保护
            setTimeout(() => {
                if (video.readyState < 2) {
                    resolve(videoUrl);
                }
            }, 3000);
        });
    };

    // 选择媒体文件
    const selectMediaFile = (file) => {
        return new Promise(async (resolve, reject) => {
            // 移动端限制视频大小，避免 base64 导致内存溢出闪退（约 15MB 建议上限）
            const MAX_VIDEO_SIZE_MOBILE = 15 * 1024 * 1024;
            if (file && isMobile() && file.type.startsWith('video/') && file.size > MAX_VIDEO_SIZE_MOBILE) {
                const ok = typeof confirm !== 'undefined' && confirm('视频较大，在手机上可能影响流畅度。建议选择 15MB 以内的视频，或使用照片。是否仍要添加？');
                if (!ok) {
                    reject(new Error('用户取消'));
                    return;
                }
            }
            const reader = new FileReader();
            reader.onload = async (e) => {
                try {
                    const url = e.target.result;
                    const type = file.type.startsWith('video/') ? 'video' : 'image';
                    
                    if (type === 'video') {
                        callState.selectedVideoUrl = url;
                        callState.selectedImageUrl = null;
                    } else {
                        callState.selectedImageUrl = url;
                        callState.selectedVideoUrl = null;
                    }
                    
                    // 退出编辑模式（如果处于编辑模式）
                    callState.isEditMode = false;
                    
                    // 自动保存到库
                    await saveMediaToLibrary(url, type);
                    // 保存最后一次选择
                    await saveLastSelectedMedia(type === 'video' ? url : null, type === 'image' ? url : null);
                    closeEffectDrawer();
                    resolve({ url, type });
                } catch (err) {
                    console.error("[VideoCall] 选择媒体失败:", err);
                    reject(err);
                }
            };
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(file);
        });
    };

    // 从库中选择媒体
    const selectMediaFromLibrary = async (mediaItem) => {
        // 编辑模式下不允许选择，只能删除
        if (callState.isEditMode) {
            return;
        }
        if (mediaItem.type === 'video') {
            callState.selectedVideoUrl = mediaItem.url;
            callState.selectedImageUrl = null;
        } else {
            callState.selectedImageUrl = mediaItem.url;
            callState.selectedVideoUrl = null;
        }
        // 保存最后一次选择
        await saveLastSelectedMedia(mediaItem.type === 'video' ? mediaItem.url : null, mediaItem.type === 'image' ? mediaItem.url : null);
        closeEffectDrawer();
    };

    // 清除选择的媒体（恢复默认头像）
    const clearSelectedMedia = () => {
        if (callState.isEditMode) {
            // 编辑模式下，点击"完成"退出编辑模式
            callState.isEditMode = false;
        } else {
            // 正常模式下，点击"清除选择"进入编辑模式
            callState.isEditMode = true;
        }
    };

    // 通过视频链接添加（不读文件，适合大视频 / 移动端）
    const addMediaByUrl = async () => {
        const raw = (callState.videoUrlInput || '').trim();
        if (!raw) {
            if (typeof alert !== 'undefined') alert('请输入视频链接');
            return;
        }
        if (!raw.startsWith('http://') && !raw.startsWith('https://')) {
            if (typeof alert !== 'undefined') alert('请输入以 http:// 或 https:// 开头的链接');
            return;
        }
        callState.selectedVideoUrl = raw;
        callState.selectedImageUrl = null;
        callState.isEditMode = false;
        callState.videoUrlInput = '';
        await saveMediaToLibrary(raw, 'video');
        await saveLastSelectedMedia(raw, null);
        closeEffectDrawer();
    };

    // 选择默认头像（恢复初始状态）
    const selectDefaultAvatar = async () => {
        callState.selectedVideoUrl = null;
        callState.selectedImageUrl = null;
        // 清除最后一次选择（保存为null）
        await saveLastSelectedMedia(null, null);
        if (callState.isEditMode) {
            callState.isEditMode = false;
        }
        closeEffectDrawer();
    };

    // 删除库中的媒体
    const deleteMediaFromLibrary = async (mediaId) => {
        // 只在编辑模式下允许删除
        if (!callState.isEditMode) {
            return;
        }
        try {
            const localforage = window.localforage || window.localForage;
            if (!localforage) {
                console.warn("[VideoCall] localforage 未找到，无法删除");
                return;
            }
            callState.savedMedia = callState.savedMedia.filter(m => m.id !== mediaId);
            
            // 【关键修复】使用 JSON.parse/stringify 去除 Vue 的 Proxy 包装，确保存储纯净数据
            const dataToSave = JSON.parse(JSON.stringify(callState.savedMedia));
            await localforage.setItem('bear_call_media_library', dataToSave);
            console.log("[VideoCall] 媒体已删除");
        } catch (e) {
            console.error("[VideoCall] 删除媒体失败:", e);
        }
    };

    // === 按住说话（Push-to-Talk）兜底：录音 → 上传 STT → 识别文字 → 走 AI ===
    let pttMediaRecorder = null;
    let pttChunks = [];

    const startPTT = () => {
        if (!callState.isActive || callState.isInputBlocked || callState.isPTTRecording) return;
        if (!callState.localStream) {
            log('视频通话', 'warning', '无法录音：麦克风流不可用');
            return;
        }
        // 只取音频轨道
        const audioTracks = callState.localStream.getAudioTracks();
        if (!audioTracks.length) {
            log('视频通话', 'warning', '无法录音：没有可用的音频轨道');
            return;
        }
        const audioStream = new MediaStream(audioTracks);
        pttChunks = [];
        // 优先 webm/opus，兼容性最好
        const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
            ? 'audio/webm;codecs=opus'
            : MediaRecorder.isTypeSupported('audio/webm')
                ? 'audio/webm'
                : 'audio/mp4';
        try {
            pttMediaRecorder = new MediaRecorder(audioStream, { mimeType });
        } catch (e) {
            log('视频通话', 'error', `录音器创建失败: ${e?.message || e}`);
            return;
        }
        pttMediaRecorder.ondataavailable = (e) => {
            if (e.data && e.data.size > 0) pttChunks.push(e.data);
        };
        pttMediaRecorder.onstop = async () => {
            if (!pttChunks.length) return;
            const blob = new Blob(pttChunks, { type: mimeType });
            pttChunks = [];
            callState.isPTTRecording = false;
            // 录音太短：直接提示并退出（避免用户“点一下没反应”的体感）
            if (blob.size < 1500) {
                log('视频通话', 'warning', '录音时间太短，请按住说话 1 秒以上');
                if (callState.isActive) callState.statusText = '录音太短，请按住 1 秒以上';
                return;
            }
            callState.statusText = '正在识别语音…';
            try {
                const text = await uploadAudioForSTT(blob);
                if (text && text.trim()) {
                    const finalText = text.trim();
                    log('视频通话', 'info', `按住说话识别结果: ${finalText.substring(0, 40)}…`);
                    // 和默认 STT 一样：先在界面上展示用户说的话
                    if (callState.isActive) callState.statusText = `聆听: ${finalText}`;
                    await handleUserInteraction(finalText);
                } else {
                    log('视频通话', 'warning', '语音识别返回空结果');
                    if (callState.isActive) callState.statusText = '没有听清，请再试一次';
                }
            } catch (e) {
                log('视频通话', 'error', `语音识别失败: ${e?.message || e}`);
                if (callState.isActive) callState.statusText = '识别失败，请重试';
            }
        };
        pttMediaRecorder.start(100); // 每100ms一个chunk
        callState.isPTTRecording = true;
        callState.statusText = '正在录音…松开发送';
        log('视频通话', 'info', '按住说话：开始录音');
    };

    const stopPTT = () => {
        if (pttMediaRecorder && pttMediaRecorder.state !== 'inactive') {
            // 松开立即恢复按钮颜色（不等 onstop）
            callState.isPTTRecording = false;
            callState.statusText = '正在识别语音…';
            pttMediaRecorder.stop();
            log('视频通话', 'info', '按住说话：录音结束，正在上传识别');
        }
    };

    /**
     * 上传音频到用户配置的 STT 接口
     * 接口规范：POST multipart/form-data，字段 file=音频文件
     * 返回 JSON: { text: "识别结果" }
     */
    const uploadAudioForSTT = async (blob) => {
        // 从 apiSettings 读取 STT 配置
        const sttUrl = apiSettings.sttUrl;
        const sttKey = apiSettings.sttKey || '';
        if (!sttUrl) {
            throw new Error('未配置语音识别(STT)接口地址，请在 API 设置中填写');
        }
        const formData = new FormData();
        const ext = blob.type.includes('webm') ? 'webm' : blob.type.includes('mp4') ? 'mp4' : 'ogg';
        formData.append('file', blob, `recording.${ext}`);
        formData.append('model', apiSettings.sttModel || 'whisper-1');
        formData.append('language', 'zh');

        const headers = {};
        if (sttKey) {
            headers['Authorization'] = `Bearer ${sttKey.replace(/[^\x00-\x7F]/g, '').trim()}`;
        }

        const res = await fetch(sttUrl, {
            method: 'POST',
            headers,
            body: formData
        });

        if (!res.ok) {
            const errText = await res.text().catch(() => '');
            throw new Error(`STT HTTP ${res.status}: ${errText.substring(0, 100)}`);
        }

        const data = await res.json();
        return data.text || data.result || data.transcript || '';
    };

    return {
        callState,
        startCall,
        endCall,
        toggleMic,
        toggleCamera,
        switchCamera, // [新增] 导出
        startPTT,     // 按住说话：开始录音
        stopPTT,      // 按住说话：停止录音并上传识别
        // 特效功能
        openEffectDrawer,
        closeEffectDrawer,
        selectMediaFile,
        selectMediaFromLibrary,
        clearSelectedMedia,
        deleteMediaFromLibrary,
        selectDefaultAvatar,
        addMediaByUrl
    };
}