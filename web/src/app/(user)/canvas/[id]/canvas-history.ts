import type { CanvasHistoryEntry } from "./canvas-page-elements";

/** 画布历史时间线：past 顶是 HEAD 的直接前态，future 顶是 HEAD 的直接后态。 */
export type CanvasHistoryTimeline = { past: CanvasHistoryEntry[]; future: CanvasHistoryEntry[] };

export type CanvasHistoryAction = "commit" | "undo" | "redo";

export type CanvasHistoryTransition = {
    timeline: CanvasHistoryTimeline;
    /** 转换后写入历史的 HEAD 快照；撤销/重做时就是要写回屏幕的快照。 */
    head: CanvasHistoryEntry;
    /** 需要写回屏幕的历史快照；纯提交（含重做被新编辑清空）时为 null。 */
    entry: CanvasHistoryEntry | null;
};

/** 语义操作边界状态：是否正在拖动节点、正在编辑的文本节点。 */
export type CanvasHistoryBoundary = { dragging: boolean; editingNodeId: string | null };

/** 屏幕变化进入历史的方式：语义边界立即提交 / 离散操作走合并窗口 / 只累积。 */
export type CanvasHistoryCommitPlan = "flush" | "schedule" | "hold";

/** 既有历史深度上限：past 最多保留 50 步。 */
export const CANVAS_HISTORY_PAST_LIMIT = 50;

/** 离散操作沿用的合并窗口，保持项目原有 180ms，不缩短也不新增延时。 */
export const CANVAS_HISTORY_MERGE_WINDOW_MS = 180;

/** 节点、连线、会话等都以不可变替换更新，字段引用相同即代表同一屏幕状态。 */
export function isSameCanvasHistoryEntry(previous: CanvasHistoryEntry | null, next: CanvasHistoryEntry | null): boolean {
    return (
        previous === next ||
        Boolean(
            previous &&
            next &&
            previous.nodes === next.nodes &&
            previous.connections === next.connections &&
            previous.chatSessions === next.chatSessions &&
            previous.activeChatId === next.activeChatId &&
            previous.backgroundMode === next.backgroundMode &&
            previous.showImageInfo === next.showImageInfo,
        )
    );
}

/** 把快照压入 past：重复快照不入栈，并保持 50 步上限。 */
function pushPast(past: CanvasHistoryEntry[], entry: CanvasHistoryEntry): CanvasHistoryEntry[] {
    if (isSameCanvasHistoryEntry(past[past.length - 1] ?? null, entry)) return past;
    return [...past.slice(-(CANVAS_HISTORY_PAST_LIMIT - 1)), entry];
}

/**
 * 历史状态转换的唯一入口。head 是最后写入历史的状态，current 是屏幕当前状态（可能还没提交）。
 * - commit：把未提交的当前状态提交成新的 HEAD，旧 HEAD 入 past，新编辑清空 future；
 * - undo：先把未提交的当前状态提交成新的 HEAD，再退回直接前态；
 * - redo：当前状态若是新编辑则先清空 future，否则前进到 future 顶并保存当前真实状态。
 * 返回 null 表示这次操作不改变历史（状态没变化，或没有可撤销/可重做的快照）。
 */
export function transitionCanvasHistory(timeline: CanvasHistoryTimeline, head: CanvasHistoryEntry | null, current: CanvasHistoryEntry, action: CanvasHistoryAction): CanvasHistoryTransition | null {
    if (!head) return null;
    const pending = !isSameCanvasHistoryEntry(head, current);

    if (action === "commit") {
        if (!pending) return null;
        return { timeline: { past: pushPast(timeline.past, head), future: [] }, head: current, entry: null };
    }

    if (action === "undo") {
        const past = pending ? pushPast(timeline.past, head) : timeline.past;
        const entry = past[past.length - 1];
        if (!entry) return null;
        return { timeline: { past: past.slice(0, -1), future: pending ? [current] : [...timeline.future, head] }, head: entry, entry };
    }

    if (pending) return { timeline: { past: pushPast(timeline.past, head), future: [] }, head: current, entry: null };
    const entry = timeline.future[timeline.future.length - 1];
    if (!entry) return null;
    return { timeline: { past: pushPast(timeline.past, head), future: timeline.future.slice(0, -1) }, head: entry, entry };
}

/** 拖动或文本编辑会话进行中：变化只累积，不按帧、也不按打字停顿拆成多步历史。 */
export function isCanvasHistorySessionActive(boundary: CanvasHistoryBoundary): boolean {
    return boundary.dragging || Boolean(boundary.editingNodeId);
}

/**
 * 决定屏幕上的变化怎么进历史：
 * - flush：跨越语义边界（拖动开始/结束、文本编辑会话开始/切换/结束）时立即提交；
 * - schedule：离散操作（增删节点、连线、批量导入等）沿用原有 180ms 合并窗口，各自成为一步历史；
 * - hold：没有变化，或正处在拖动/文本编辑会话中，等下一次边界或合并窗口再提交。
 */
export function planCanvasHistoryCommit(previous: CanvasHistoryBoundary, next: CanvasHistoryBoundary, changed: boolean): CanvasHistoryCommitPlan {
    if (previous.dragging !== next.dragging || previous.editingNodeId !== next.editingNodeId) return "flush";
    if (isCanvasHistorySessionActive(next)) return "hold";
    return changed ? "schedule" : "hold";
}
