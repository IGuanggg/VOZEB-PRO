import { describe, expect, it, vi } from "vitest";

import { handleMentionNavigation, handleMentionTextareaKeyDown, isImeComposing } from "./canvas-mention-navigation";

type KeyEventInput = {
    key: string;
    isComposing?: boolean;
    nativeEvent?: { isComposing?: boolean };
    ctrlKey?: boolean;
    metaKey?: boolean;
    shiftKey?: boolean;
    altKey?: boolean;
};

function keyEvent({ key, isComposing, nativeEvent, ctrlKey, metaKey, shiftKey, altKey }: KeyEventInput) {
    const preventDefault = vi.fn();
    return { event: { key, isComposing, nativeEvent, ctrlKey, metaKey, shiftKey, altKey, preventDefault }, preventDefault };
}

function textareaOptions() {
    const onSubmit = vi.fn();
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const setActiveIndex = vi.fn();
    return { onSubmit, onSelect, onClose, setActiveIndex, options: { mentionActive: false, candidates: [] as number[], activeIndex: 0, setActiveIndex, onSelect, onClose, onSubmit } };
}

function mentionOptions() {
    const onSubmit = vi.fn();
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const setActiveIndex = vi.fn();
    return { onSubmit, onSelect, onClose, setActiveIndex, options: { mentionActive: true, candidates: [1, 2, 3], activeIndex: 0, setActiveIndex, onSelect, onClose, onSubmit } };
}

describe("输入法组合态判定", () => {
    it("React 合成事件与原生事件任一带 isComposing 都算组合态", () => {
        expect(isImeComposing({ key: "Enter", preventDefault: () => undefined, isComposing: true })).toBe(true);
        expect(isImeComposing({ key: "Enter", preventDefault: () => undefined, nativeEvent: { isComposing: true } })).toBe(true);
        expect(isImeComposing({ key: "Enter", preventDefault: () => undefined, isComposing: false, nativeEvent: { isComposing: true } })).toBe(true);
        expect(isImeComposing({ key: "Enter", preventDefault: () => undefined })).toBe(false);
    });
});

describe("引用输入框组合态保护", () => {
    it("组合态 Enter 不提交也不阻止默认行为", () => {
        const { event, preventDefault } = keyEvent({ key: "Enter", isComposing: true });
        const { options } = textareaOptions();

        expect(handleMentionTextareaKeyDown(event, options)).toBe(true);
        expect(options.onSubmit).not.toHaveBeenCalled();
        expect(preventDefault).not.toHaveBeenCalled();
    });

    it("仅原生事件 isComposing 时同样不提交", () => {
        const { event, preventDefault } = keyEvent({ key: "Enter", isComposing: false, nativeEvent: { isComposing: true } });
        const { options } = textareaOptions();

        expect(handleMentionTextareaKeyDown(event, options)).toBe(true);
        expect(options.onSubmit).not.toHaveBeenCalled();
        expect(preventDefault).not.toHaveBeenCalled();
    });

    it("组合态下引用菜单不抢方向键、Enter 和 Escape", () => {
        const down = keyEvent({ key: "ArrowDown", isComposing: true });
        const up = keyEvent({ key: "ArrowUp", nativeEvent: { isComposing: true } });
        const enter = keyEvent({ key: "Enter", isComposing: true });
        const escape = keyEvent({ key: "Escape", isComposing: true });
        const { onSelect, onClose, setActiveIndex, options } = mentionOptions();

        for (const { event, preventDefault } of [down, up, enter, escape]) {
            expect(handleMentionTextareaKeyDown(event, options)).toBe(true);
            expect(preventDefault).not.toHaveBeenCalled();
        }
        expect(setActiveIndex).not.toHaveBeenCalled();
        expect(onSelect).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
        expect(options.onSubmit).not.toHaveBeenCalled();
    });

    it("引用菜单自身的导航处理在组合态下同样不生效", () => {
        const { event, preventDefault } = keyEvent({ key: "Escape", isComposing: true });
        const onClose = vi.fn();
        const setActiveIndex = vi.fn();

        expect(handleMentionNavigation(event, [1, 2], 0, setActiveIndex, vi.fn(), onClose)).toBe(false);
        expect(preventDefault).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
        expect(setActiveIndex).not.toHaveBeenCalled();
    });

    it("普通 Enter 只提交一次并阻止换行", () => {
        const { event, preventDefault } = keyEvent({ key: "Enter" });
        const { options } = textareaOptions();

        expect(handleMentionTextareaKeyDown(event, options)).toBe(true);
        expect(options.onSubmit).toHaveBeenCalledTimes(1);
        expect(preventDefault).toHaveBeenCalledTimes(1);
    });

    it("Shift+Enter 保持换行语义，Ctrl/Cmd 组合不触发提交", () => {
        const shift = keyEvent({ key: "Enter", shiftKey: true });
        const ctrl = keyEvent({ key: "Enter", ctrlKey: true });
        const meta = keyEvent({ key: "Enter", metaKey: true });
        const { options } = textareaOptions();

        for (const { event, preventDefault } of [shift, ctrl, meta]) {
            expect(handleMentionTextareaKeyDown(event, options)).toBe(false);
            expect(preventDefault).not.toHaveBeenCalled();
        }
        expect(options.onSubmit).not.toHaveBeenCalled();
    });

    it("Alt 组合沿用原有 Enter 语义，没有被组合态保护改动", () => {
        const { event, preventDefault } = keyEvent({ key: "Enter", altKey: true });
        const { options } = textareaOptions();

        expect(handleMentionTextareaKeyDown(event, options)).toBe(true);
        expect(options.onSubmit).toHaveBeenCalledTimes(1);
        expect(preventDefault).toHaveBeenCalledTimes(1);
    });

    it("非组合态下引用菜单的方向键、Enter 和 Escape 语义不变", () => {
        const setActiveIndex = vi.fn();
        const onSelect = vi.fn();
        const onClose = vi.fn();
        const down = keyEvent({ key: "ArrowDown" });
        const enter = keyEvent({ key: "Enter" });
        const escape = keyEvent({ key: "Escape" });

        expect(handleMentionNavigation(down.event, [1, 2, 3], 0, setActiveIndex, onSelect, onClose)).toBe(true);
        expect(setActiveIndex).toHaveBeenCalledTimes(1);
        expect(handleMentionNavigation(enter.event, [1, 2, 3], 1, setActiveIndex, onSelect, onClose)).toBe(true);
        expect(onSelect).toHaveBeenCalledWith(2);
        expect(handleMentionNavigation(escape.event, [1, 2, 3], 1, setActiveIndex, onSelect, onClose)).toBe(true);
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});
