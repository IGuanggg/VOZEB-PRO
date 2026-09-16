type MentionKeyEvent = {
    key: string;
    preventDefault: () => void;
    isComposing?: boolean;
    nativeEvent?: { isComposing?: boolean };
};

type MentionTextareaKeyEvent = MentionKeyEvent & {
    ctrlKey?: boolean;
    metaKey?: boolean;
    shiftKey?: boolean;
};

type MentionTextareaKeyOptions<T> = {
    mentionActive: boolean;
    candidates: T[];
    activeIndex: number;
    setActiveIndex: (update: (index: number) => number) => void;
    onSelect: (candidate: T) => void;
    onClose: () => void;
    onSubmit?: () => void;
};

/** 中文输入法组合态：React 合成事件与原生 KeyboardEvent 都可能承载 isComposing。 */
export function isImeComposing(event: MentionKeyEvent) {
    return Boolean(event.isComposing || event.nativeEvent?.isComposing);
}

export function handleMentionNavigation<T>(event: MentionKeyEvent, candidates: T[], activeIndex: number, setActiveIndex: (update: (index: number) => number) => void, onSelect: (candidate: T) => void, onClose: () => void) {
    if (isImeComposing(event) || !candidates.length) return false;
    if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((index) => (index + 1) % candidates.length);
        return true;
    }
    if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex((index) => (index - 1 + candidates.length) % candidates.length);
        return true;
    }
    if (event.key === "Enter") {
        event.preventDefault();
        onSelect(candidates[Math.min(activeIndex, candidates.length - 1)]);
        return true;
    }
    if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return true;
    }
    return false;
}

/** 引用输入框按键处理。返回 true 表示事件已处理，调用方不得再交给会提交或关闭编辑器的父回调。 */
export function handleMentionTextareaKeyDown<T>(event: MentionTextareaKeyEvent, options: MentionTextareaKeyOptions<T>) {
    if (isImeComposing(event)) return true;
    if (options.mentionActive && handleMentionNavigation(event, options.candidates, options.activeIndex, options.setActiveIndex, options.onSelect, options.onClose)) return true;
    if (event.key === "Enter" && options.onSubmit && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
        event.preventDefault();
        options.onSubmit();
        return true;
    }
    return false;
}
