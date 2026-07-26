// js/useAudioQueue.js
import { ref, reactive } from 'https://cdnjs.cloudflare.com/ajax/libs/vue/3.3.4/vue.esm-browser.js';

export function useAudioQueue() {
    const isPlaying = ref(false);
    const audioQueue = ref([]); 
    
    // 🔴 核心修改1：全局只维护一个 Audio 对象 (单例)
    // 这样只要"激活"一次，后面都能一直用
    const globalAudio = new Audio();
    
    // 配置 Audio 属性，适配移动端
    globalAudio.autoplay = true; 
    // iOS 有时需要这个属性才能在静音模式下播放（虽然不一定百分百有效）
    globalAudio.playsInline = true; 

    // 🔴 核心修改2：提供一个"激活"函数
    // 必须在用户点击按钮（startCall）时立刻调用
    const unlockAudioContext = () => {
        // 播放一段极短的静音，或者播放/暂停一下
        // 创建一个静音 buffer
        globalAudio.src = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';
        globalAudio.play().then(() => {
            console.log("[Audio] 移动端音频引擎已激活 (Unlocked)");
            // 播放成功后立刻暂停，等待真正的 TTS
            globalAudio.pause();
            globalAudio.currentTime = 0;
        }).catch(e => {
            console.warn("[Audio] 激活失败，可能需要用户再次交互:", e);
        });
    };

    const enqueue = (audioUrl) => {
        if (!audioUrl) return;
        audioQueue.value.push(audioUrl);
        processQueue();
    };

    const processQueue = () => {
        if (isPlaying.value || audioQueue.value.length === 0) return;

        isPlaying.value = true;
        const nextUrl = audioQueue.value.shift();
        playAudio(nextUrl);
    };

    const playAudio = (url) => {
        // 🔴 核心修改3：复用 globalAudio，而不是 new Audio
        
        // 监听结束事件 (先移除旧的监听器，防止堆叠)
        globalAudio.onended = null;
        globalAudio.onerror = null;

        globalAudio.src = url;

        globalAudio.onended = () => {
            isPlaying.value = false;
            URL.revokeObjectURL(url); 
            processQueue(); 
        };

        globalAudio.onerror = (e) => {
            console.error("[AudioQueue] 播放出错:", e);
            isPlaying.value = false;
            URL.revokeObjectURL(url);
            processQueue();
        };

        const playPromise = globalAudio.play();
        if (playPromise !== undefined) {
            playPromise.catch(error => {
                console.warn("[AudioQueue] 播放被拦截:", error);
                // 移动端常见错误：NotAllowedError
                // 如果被拦截，尝试强制重置状态，避免卡死
                isPlaying.value = false;
                processQueue();
            });
        }
    };

    const clearQueue = () => {
        console.log("[AudioQueue] 强制停止");
        globalAudio.pause();
        globalAudio.currentTime = 0;
        globalAudio.src = ''; // 断开连接
        
        audioQueue.value.forEach(url => URL.revokeObjectURL(url));
        audioQueue.value = [];
        isPlaying.value = false;
    };

    return {
        enqueue,
        clearQueue,
        isPlaying,
        unlockAudioContext // 导出这个函数给 useVideoCall 使用
    };
}
