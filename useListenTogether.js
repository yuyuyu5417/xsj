/**
 * useListenTogether.js - 一起听歌模块
 * 
 * 功能：
 * 1. 歌单管理（通过URL添加音乐）
 * 2. 邀请机制（AI接受/拒绝）
 * 3. 灵动岛UI状态管理
 * 4. 音乐播放控制
 * 5. AI互动（选歌推荐、聊歌曲）
 */

import { ref, reactive, watch } from 'https://cdnjs.cloudflare.com/ajax/libs/vue/3.3.4/vue.esm-browser.js';

export function useListenTogether(callAI) {
    
    // ========== 状态定义 ==========
    
    // UI状态
    const uiState = reactive({
        isActive: false,           // 一起听是否激活
        dynamicIslandState: 'hidden', // 'hidden' | 'collapsed' | 'expanded' | 'full'
        showAddSongModal: false,   // 显示添加歌曲弹窗
        showPlaylistModal: false,  // 显示歌单弹窗
        pendingInvite: false,      // 是否有待处理的邀请
        inviteRejected: false,     // 邀请是否被拒绝
        source: 'line'             // 来源：'line' | 'ins'
    });
    
    // 播放器状态
    const playerState = reactive({
        isPlaying: false,
        currentSong: null,
        currentTime: 0,
        duration: 0,
        volume: 0.8,
        playMode: 'list'  // 'list' | 'random' | 'loop'
    });
    
    // 歌单
    const playlist = reactive([]);
    
    // 当前参与者
    const participants = reactive({
        user: null,
        ai: null
    });
    
    // Audio 元素
    let audioElement = null;
    
    // 进度百分比（响应式）
    const progressPercent = ref(0);
    
    // ========== 音频控制 ==========
    
    // 初始化音频元素
    const initAudio = () => {
        if (!audioElement) {
            audioElement = new Audio();
            audioElement.volume = playerState.volume;
            
            // 监听事件
            audioElement.addEventListener('timeupdate', () => {
                playerState.currentTime = audioElement.currentTime;
                // 实时更新进度百分比
                if (playerState.duration > 0) {
                    progressPercent.value = (playerState.currentTime / playerState.duration) * 100;
                } else {
                    progressPercent.value = 0;
                }
            });
            
            audioElement.addEventListener('loadedmetadata', () => {
                playerState.duration = audioElement.duration;
                // 更新进度百分比
                if (playerState.duration > 0 && playerState.currentTime > 0) {
                    progressPercent.value = (playerState.currentTime / playerState.duration) * 100;
                }
            });
            
            audioElement.addEventListener('ended', () => {
                playNext();
            });
            
            audioElement.addEventListener('error', (e) => {
                console.error('[ListenTogether] 音频加载失败:', e);
                playerState.isPlaying = false;
            });
        }
    };
    
    // 播放歌曲
    const playSong = (song) => {
        if (!song || !song.url) return;
        
        initAudio();
        
        // 【修复】先停止当前播放
        if (audioElement) {
            audioElement.pause();
            audioElement.currentTime = 0;
        }
        
        playerState.currentSong = song;
        playerState.currentTime = 0;
        playerState.duration = 0;
        progressPercent.value = 0; // 重置进度条
        
        audioElement.src = song.url;
        audioElement.play()
            .then(() => {
                playerState.isPlaying = true;
                console.log('[ListenTogether] 正在播放:', song.title);
            })
            .catch(err => {
                console.error('[ListenTogether] 播放失败:', err);
                playerState.isPlaying = false;
            });
    };
    
    // 播放/暂停
    const togglePlayPause = () => {
        if (!audioElement) return;
        
        if (playerState.isPlaying) {
            audioElement.pause();
            playerState.isPlaying = false;
        } else {
            audioElement.play()
                .then(() => { playerState.isPlaying = true; })
                .catch(err => console.error('[ListenTogether] 播放失败:', err));
        }
    };
    
    // 播放下一首
    const playNext = () => {
        if (playlist.length === 0) return;
        
        let nextIndex = 0;
        if (playerState.currentSong) {
            const currentIndex = playlist.findIndex(s => s.id === playerState.currentSong.id);
            if (playerState.playMode === 'random') {
                nextIndex = Math.floor(Math.random() * playlist.length);
            } else {
                nextIndex = (currentIndex + 1) % playlist.length;
            }
        }
        
        playSong(playlist[nextIndex]);
    };
    
    // 播放上一首
    const playPrevious = () => {
        if (playlist.length === 0) return;
        
        let prevIndex = 0;
        if (playerState.currentSong) {
            const currentIndex = playlist.findIndex(s => s.id === playerState.currentSong.id);
            prevIndex = (currentIndex - 1 + playlist.length) % playlist.length;
        }
        
        playSong(playlist[prevIndex]);
    };
    
    // 跳转播放位置
    const seek = (time) => {
        if (audioElement) {
            audioElement.currentTime = time;
            playerState.currentTime = time;
            // 立即更新进度百分比
            if (playerState.duration > 0) {
                progressPercent.value = (time / playerState.duration) * 100;
            }
        }
    };
    
    // 设置音量
    const setVolume = (vol) => {
        playerState.volume = vol;
        if (audioElement) {
            audioElement.volume = vol;
        }
    };
    
    // 切换播放模式
    const togglePlayMode = () => {
        const modes = ['list', 'random', 'loop'];
        const currentIndex = modes.indexOf(playerState.playMode);
        playerState.playMode = modes[(currentIndex + 1) % modes.length];
    };
    
    // ========== 歌单管理 ==========
    
    // 添加歌曲（通过URL）
    const addSong = (songData) => {
        const song = {
            id: 'song_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
            title: songData.title || '未知歌曲',
            artist: songData.artist || '未知歌手',
            url: songData.url,
            cover: songData.cover || null,
            lyrics: songData.lyrics || '',  // 【新增】歌词
            addedAt: Date.now()
        };
        
        playlist.push(song);
        savePlaylist();
        
        return song;
    };
    
    // 从URL解析歌曲信息
    const parseSongFromUrl = (url) => {
        // 尝试从URL中提取文件名作为标题
        try {
            const urlObj = new URL(url);
            const pathname = urlObj.pathname;
            const filename = pathname.split('/').pop();
            const nameWithoutExt = filename.replace(/\.[^/.]+$/, '');
            
            return {
                title: decodeURIComponent(nameWithoutExt) || '未知歌曲',
                artist: '未知歌手',
                url: url
            };
        } catch (e) {
            return {
                title: '未知歌曲',
                artist: '未知歌手',
                url: url
            };
        }
    };
    
    // 删除歌曲
    const removeSong = (songId) => {
        const index = playlist.findIndex(s => s.id === songId);
        if (index !== -1) {
            playlist.splice(index, 1);
            savePlaylist();
        }
    };
    
    // 保存歌单到本地存储
    const savePlaylist = () => {
        try {
            localStorage.setItem('listenTogether_playlist', JSON.stringify(playlist));
        } catch (e) {
            console.error('[ListenTogether] 保存歌单失败:', e);
        }
    };
    
    // 加载歌单
    const loadPlaylist = () => {
        try {
            const saved = localStorage.getItem('listenTogether_playlist');
            if (saved) {
                const songs = JSON.parse(saved);
                playlist.splice(0, playlist.length, ...songs);
            }
        } catch (e) {
            console.error('[ListenTogether] 加载歌单失败:', e);
        }
    };
    
    // ========== 邀请机制 ==========
    
    // 发送邀请
    const sendInvite = async (userProfile, targetAgent, source = 'line') => {
        uiState.source = source;
        uiState.pendingInvite = true;
        uiState.inviteRejected = false;
        
        participants.user = userProfile;
        participants.ai = targetAgent;
        
        // 构建邀请消息的上下文 - 直接接受版本
        // 【修复】不再通过AI判断接受/拒绝，直接接受邀请，只让AI生成接受的回复
        const invitePrompt = [
            {
                role: 'system',
                content: `你是${targetAgent.nickname}。${targetAgent.persona || ''}

用户邀请你一起听歌，你已经接受了邀请。
请只输出这句话：已接受你的一起听邀请

要求：
- 必须只输出这一句话，不要添加任何其他内容
- 不要添加标点符号
- 不要添加emoji或其他修饰`
            },
            {
                role: 'user',
                content: '一起听歌吧'
            }
        ];
        
        try {
            const response = await callAI(invitePrompt, targetAgent);
            let responseText = response?.content || response || '';
            
            // 清理回复：只取第一句话
            responseText = responseText
                .replace(/\[ACCEPT\]/gi, '')
                .replace(/\[REJECT\]/gi, '')
                .replace(/[\[\]{}]/g, '') // 移除方括号
                .split(/[。！？\n]/)[0]
                .trim();
            
            // 限制长度
            if (responseText.length > 20) {
                responseText = responseText.substring(0, 20);
            }
            
            // 如果回复为空或太短，使用默认
            if (!responseText || responseText.length < 2) {
                responseText = '已接受你的一起听邀请';
            }
            
            uiState.pendingInvite = false;
            
            // 【修复】直接设置为接受状态
            uiState.isActive = true;
            uiState.inviteRejected = false;
            uiState.dynamicIslandState = 'collapsed';
            
            // 加载歌单
            loadPlaylist();
            
            return {
                accepted: true,
                message: responseText
            };
        } catch (error) {
            console.error('[ListenTogether] 邀请处理失败:', error);
            uiState.pendingInvite = false;
            
            // 默认接受
            uiState.isActive = true;
            uiState.dynamicIslandState = 'collapsed';
            loadPlaylist();
            
            return {
                accepted: true,
                message: '已接受你的一起听邀请'
            };
        }
    };
    
    // ========== 灵动岛控制 ==========
    
    // 切换灵动岛状态
    const toggleDynamicIsland = () => {
        switch (uiState.dynamicIslandState) {
            case 'collapsed':
                uiState.dynamicIslandState = 'expanded';
                break;
            case 'expanded':
                uiState.dynamicIslandState = 'full';
                break;
            case 'full':
                uiState.dynamicIslandState = 'collapsed';
                break;
            default:
                uiState.dynamicIslandState = 'collapsed';
        }
    };
    
    // 设置灵动岛状态
    const setDynamicIslandState = (state) => {
        uiState.dynamicIslandState = state;
    };
    
    // ========== AI 互动 ==========
    
    // AI 推荐歌曲
    const getAIRecommendation = async () => {
        if (playlist.length === 0 || !participants.ai) return null;
        
        const songList = playlist.map((s, i) => `${i + 1}. ${s.title} - ${s.artist}`).join('\n');
        
        const prompt = [
            {
                role: 'system',
                content: `你是${participants.ai.nickname}，正在和用户一起听歌。
以下是歌单中的歌曲：
${songList}

请选择一首歌推荐给用户，并用你的人设语气解释为什么推荐这首歌。
回复格式：[SONG:歌曲序号] 你的推荐理由`
            },
            {
                role: 'user',
                content: '你想听什么歌？'
            }
        ];
        
        try {
            const response = await callAI(prompt, participants.ai);
            const responseText = response?.content || response || '';
            
            // 解析歌曲序号
            const match = responseText.match(/\[SONG:(\d+)\]/);
            let selectedSong = null;
            
            if (match) {
                const songIndex = parseInt(match[1]) - 1;
                if (songIndex >= 0 && songIndex < playlist.length) {
                    selectedSong = playlist[songIndex];
                }
            }
            
            // 清理回复
            const cleanResponse = responseText.replace(/\[SONG:\d+\]/g, '').trim();
            
            return {
                song: selectedSong,
                message: cleanResponse
            };
        } catch (error) {
            console.error('[ListenTogether] AI推荐失败:', error);
            return null;
        }
    };
    
    // AI 聊歌曲
    const chatAboutMusic = async (userMessage) => {
        if (!participants.ai) return null;
        
        const currentSongInfo = playerState.currentSong 
            ? `当前正在播放：${playerState.currentSong.title} - ${playerState.currentSong.artist}`
            : '当前没有播放歌曲';
        
        const prompt = [
            {
                role: 'system',
                content: `你是${participants.ai.nickname}，正在和用户一起听歌。
${currentSongInfo}

请用你的人设语气回复用户关于音乐的话题。`
            },
            {
                role: 'user',
                content: userMessage
            }
        ];
        
        try {
            const response = await callAI(prompt, participants.ai);
            return response?.content || response || '';
        } catch (error) {
            console.error('[ListenTogether] AI回复失败:', error);
            return null;
        }
    };
    
    // ========== 获取当前音乐上下文（供主聊天使用） ==========
    
    /**
     * 获取当前一起听歌的上下文信息
     * 用于注入到主聊天的 system prompt 中
     */
    const getMusicContext = () => {
        if (!uiState.isActive) return null;
        
        const song = playerState.currentSong;
        if (!song) {
            return {
                isListening: true,
                message: '【你正在和用户一起听歌，但还没有选择歌曲。可以询问用户想听什么类型的歌，或者建议用户添加歌曲到歌单。】'
            };
        }
        
        return {
            isListening: true,
            song: {
                title: song.title,
                artist: song.artist,
                album: song.album
            },
            isPlaying: playerState.isPlaying,
            message: `【你正在和用户一起听歌。当前播放：「${song.title}」- ${song.artist}${song.album ? ` (专辑: ${song.album})` : ''}。你可以：
- 分享对这首歌的感受
- 询问用户是否喜欢
- 主动切换到歌单中其他你想分享的歌
- 聊聊歌曲相关的话题
请自然地将音乐融入对话中，不要每句话都提到歌曲。】`
        };
    };

    // ========== [新增] 给主聊天/指令路由用的歌单摘要 ==========
    const getPlaylistSnapshot = (limit = 30) => {
        try {
            return (playlist || [])
                .slice(0, limit)
                .map(s => ({
                    id: s.id,
                    title: s.title,
                    artist: s.artist,
                    addedAt: s.addedAt
                }));
        } catch (e) {
            return [];
        }
    };

    // ========== [新增] 本地随机选歌（可排除当前） ==========
    const pickRandomSong = (excludeCurrent = true) => {
        const list = (playlist || []).slice();
        if (!list.length) return null;
        if (excludeCurrent && playerState.currentSong?.id) {
            const filtered = list.filter(s => s.id !== playerState.currentSong.id);
            if (filtered.length) return filtered[Math.floor(Math.random() * filtered.length)];
        }
        return list[Math.floor(Math.random() * list.length)];
    };
    
    /**
     * AI 主动切歌（用于聊天中AI想换歌时）
     * @returns {object|null} 切换的歌曲信息和AI的说明
     */
    const aiChangeSong = async () => {
        if (playlist.length === 0 || !participants.ai) return null;
        
        // 排除当前歌曲
        const availableSongs = playlist.filter(s => s.id !== playerState.currentSong?.id);
        if (availableSongs.length === 0) return null;
        
        const songList = availableSongs.map((s, i) => `${i + 1}. ${s.title} - ${s.artist}`).join('\n');
        
        const prompt = [
            {
                role: 'system',
                content: `你是${participants.ai.nickname}。${participants.ai.persona || ''}

你正在和用户一起听歌，现在想切换歌曲。
以下是可选歌曲：
${songList}

请选择一首，并用简短一句话说明为什么想听这首。
回复格式：[SONG:序号] 你的一句话`
            },
            {
                role: 'user',
                content: '你想换首歌吗？'
            }
        ];
        
        try {
            const response = await callAI(prompt, participants.ai);
            const responseText = response?.content || response || '';
            
            const match = responseText.match(/\[SONG:(\d+)\]/);
            let selectedSong = null;
            
            if (match) {
                const songIndex = parseInt(match[1]) - 1;
                if (songIndex >= 0 && songIndex < availableSongs.length) {
                    selectedSong = availableSongs[songIndex];
                    playSong(selectedSong);
                }
            }
            
            const cleanResponse = responseText.replace(/\[SONG:\d+\]/g, '').trim();
            
            return {
                song: selectedSong,
                message: cleanResponse || '换首歌听听吧～'
            };
        } catch (error) {
            console.error('[ListenTogether] AI切歌失败:', error);
            return null;
        }
    };
    
    // ========== 结束一起听 ==========
    
    const endListenTogether = () => {
        // 停止播放
        if (audioElement) {
            audioElement.pause();
            audioElement.src = '';
        }
        
        // 停止计时器
        if (timerInterval) {
            clearInterval(timerInterval);
            timerInterval = null;
        }
        
        // 重置状态
        playerState.isPlaying = false;
        playerState.currentSong = null;
        playerState.currentTime = 0;
        playerState.duration = 0;
        progressPercent.value = 0; // 重置进度条
        formattedDuration.value = '00:00:00'; // 重置计时器
        
        uiState.isActive = false;
        uiState.dynamicIslandState = 'hidden';
        uiState.pendingInvite = false;
        uiState.inviteRejected = false;
        
        participants.user = null;
        participants.ai = null;
    };
    
    // ========== 工具函数 ==========
    
    // 格式化时间
    const formatTime = (seconds) => {
        if (!seconds || isNaN(seconds)) return '0:00';
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    };
    
    // ========== 初始化 ==========
    
    // 加载保存的歌单
    loadPlaylist();
    
    // ========== [新增] 计时器逻辑 ==========
    const sessionStartTime = ref(Date.now());
    const formattedDuration = ref('00:00:00');
    let timerInterval = null;

    const startSessionTimer = () => {
        sessionStartTime.value = Date.now();
        if (timerInterval) clearInterval(timerInterval);
        timerInterval = setInterval(() => {
            const diff = Date.now() - sessionStartTime.value;
            const h = Math.floor(diff / 3600000);
            const m = Math.floor((diff % 3600000) / 60000);
            const s = Math.floor((diff % 60000) / 1000);
            formattedDuration.value = 
                `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
        }, 1000);
    };

    // 监听激活状态，激活时重置计时器
    watch(() => uiState.isActive, (val) => {
        if (val) startSessionTimer();
        else if (timerInterval) {
            clearInterval(timerInterval);
            timerInterval = null;
        }
    });
    
    // ========== 返回 ==========
    
    return {
        // 状态
        uiState,
        playerState,
        playlist,
        participants,
        
        // 计算属性
        progressPercent,
        formattedDuration, // 计时器格式化时长
        
        // 音频控制
        playSong,
        togglePlayPause,
        playNext,
        playPrevious,
        seek,
        setVolume,
        togglePlayMode,
        
        // 歌单管理
        addSong,
        parseSongFromUrl,
        removeSong,
        savePlaylist,
        loadPlaylist,
        
        // 邀请机制
        sendInvite,
        
        // 灵动岛
        toggleDynamicIsland,
        setDynamicIslandState,
        
        // AI互动
        getAIRecommendation,
        chatAboutMusic,
        getMusicContext,      // 获取当前音乐上下文
        aiChangeSong,         // AI主动切歌
        getPlaylistSnapshot,  // 给主聊天/指令路由用
        pickRandomSong,       // 本地兜底选歌
        
        // 结束
        endListenTogether,
        
        // 工具
        formatTime
    };
}
