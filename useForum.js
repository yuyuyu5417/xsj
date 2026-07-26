/**
 * useForum.js - 论坛系统模块 v3.0
 * 
 * 功能：
 * 1. NPC 角色管理（用户自定义 + AI根据世界观自动生成）
 * 2. 论坛帖子生成与管理
 * 3. 多元化评论生成（楼层讨论、NPC互动）
 * 4. 半屏评论区卡片
 * 5. 用户回复时10个NPC回复机制
 */

import { ref, reactive, computed } from 'https://cdnjs.cloudflare.com/ajax/libs/vue/3.3.4/vue.esm-browser.js';

export function useForum(callAI, addLog = null) {
    // 轻量日志：只记重点（错误/关键状态），避免刷屏
    const log = (status, detail) => {
        try {
            if (typeof addLog === 'function') addLog('论坛', status, detail);
        } catch (_) {}
    };

    // 统一走 forum source：开启副API时论坛优先走副API（不影响 UI/UX）
    const callForumAI = (messages, maxTokens = 10000, temp = 0.8) => {
        return callAI(messages, maxTokens, temp, 'text', 0, 'forum');
    };
    
    // ========== 数据结构 ==========
    
    const customNPCs = reactive([]);
    const systemNPCs = reactive([]);
    const forumPosts = reactive([]);
    
    // UI 状态
    const uiState = reactive({
        showNPCManager: false,
        showNPCCreator: false,
        showPostGenerator: false,
        showCommentSheet: false,      // 半屏评论区
        isGenerating: false,
        isSubmittingComment: false,   // 是否正在提交评论
        generatingProgress: ''
    });
    
    // 当前评论相关（使用 reactive 以便模板直接访问）
    const commentState = reactive({
        currentPost: null,     // 当前查看评论的帖子
        replyTarget: null,     // 回复目标（评论或null）
        inputText: ''          // 评论输入内容
    });
    
    // NPC 创建器数据
    const npcCreatorData = reactive({
        name: '',
        bio: '',
        personality: '',
        interestsText: ''
    });
    
    // 生成器设置
    const generatorSettings = reactive({
        selectedWorldBook: null,
        postGenerateCount: 5,
        commentMinCount: 3,
        commentMaxCount: 10
    });
    
    // ========== 工具函数 ==========
    
    const generateRandomAvatar = () => {
        const seed = Math.random().toString(36).substring(7);
        return `https://api.dicebear.com/7.x/avataaars/svg?seed=${seed}`;
    };
    
    const formatTimeAgo = (timestamp) => {
        const now = Date.now();
        const diff = now - timestamp;
        const seconds = Math.floor(diff / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);
        
        if (days > 0) return `${days}天前`;
        if (hours > 0) return `${hours}小时前`;
        if (minutes > 0) return `${minutes}分钟前`;
        return '刚刚';
    };
    
    const generateUsername = (name) => {
        const suffix = Math.random().toString(36).substring(2, 8);
        return `@${(name || 'user').replace(/\s+/g, '').toLowerCase()}${suffix}`;
    };
    
    const getRandomInRange = (min, max) => {
        const safeMin = Math.max(0, min || 0);
        const safeMax = Math.max(safeMin, max || safeMin);
        return Math.floor(Math.random() * (safeMax - safeMin + 1)) + safeMin;
    };
    
    const parseAIResponse = (response, defaultValue = {}) => {
        try {
            const text = typeof response === 'string' ? response : (response?.content || String(response || ''));
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            if (jsonMatch) return JSON.parse(jsonMatch[0]);
            return JSON.parse(text);
        } catch (e) {
            return defaultValue;
        }
    };
    
    const cleanAIText = (response) => {
        const text = typeof response === 'string' ? response : (response?.content || String(response || ''));
        if (text.trim().startsWith('{')) {
            const parsed = parseAIResponse(text, null);
            if (parsed && parsed.content) return parsed.content;
        }
        return text.replace(/```json|```/g, '').trim();
    };
    
    const getCleanContent = (content) => {
        if (!content) return '';
        return content.replace(/(#[\u4e00-\u9fa5a-zA-Z0-9_]+\s*)+$/g, '').trim();
    };
    
    // ========== NPC 管理 ==========
    
    const getAllNPCs = computed(() => [...customNPCs, ...systemNPCs]);
    
    const createCustomNPC = (npcData) => {
        const newNPC = {
            id: 'npc_custom_' + Date.now(),
            type: 'custom',
            name: npcData.name,
            username: generateUsername(npcData.name),
            avatar: npcData.avatar || generateRandomAvatar(),
            bio: npcData.bio || '',
            personality: npcData.personality || '',
            interests: npcData.interests || [],
            createdAt: Date.now()
        };
        customNPCs.push(newNPC);
        return newNPC;
    };
    
    const deleteCustomNPC = (npcId) => {
        const index = customNPCs.findIndex(npc => npc.id === npcId);
        if (index > -1) customNPCs.splice(index, 1);
    };
    
    const openNPCCreator = () => {
        Object.assign(npcCreatorData, { name: '', bio: '', personality: '', interestsText: '' });
        uiState.showNPCCreator = true;
    };
    
    const closeNPCCreator = () => { uiState.showNPCCreator = false; };
    
    const submitNPCCreator = () => {
        if (!npcCreatorData.name.trim()) return;
        const interests = npcCreatorData.interestsText.split(/[,，、]/).map(s => s.trim()).filter(Boolean);
        createCustomNPC({
            name: npcCreatorData.name.trim(),
            bio: npcCreatorData.bio.trim(),
            personality: npcCreatorData.personality.trim(),
            interests
        });
        closeNPCCreator();
    };
    
    // ========== NPC 昵称模板（多样化）==========
    
    const NPC_NAME_TEMPLATES = [
        // 现代都市风格
        ['深夜咖啡客', '都市夜归人', '地铁观察者', '写字楼社畜', '便利店常客', '夜班司机', '外卖小哥', '程序员小张'],
        // 文艺风格
        ['诗与远方', '书虫小雅', '胶片时光', '音乐盒', '画布上的猫', '文字流浪者', '光影记录者'],
        // 生活化风格
        ['隔壁老王', '楼下小卖部', '楼上邻居', '小区保安', '遛狗大爷', '广场舞大妈', '菜市场阿姨'],
        // 网络风格
        ['吃瓜群众', '摸鱼达人', '社恐患者', '拖延症晚期', '熬夜冠军', '佛系青年', '打工人'],
        // 职业风格
        ['设计师小李', '产品经理小王', '运营小刘', '市场小陈', 'HR小周', '财务小吴', '法务小郑'],
        // 兴趣风格
        ['游戏玩家', '电影爱好者', '音乐发烧友', '摄影小白', '健身新手', '旅行背包客', '美食探索者'],
        // 抽象风格
        ['云朵', '星星', '月亮', '风', '雨', '雪', '海', '山', '树', '花'],
        // 数字+字母风格（Twitter风格）
        ['user2024', 'talker_01', 'viewer_99', 'poster_xyz', 'commenter_a', 'replier_b']
    ];
    
    // 随机生成多样化昵称
    const generateDiverseName = (worldBook) => {
        // 70%概率使用模板，30%概率让AI生成
        if (Math.random() < 0.7) {
            const category = NPC_NAME_TEMPLATES[Math.floor(Math.random() * NPC_NAME_TEMPLATES.length)];
            const name = category[Math.floor(Math.random() * category.length)];
            // 随机添加数字或字母后缀（20%概率）
            if (Math.random() < 0.2) {
                const suffix = Math.random() < 0.5 
                    ? Math.floor(Math.random() * 1000) 
                    : String.fromCharCode(65 + Math.floor(Math.random() * 26));
                return name + suffix;
            }
            return name;
        }
        return null; // 返回null表示需要AI生成
    };
    
    // ========== AI 生成 NPC ==========
    
    const generateWorldNPC = async (worldBook) => {
        try {
            let worldContent = '现代都市背景';
            if (worldBook?.entries?.length) {
                worldContent = worldBook.entries.map(e => e.content || '').filter(Boolean).join('\n') || worldContent;
            }
            
            // 先尝试使用模板生成
            let npcName = generateDiverseName(worldBook);
            
            // 如果模板返回null，使用AI生成
            if (!npcName) {
                const prompt = [
                    {
                        role: 'system',
                        content: `根据世界观生成一个论坛用户昵称。

【世界观】
${worldContent}

要求：
1. 昵称2-6字，符合世界观
2. 可以是：职业+名字、兴趣+描述、抽象词汇、网络用语等
3. 避免重复"晚风"、"路人"等常见词
4. 要有创意和多样性
5. 不用emoji

直接输出昵称，不要其他内容。`
                    },
                    { role: 'user', content: '生成一个用户昵称' }
                ];
                
                const response = await callForumAI(prompt, 100);
                npcName = cleanAIText(response).trim() || '用户' + Math.floor(Math.random() * 1000);
            }
            
            // 生成简介和性格
            const bioPrompt = [
                {
                    role: 'system',
                    content: `用户昵称：${npcName}

生成这个用户的简介和性格。

要求：
1. 简介10-30字
2. 性格2-3词
3. 符合昵称风格
4. 不用emoji

输出JSON：{"bio":"简介","personality":"性格"}`
                },
                { role: 'user', content: '生成简介和性格' }
            ];
            
            const bioResponse = await callForumAI(bioPrompt, 200);
            const bioData = parseAIResponse(bioResponse, { bio: '论坛用户', personality: '随和' });
            
            const newNPC = {
                id: 'npc_system_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
                type: 'system',
                name: npcName,
                username: generateUsername(npcName),
                avatar: generateRandomAvatar(),
                bio: bioData.bio || '论坛用户',
                personality: bioData.personality || '随和',
                interests: [],
                worldBookId: worldBook?.id || null,
                createdAt: Date.now()
            };
            
            systemNPCs.push(newNPC);
            return newNPC;
        } catch (error) {
            console.error('[Forum] 生成 NPC 失败:', error);
            // 失败时使用模板
            const category = NPC_NAME_TEMPLATES[Math.floor(Math.random() * NPC_NAME_TEMPLATES.length)];
            const fallbackName = category[Math.floor(Math.random() * category.length)];
            
            const fallbackNPC = {
                id: 'npc_system_' + Date.now(),
                type: 'system',
                name: fallbackName,
                username: '@user' + Math.random().toString(36).substr(2, 6),
                avatar: generateRandomAvatar(),
                bio: '论坛用户',
                personality: '随和',
                interests: [],
                createdAt: Date.now()
            };
            systemNPCs.push(fallbackNPC);
            return fallbackNPC;
        }
    };
    
    // ========== 帖子生成 ==========
    
    const generateForumPost = async (worldBook, commentCount) => {
        try {
            let npc;
            if (customNPCs.length > 0 && Math.random() < 0.3) {
                npc = customNPCs[Math.floor(Math.random() * customNPCs.length)];
            } else {
                npc = await generateWorldNPC(worldBook);
            }
            if (!npc) return null;
            
            let worldContent = '现代都市背景';
            if (worldBook?.entries?.length) {
                worldContent = worldBook.entries.map(e => e.content || '').filter(Boolean).join('\n') || worldContent;
            }
            
            const postPrompt = [
                {
                    role: 'system',
                    content: `你是 ${npc.name}，${npc.bio || '论坛用户'}，性格${npc.personality || '随和'}。

【世界观】
${worldContent}

以推特风格发帖，50-200字，可加1-3个#标签，不用emoji，直接输出内容。`
                },
                { role: 'user', content: '发帖' }
            ];
            
            const response = await callForumAI(postPrompt, 10000);
            const content = cleanAIText(response);
            const hashtagMatches = content.match(/#[\u4e00-\u9fa5a-zA-Z0-9_]+/g) || [];
            const hashtags = [...new Set(hashtagMatches.map(tag => tag.replace('#', '')))].slice(0, 3);
            
            const newPost = {
                id: 'post_' + Date.now(),
                type: 'forum',
                authorId: npc.id,
                authorName: npc.name,
                authorUsername: npc.username || generateUsername(npc.name),
                authorAvatar: npc.avatar,
                authorBio: npc.bio,
                content: content || '分享一些想法...',
                hashtags,
                timestamp: Date.now(),
                likes: Math.floor(Math.random() * 50),
                retweets: Math.floor(Math.random() * 20),
                views: Math.floor(Math.random() * 200) + 50,
                comments: [],
                worldBookId: worldBook?.id || null
            };
            
            if (commentCount > 0) await generateDiverseComments(newPost, commentCount, worldBook);
            
            forumPosts.unshift(newPost);
            return newPost;
        } catch (error) {
            console.error('[Forum] 生成帖子失败:', error);
            log('error', `生成帖子失败：${error?.message || error}`);
            return null;
        }
    };
    
    // ========== 多元化评论生成 ==========
    
    const COMMENT_PERSPECTIVES = [
        '表示强烈赞同，分享类似经历',
        '提出不同看法，礼貌质疑',
        '追问细节，表示好奇',
        '分享相关知识或建议',
        '调侃或幽默回应',
        '表达同情或理解',
        '分享自己的故事',
        '表示羡慕或向往',
        '提出实用建议',
        '纯粹围观吃瓜'
    ];
    
    const generateDiverseComments = async (post, count, worldBook) => {
        if (!post.comments) post.comments = [];
        const safeCount = Math.min(count, 30);

        // 一次性生成评论区（类似 INS 评论区的批量 JSON 输出），减少 callAI 次数
        // 说明：这里不再为每条评论单独生成 NPC（避免 generateWorldNPC 内部再次 callAI），改为一次性生成“昵称+内容+楼中楼关系”，再本地补齐头像/用户名等字段。
        try {
            let worldContent = '现代都市背景';
            if (worldBook?.entries?.length) {
                worldContent = worldBook.entries.map(e => e.content || '').filter(Boolean).join('\n') || worldContent;
            }

            const perspectivesText = COMMENT_PERSPECTIVES.map((p, i) => `${i + 1}. ${p}`).join('\n');
            const prompt = `你是一个论坛评论区模拟器。

【世界观】
${worldContent}

【原帖】
${post.authorName || '帖主'}说：${String(post.content || '').slice(0, 300)}

【任务】
生成 ${safeCount} 条评论数据，营造真实讨论氛围（粉丝/路人/杠精/朋友等）。

【关键要求】
1. 必须包含几组“楼中楼互动”：通过 reply_id 指向之前的 id（至少 25% 的评论是回复别人）
2. 语气多样：简短/长一点/追问/反驳/玩梗都要有
3. 不要 emoji，不要 Markdown，不要引号
4. 单条评论 10-60 字
5. 昵称 2-6 字，风格多样，不要都叫“路人/用户”
6. 评论角度可参考（自行混合使用）：\n${perspectivesText}

【输出格式】
只输出 JSON 数组，不要任何额外文字：
[
  { "id": 1, "name": "momo", "content": "好真实…我也有同感。", "reply_id": null },
  { "id": 2, "name": "吃瓜群众", "content": "细说？后续呢？", "reply_id": 1 }
]`;

            const raw = await callForumAI([{ role: 'user', content: prompt }], 10000, 0.8);
            const jsonText = String(raw || '').replace(/```json/gi, '').replace(/```/g, '').trim();
            const list = JSON.parse(jsonText);
            if (!Array.isArray(list)) throw new Error('评论生成返回非数组');

            const picked = list.slice(0, safeCount);
            const baseTime = Date.now();
            const finalComments = picked.map((c, idx) => {
                const name = String(c?.name || '').trim() || `网友${idx + 1}`;
                const content = String(c?.content || '').trim() || '说得对！';
                const tempId = Number.isFinite(Number(c?.id)) ? Number(c.id) : (idx + 1);
                const replyTemp = (c?.reply_id === null || c?.reply_id === undefined || c?.reply_id === '') ? null : Number(c.reply_id);

                return {
                    id: `comment_${baseTime}_${idx}_${Math.random().toString(36).slice(2, 6)}`,
                    tempId,
                    authorId: `npc_batch_${baseTime}_${idx}`,
                    authorName: name,
                    authorUsername: generateUsername(name),
                    authorAvatar: `https://api.dicebear.com/7.x/notionists/svg?seed=${encodeURIComponent(name)}`,
                    content,
                    replyTo: null,
                    replyToId: replyTemp, // 先存临时数字，后续再映射
                    replyToContent: null,
                    timestamp: Date.now() - Math.floor(Math.random() * 3600000),
                    likes: Math.floor(Math.random() * 15),
                    replies: []
                };
            });

            // 映射 reply_id -> 真实 comment.id
            finalComments.forEach(c => {
                if (c.replyToId === null) return;
                const target = finalComments.find(t => t.tempId === c.replyToId);
                if (target) {
                    c.replyTo = target.authorName;
                    c.replyToContent = target.content;
                    c.replyToId = target.id;
                } else {
                    c.replyToId = null;
                }
                delete c.tempId;
            });
            // 删除未走过映射的 tempId
            finalComments.forEach(c => { if (c.tempId !== undefined) delete c.tempId; });

            post.comments.push(...finalComments);
        } catch (error) {
            console.error('[Forum] 批量生成评论失败，使用本地兜底:', error);
            log('warning', `评论批量生成失败：${error?.message || error}`);
            // 兜底：不调用 AI，生成少量本地评论，避免完全空评论
            const fallbackNames = ['路过的', '围观群众', '有一说一', '我觉得', '哈哈哈', '认真脸'];
            for (let i = 0; i < safeCount; i++) {
                const name = fallbackNames[i % fallbackNames.length] + (i % 2 === 0 ? '' : String(Math.floor(Math.random() * 100)));
                post.comments.push({
                    id: 'comment_fb_' + Date.now() + '_' + i,
                    authorId: 'npc_fallback_' + i,
                    authorName: name,
                    authorUsername: generateUsername(name),
                    authorAvatar: `https://api.dicebear.com/7.x/notionists/svg?seed=${encodeURIComponent(name)}`,
                    content: ['说得对！', '细说！', '有点意思。', '同感同感。', '我也遇到过。'][i % 5],
                    replyTo: null,
                    replyToId: null,
                    replyToContent: null,
                    timestamp: Date.now() - Math.floor(Math.random() * 3600000),
                    likes: Math.floor(Math.random() * 15),
                    replies: []
                });
            }
        }
    };
    
    // ========== 用户回复功能 ==========
    
    const submitComment = async (userProfile) => {
        if (!commentState.inputText.trim() || !commentState.currentPost) return;
        
        uiState.isSubmittingComment = true;
        
        try {
            // 1. 添加用户的评论
            const replyTarget = commentState.replyTarget;
            const userComment = {
                id: 'comment_user_' + Date.now(),
                authorId: 'user',
                authorName: userProfile.nickname || userProfile.name || '我',
                authorUsername: '@me',
                authorAvatar: userProfile.avatar,
                content: commentState.inputText.trim(),
                replyTo: replyTarget ? replyTarget.authorName : null,
                replyToId: replyTarget ? replyTarget.id : null,
                replyToContent: replyTarget ? replyTarget.content : null, // 引用内容
                timestamp: Date.now(),
                likes: 0,
                isUser: true,
                replies: []
            };
            
            // 确保评论数组存在
            if (!commentState.currentPost.comments) {
                commentState.currentPost.comments = [];
            }
            commentState.currentPost.comments.push(userComment);
            
            const userText = commentState.inputText.trim();
            const targetName = commentState.replyTarget ? commentState.replyTarget.authorName : null;
            const currentPost = commentState.currentPost;
            
            // 清空输入
            commentState.inputText = '';
            commentState.replyTarget = null;
            
            // 2. 生成10个NPC回复（后台执行）
            generateNPCResponsesAfterUserComment(
                currentPost,
                userComment,
                userText,
                targetName
            ).catch(err => console.error('[Forum] NPC回复生成失败:', err));
            
        } catch (error) {
            console.error('[Forum] 提交评论失败:', error);
        } finally {
            uiState.isSubmittingComment = false;
        }
    };
    
    // 【修改】用户评论后：1) 楼主百分百回复用户 2) 可能随机回复一个NPC（回复楼主） 3) 其他NPC引用和单独发消息比例1:1
    const generateNPCResponsesAfterUserComment = async (post, userComment, userText, replyToName) => {
        const worldBook = generatorSettings.selectedWorldBook;
        const authorName = post.authorName || '帖主';
        const authorId = post.authorId;
        const userDisplay = userComment.authorName || '用户';
        const baseTime = Date.now();

        // 轻量抽取世界观文本
        let worldContent = '现代都市背景';
        if (worldBook?.entries?.length) {
            worldContent = worldBook.entries.map(e => e.content || '').filter(Boolean).join('\n') || worldContent;
        }

        const authorMeta = {
            id: authorId || ('author_' + post.id),
            name: authorName,
            username: post.authorUsername || ('@' + authorName),
            avatar: post.authorAvatar,
            bio: post.authorBio || ''
        };

        // 生成 4-6 条其他 NPC 回复（与旧逻辑一致的数量级）
        const otherNpcCount = 4 + Math.floor(Math.random() * 3); // 4-6
        const shouldNpcReplyOwner = Math.random() < 0.5;
        const totalNpc = otherNpcCount + (shouldNpcReplyOwner ? 1 : 0);

        // 一次性生成：楼主回复 + N 条 NPC（含楼中楼关系）
        try {
            const prompt = `你是论坛评论区模拟器。

【世界观】
${worldContent}

【原帖】
${authorName}：${String(post.content || '').slice(0, 200)}

【用户评论（ID=0）】
${userDisplay}：${String(userText || '').slice(0, 160)}

【任务】
1) 生成 1 条“楼主回复用户”的评论（type=owner，必须 reply_id=0，10-50字）
2) 生成 ${totalNpc} 条“NPC评论”（type=npc，必须包含不少于 40% 的楼中楼：reply_id 指向 0 或 owner 或其他 npc）

【硬性要求】
- 不要 emoji，不要 Markdown，不要引号
- 单条 10-60 字
- NPC 昵称 2-6 字，风格多样，不要都叫“路人/用户”
- 输出必须是 JSON 数组，不要任何额外文字

【JSON结构】
[
  { "id": 1, "type": "owner", "content": "…", "reply_id": 0 },
  { "id": 2, "type": "npc", "name": "momo", "content": "…", "reply_id": 1 },
  { "id": 3, "type": "npc", "name": "吃瓜群众", "content": "…", "reply_id": null }
]`;

            const raw = await callForumAI([{ role: 'user', content: prompt }], 10000, 0.85);
            const jsonText = String(raw || '').replace(/```json/gi, '').replace(/```/g, '').trim();
            const list = JSON.parse(jsonText);
            if (!Array.isArray(list) || list.length === 0) throw new Error('NPC回复生成返回空数组');

            const ownerItem = list.find(x => String(x?.type || '').toLowerCase() === 'owner') || list[0];
            const ownerReplyText = String(ownerItem?.content || '').trim() || '谢谢你的评论～';

            // 先插入楼主回复（保持原字段结构）
            const ownerCommentId = 'comment_owner_' + baseTime;
            const ownerComment = {
                id: ownerCommentId,
                authorId: authorMeta.id,
                authorName: authorMeta.name,
                authorUsername: authorMeta.username,
                authorAvatar: authorMeta.avatar,
                content: ownerReplyText,
                replyTo: userDisplay,
                replyToId: userComment.id || null,
                replyToContent: userText || null,
                timestamp: baseTime + 200,
                likes: Math.floor(Math.random() * 5),
                replies: [],
                isAuthorReply: true
            };
            post.comments.push(ownerComment);

            // 构造映射表：tempId -> { id, authorName, content }
            const map = new Map();
            map.set(0, { id: userComment.id || null, authorName: userDisplay, content: userText || '' });
            const ownerTempId = Number(ownerItem?.id) || 1;
            map.set(ownerTempId, { id: ownerCommentId, authorName: authorName, content: ownerReplyText });

            // 处理 NPC 列表（跳过 owner）
            const npcItems = list.filter(x => x !== ownerItem).filter(x => String(x?.type || 'npc').toLowerCase() !== 'owner').slice(0, totalNpc);
            const npcComments = [];
            npcItems.forEach((it, idx) => {
                const tempId = Number(it?.id) || (idx + 2);
                const name = String(it?.name || '').trim() || `网友${idx + 1}`;
                const content = String(it?.content || '').trim() || '说得对！';
                const replyTemp = (it?.reply_id === null || it?.reply_id === undefined || it?.reply_id === '') ? null : Number(it.reply_id);

                const cid = `comment_npc_${baseTime}_${idx}_${Math.random().toString(36).slice(2, 6)}`;
                const c = {
                    id: cid,
                    authorId: `npc_batch_${baseTime}_${idx}`,
                    authorName: name,
                    authorUsername: generateUsername(name),
                    authorAvatar: `https://api.dicebear.com/7.x/notionists/svg?seed=${encodeURIComponent(name)}`,
                    content,
                    replyTo: null,
                    replyToId: replyTemp, // 先存临时，后续映射
                    replyToContent: null,
                    timestamp: baseTime + 300 + idx * 180,
                    likes: Math.floor(Math.random() * 5),
                    replies: [],
                    isAuthorReply: false,
                    __tempId: tempId
                };
                map.set(tempId, { id: cid, authorName: name, content });
                npcComments.push(c);
            });

            // 映射 replyToId
            npcComments.forEach(c => {
                const replyTemp = c.replyToId;
                if (replyTemp === null) {
                    c.replyToId = null;
                    return;
                }
                const target = map.get(replyTemp);
                if (target && target.id) {
                    c.replyTo = target.authorName || null;
                    c.replyToContent = target.content || null;
                    c.replyToId = target.id;
                } else {
                    c.replyToId = null;
                }
                delete c.__tempId;
            });

            post.comments.push(...npcComments);
        } catch (e) {
            console.warn('[Forum] 用户评论后NPC回复批量生成失败:', e);
            log('warning', `评论区NPC回复失败：${e?.message || e}`);

            // 兜底：至少保证楼主回复存在
            post.comments.push({
                id: 'comment_owner_' + baseTime,
                authorId: authorMeta.id,
                authorName: authorMeta.name,
                authorUsername: authorMeta.username,
                authorAvatar: authorMeta.avatar,
                content: '谢谢你的评论～',
                replyTo: userDisplay,
                replyToId: userComment.id || null,
                replyToContent: userText || null,
                timestamp: baseTime + 200,
                likes: Math.floor(Math.random() * 5),
                replies: [],
                isAuthorReply: true
            });
        }
        
    };
    
    // ========== 批量生成 ==========
    
    const batchGeneratePosts = async (count, worldBook, minComments, maxComments) => {
        uiState.isGenerating = true;
        
        try {
            const safeCount = Math.min(Math.max(1, count || 1), 10);

            // 目标：无论生成多少帖子，“开始生成”只调用 2 次 API：
            // 1) 一次性生成 N 条帖子（含作者/NPC信息）
            // 2) 一次性生成所有帖子对应的评论区（含楼中楼）
            const safeMin = Math.max(0, Math.min(minComments ?? 0, maxComments ?? 0));
            const safeMax = Math.max(safeMin, Math.max(minComments ?? safeMin, maxComments ?? safeMin));
            const commentCounts = Array.from({ length: safeCount }, () => getRandomInRange(safeMin, safeMax));

            // 世界观文本（用于帖子+评论的共同上下文）
            let worldContent = '现代都市背景';
            if (worldBook?.entries?.length) {
                worldContent = worldBook.entries.map(e => e.content || '').filter(Boolean).join('\n') || worldContent;
            }

            // 自定义 NPC（可选：让模型从中挑作者/评论者，减少重复）
            const customNpcBrief = (customNPCs || []).slice(0, 20).map(n => ({
                name: n?.name || '',
                bio: n?.bio || '',
                personality: n?.personality || ''
            })).filter(n => n.name);

            // ---------- API 调用 #1：批量生成帖子 ----------
            uiState.generatingProgress = `正在生成 ${safeCount} 个帖子...`;
            const postPrompt = `你是一个论坛内容生成器。

【世界观】
${worldContent}

${customNpcBrief.length ? `【可用自定义NPC（优先选用，避免重复；至少30%的帖子作者来自此列表）】
${customNpcBrief.map((n, i) => `${i + 1}. ${n.name}｜${n.personality || '随和'}｜${(n.bio || '').slice(0, 30)}`).join('\n')}\n` : ''}

【任务】
一次性生成 ${safeCount} 条论坛帖子（推特/广场风格）。

【要求】
- 每条 50-200 字
- 不要 emoji，不要 Markdown，不要引号
- 作者昵称 2-6 字，风格多样
- 允许有可选标题（title），没有也行
- 每条帖子末尾可带 1-3 个话题标签（例如：#日常 #吐槽），并且把它们也输出为 hashtags 数组（不带 #）
- 输出必须是 JSON 数组，不要任何额外文字

【JSON结构】
[
  {
    "idx": 1,
    "author": { "name": "昵称", "bio": "简介10-30字", "personality": "性格2-3词" },
    "title": "可选标题",
    "content": "帖子正文（可在末尾带 #话题）",
    "hashtags": ["日常","吐槽"]
  }
]`;

            const rawPosts = await callForumAI([{ role: 'user', content: postPrompt }], 10000, 0.85);
            const postsText = String(rawPosts || '').replace(/```json/gi, '').replace(/```/g, '').trim();
            const postList = JSON.parse(postsText);
            if (!Array.isArray(postList) || postList.length === 0) throw new Error('帖子生成返回空数组/非数组');

            const pickedPosts = postList.slice(0, safeCount);
            const baseTime = Date.now();
            const newPosts = pickedPosts.map((p, i) => {
                const author = p?.author || {};
                const authorName = String(author?.name || '').trim() || `网友${i + 1}`;
                const authorBio = String(author?.bio || '').trim() || '论坛用户';
                const authorPersonality = String(author?.personality || '').trim() || '随和';
                const content = String(p?.content || '').trim() || '分享一些想法...';
                const title = String(p?.title || '').trim();

                const hashtagMatches = content.match(/#[\u4e00-\u9fa5a-zA-Z0-9_]+/g) || [];
                const extractedHashtags = [...new Set(hashtagMatches.map(tag => tag.replace('#', '')))].slice(0, 3);
                const providedHashtags = Array.isArray(p?.hashtags)
                    ? p.hashtags.map(x => String(x || '').replace(/^#/, '').trim()).filter(Boolean)
                    : [];
                const hashtags = [...new Set([...providedHashtags, ...extractedHashtags])].slice(0, 3);

                return {
                    id: 'post_' + baseTime + '_' + i,
                    type: 'forum',
                    authorId: 'npc_gen_' + baseTime + '_' + i,
                    authorName,
                    authorUsername: generateUsername(authorName),
                    authorAvatar: generateRandomAvatar(),
                    authorBio: `${authorBio}${authorPersonality ? `｜${authorPersonality}` : ''}`,
                    title: title || '',
                    content,
                    hashtags,
                    // 让时间错开一点，避免“完全同一时间”
                    timestamp: baseTime - i * 60000,
                    likes: Math.floor(Math.random() * 50),
                    retweets: Math.floor(Math.random() * 20),
                    views: Math.floor(Math.random() * 200) + 50,
                    comments: [],
                    worldBookId: worldBook?.id || null
                };
            });

            // 新帖子插入到最前（保持“新在上”）
            forumPosts.unshift(...newPosts);

            // ---------- API 调用 #2：批量生成评论区 ----------
            // 若 commentCounts 全为 0，则无需调用评论生成（仍满足“最多两次 API”）
            const totalComments = commentCounts.reduce((a, b) => a + (b || 0), 0);
            if (totalComments > 0) {
                uiState.generatingProgress = `正在生成评论区...`;
                const postsBrief = newPosts.map((post, i) => {
                    const cc = commentCounts[i] || 0;
                    return `帖子#${i + 1}（评论数=${cc}）
作者：${post.authorName}（${(post.authorBio || '').slice(0, 40)}）
正文：${String(post.content || '').slice(0, 180)}`;
                }).join('\n\n');

                const commentPrompt = `你是一个论坛评论区模拟器。

【世界观】
${worldContent}

【任务】
对以下每条帖子，分别生成指定数量的评论（含楼中楼）。

【硬性要求】
- 不要 emoji，不要 Markdown，不要引号
- 单条 10-60 字
- 每条帖子至少 25% 的评论为“回复别人”（reply_id 指向同帖中较早的评论 id）
- 评论者昵称 2-6 字，多样化

【输出格式】
只输出 JSON 数组，不要任何额外文字：
[
  {
    "idx": 1,
    "comments": [
      { "id": 1, "name": "momo", "content": "…", "reply_id": null },
      { "id": 2, "name": "吃瓜群众", "content": "…", "reply_id": 1 }
    ]
  }
] 

【帖子列表】
${postsBrief}`;

                const rawComments = await callForumAI([{ role: 'user', content: commentPrompt }], 10000, 0.8);
                const commentsText = String(rawComments || '').replace(/```json/gi, '').replace(/```/g, '').trim();
                const commentPack = JSON.parse(commentsText);
                if (!Array.isArray(commentPack)) throw new Error('评论生成返回非数组');

                const packMap = new Map();
                commentPack.forEach(item => {
                    const idx = Number(item?.idx);
                    if (!Number.isFinite(idx)) return;
                    if (Array.isArray(item.comments)) packMap.set(idx, item.comments);
                });

                // 将评论映射写回每条帖子
                newPosts.forEach((post, i) => {
                    const desired = commentCounts[i] || 0;
                    if (desired <= 0) return;
                    const list = packMap.get(i + 1) || [];
                    const picked = list.slice(0, desired);
                    const cBase = Date.now() + i * 17;

                    // 先创建评论对象（reply_id 先暂存）
                    const temp = picked.map((c, j) => {
                        const name = String(c?.name || '').trim() || `网友${j + 1}`;
                        const content = String(c?.content || '').trim() || '说得对！';
                        const tempId = Number.isFinite(Number(c?.id)) ? Number(c.id) : (j + 1);
                        const replyTemp = (c?.reply_id === null || c?.reply_id === undefined || c?.reply_id === '') ? null : Number(c.reply_id);

                        return {
                            id: `comment_${cBase}_${j}_${Math.random().toString(36).slice(2, 6)}`,
                            tempId,
                            authorId: `npc_batch_${cBase}_${j}`,
                            authorName: name,
                            authorUsername: generateUsername(name),
                            authorAvatar: `https://api.dicebear.com/7.x/notionists/svg?seed=${encodeURIComponent(name)}`,
                            content,
                            replyTo: null,
                            replyToId: replyTemp, // 先临时存
                            replyToContent: null,
                            timestamp: Date.now() - Math.floor(Math.random() * 3600000),
                            likes: Math.floor(Math.random() * 15),
                            replies: []
                        };
                    });

                    // tempId -> comment 映射
                    const idMap = new Map(temp.map(t => [t.tempId, t]));
                    temp.forEach(c => {
                        if (c.replyToId === null) return;
                        const target = idMap.get(c.replyToId);
                        if (target) {
                            c.replyTo = target.authorName || null;
                            c.replyToContent = target.content || null;
                            c.replyToId = target.id;
                        } else {
                            c.replyToId = null;
                        }
                        delete c.tempId;
                    });
                    temp.forEach(c => { if (c.tempId !== undefined) delete c.tempId; });

                    // 关键修复：newPosts 内的 post 是“原始对象”，插入 reactive 数组后再改它，
                    // Vue deep watch 可能不会触发，从而导致评论没有写入本地存储。
                    // 这里改为写入 forumPosts 中的代理对象，确保能触发监听与保存。
                    const reactivePost = forumPosts.find(p => p && p.id === post.id) || post;
                    if (!Array.isArray(reactivePost.comments)) reactivePost.comments = [];
                    reactivePost.comments.push(...temp);
                });
            }

            uiState.generatingProgress = '生成完成！';
            await new Promise(r => setTimeout(r, 600));
        } catch (error) {
            console.error('[Forum] 批量生成失败:', error);
            log('error', `批量生成失败：${error?.message || error}`);
            uiState.generatingProgress = '生成失败';
        } finally {
            uiState.isGenerating = false;
            uiState.generatingProgress = '';
        }
    };
    
    // ========== UI 控制 ==========
    
    const openNPCManager = () => { uiState.showNPCManager = true; };
    const closeNPCManager = () => { uiState.showNPCManager = false; };
    const openPostGenerator = () => { uiState.showPostGenerator = true; };
    const closePostGenerator = () => { uiState.showPostGenerator = false; };
    
    const startGeneratePosts = () => {
        if (uiState.isGenerating) return;
        const minComments = Math.min(generatorSettings.commentMinCount, generatorSettings.commentMaxCount);
        const maxComments = Math.max(generatorSettings.commentMinCount, generatorSettings.commentMaxCount);
        closePostGenerator();
        batchGeneratePosts(generatorSettings.postGenerateCount, generatorSettings.selectedWorldBook, minComments, maxComments)
            .catch(err => console.error('[Forum] 后台生成失败:', err));
    };
    
    // 半屏评论区控制
    const openCommentSheet = (post) => {
        commentState.currentPost = post;
        commentState.replyTarget = null;
        commentState.inputText = '';
        uiState.showCommentSheet = true;
        console.log('[Forum] 打开评论区:', post?.id, '评论数:', post?.comments?.length);
    };
    
    const closeCommentSheet = () => {
        uiState.showCommentSheet = false;
        commentState.currentPost = null;
        commentState.replyTarget = null;
        commentState.inputText = '';
    };
    
    const setReplyTarget = (comment) => {
        commentState.replyTarget = comment;
        console.log('[Forum] 设置回复目标:', comment?.authorName);
    };
    
    const clearReplyTarget = () => {
        commentState.replyTarget = null;
    };
    
    const likeComment = (comment) => {
        if (!comment) return;
        if (comment.liked) {
            comment.liked = false;
            comment.likes = Math.max(0, (comment.likes || 1) - 1);
        } else {
            comment.liked = true;
            comment.likes = (comment.likes || 0) + 1;
        }
    };
    
    const toggleLike = (post) => {
        if (!post) return;
        if (post.liked) {
            post.liked = false;
            post.likes = Math.max(0, (post.likes || 1) - 1);
        } else {
            post.liked = true;
            post.likes = (post.likes || 0) + 1;
        }
    };
    
    const toggleComments = (post) => {
        if (!post) return;
        post.showComments = !post.showComments;
    };
    
    // ========== 导出 ==========
    
    return {
        // 数据
        customNPCs,
        systemNPCs,
        forumPosts,
        uiState,
        generatorSettings,
        npcCreatorData,
        commentState,  // 评论相关状态（reactive）
        
        // 计算属性
        getAllNPCs,
        
        // 方法
        createCustomNPC,
        deleteCustomNPC,
        openNPCCreator,
        closeNPCCreator,
        submitNPCCreator,
        generateWorldNPC,
        generateForumPost,
        generateDiverseComments,
        batchGeneratePosts,
        formatTimeAgo,
        getCleanContent,
        toggleComments,
        toggleLike,
        likeComment,
        submitComment,
        
        // UI 控制
        openNPCManager,
        closeNPCManager,
        openPostGenerator,
        closePostGenerator,
        startGeneratePosts,
        openCommentSheet,
        closeCommentSheet,
        setReplyTarget,
        clearReplyTarget
    };
}
