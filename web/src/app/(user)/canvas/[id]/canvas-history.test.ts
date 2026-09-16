import { afterEach, describe, expect, it, vi } from "vitest";

import { CanvasNodeType } from "../types";

import { CANVAS_HISTORY_MERGE_WINDOW_MS, CANVAS_HISTORY_PAST_LIMIT, isSameCanvasHistoryEntry, planCanvasHistoryCommit, transitionCanvasHistory, type CanvasHistoryBoundary, type CanvasHistoryTimeline } from "./canvas-history";

import type { CanvasHistoryEntry } from "./canvas-page-elements";

function state(label: string): CanvasHistoryEntry {
    return {
        nodes: [{ id: `node-${label}`, type: CanvasNodeType.Text, title: label, position: { x: 0, y: 0 }, width: 320, height: 180, metadata: { content: label } }],
        connections: [],
        chatSessions: [],
        activeChatId: label,
        backgroundMode: "lines",
        showImageInfo: false,
    };
}

describe("Canvas history transitions", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("undoes to the direct predecessor and redoes the real current state while the latest edit is uncommitted", () => {
        vi.useFakeTimers();
        const a = state("A");
        const b = state("B");
        const c = state("C");
        // 历史里最后提交的是 B，屏幕已经变成 C，但提交还没发生
        const timeline: CanvasHistoryTimeline = { past: [a], future: [] };

        const undo = transitionCanvasHistory(timeline, b, c, "undo");

        expect(undo?.entry?.nodes[0]?.id).toBe("node-B");
        expect(undo?.head).toBe(b);
        expect(undo?.timeline.past[0]).toBe(a);
        expect(undo?.timeline.past).toHaveLength(1);
        expect(undo?.timeline.future[0]).toBe(c);

        vi.advanceTimersByTime(1000); // 事务边界与时间无关，时间流逝不改变结果
        expect(undo?.timeline.future[0]).toBe(c);

        const redo = transitionCanvasHistory(undo!.timeline, undo!.head, b, "redo");

        expect(redo?.entry?.nodes[0]?.id).toBe("node-C");
        expect(redo?.timeline.future).toHaveLength(0);
        expect(redo?.timeline.past.map((item) => item.nodes[0]?.id)).toEqual(["node-A", "node-B"]);
    });

    it("undoes the first edit even though the timeline was empty before it", () => {
        const s0 = state("S0");
        const s1 = state("S1");

        const transition = transitionCanvasHistory({ past: [], future: [] }, s0, s1, "undo");

        expect(transition?.entry).toBe(s0);
        expect(transition?.timeline.past).toHaveLength(0);
        expect(transition?.timeline.future[0]).toBe(s1);
        // 没有未提交变化、也没有历史时，撤销不产生任何转换
        expect(transitionCanvasHistory({ past: [], future: [] }, s0, s0, "undo")).toBeNull();
        expect(transitionCanvasHistory({ past: [], future: [] }, s0, s0, "redo")).toBeNull();
    });

    it("walks consecutive undo and redo steps in order", () => {
        const [s0, s1, s2] = ["S0", "S1", "S2"].map(state);
        let timeline: CanvasHistoryTimeline = { past: [s0, s1], future: [] };
        let head = s2;
        const undone: string[] = [];
        for (let index = 0; index < 3; index += 1) {
            const transition = transitionCanvasHistory(timeline, head, head, "undo");
            if (!transition?.entry) break;
            timeline = transition.timeline;
            head = transition.head;
            undone.push(transition.entry.nodes[0]!.id);
        }

        expect(undone).toEqual(["node-S1", "node-S0"]);
        expect(timeline.past).toHaveLength(0);

        const redone: string[] = [];
        for (let index = 0; index < 3; index += 1) {
            const transition = transitionCanvasHistory(timeline, head, head, "redo");
            if (!transition?.entry) break;
            timeline = transition.timeline;
            head = transition.head;
            redone.push(transition.entry.nodes[0]!.id);
        }

        expect(redone).toEqual(["node-S1", "node-S2"]);
        expect(head).toBe(s2);
        expect(timeline.future).toHaveLength(0);
    });

    it("clears the redo stack when a new edit lands after an undo", () => {
        const [s0, s1, s2, s3] = ["S0", "S1", "S2", "S3"].map(state);

        const undone = transitionCanvasHistory({ past: [s0], future: [] }, s1, s2, "undo")!;

        expect(undone.entry).toBe(s1);
        expect(undone.timeline.future[0]).toBe(s2);

        const reedited = transitionCanvasHistory(undone.timeline, undone.head, s3, "commit")!;

        expect(reedited.head).toBe(s3);
        expect(reedited.timeline.future).toHaveLength(0);
        expect(reedited.timeline.past[reedited.timeline.past.length - 1]).toBe(s1);
        expect(transitionCanvasHistory(reedited.timeline, reedited.head, s3, "redo")).toBeNull();

        // 未提交的新编辑先清空 redo 栈，重做因此不会回到被放弃的快照
        const pendingRedo = transitionCanvasHistory(undone.timeline, undone.head, s3, "redo")!;

        expect(pendingRedo.entry).toBeNull();
        expect(pendingRedo.head).toBe(s3);
        expect(pendingRedo.timeline.future).toHaveLength(0);
        expect(pendingRedo.timeline.past[pendingRedo.timeline.past.length - 1]).toBe(s1);
    });

    it("keeps at most 50 past snapshots and stops the undo chain at the oldest retained one", () => {
        const states = Array.from({ length: CANVAS_HISTORY_PAST_LIMIT + 11 }, (_, index) => state(`S${index}`));
        let timeline: CanvasHistoryTimeline = { past: [], future: [] };
        let head = states[0]!;
        for (const next of states.slice(1)) {
            const transition = transitionCanvasHistory(timeline, head, next, "commit")!;
            timeline = transition.timeline;
            head = transition.head;
        }

        expect(head).toBe(states[states.length - 1]);
        expect(timeline.past).toHaveLength(CANVAS_HISTORY_PAST_LIMIT);
        expect(timeline.past[0]).toBe(states[states.length - CANVAS_HISTORY_PAST_LIMIT - 1]);
        expect(timeline.past[CANVAS_HISTORY_PAST_LIMIT - 1]).toBe(states[states.length - 2]);

        let steps = 0;
        for (;;) {
            const transition = transitionCanvasHistory(timeline, head, head, "undo");
            if (!transition) break;
            timeline = transition.timeline;
            head = transition.head;
            steps += 1;
        }

        expect(steps).toBe(CANVAS_HISTORY_PAST_LIMIT);
        expect(head).toBe(states[states.length - CANVAS_HISTORY_PAST_LIMIT - 1]);
    });

    it("treats the same screen state as one history step and schedules no timers", () => {
        vi.useFakeTimers();
        const a = state("A");
        const b = state("B");

        expect(isSameCanvasHistoryEntry(null, a)).toBe(false);
        expect(isSameCanvasHistoryEntry(a, { ...a })).toBe(true);
        expect(isSameCanvasHistoryEntry(a, b)).toBe(false);
        expect(transitionCanvasHistory({ past: [], future: [] }, a, a, "commit")).toBeNull();

        const pending = transitionCanvasHistory({ past: [a], future: [] }, a, b, "commit")!;

        expect(pending.timeline.past).toHaveLength(1);
        expect(pending.timeline.past[0]).toBe(a);
        expect(pending.head).toBe(b);
        expect(vi.getTimerCount()).toBe(0);
    });
});

describe("Canvas history commit scheduling", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("plans an immediate commit on semantic boundaries and the merge window for discrete changes", () => {
        const idle: CanvasHistoryBoundary = { dragging: false, editingNodeId: null };
        const dragging: CanvasHistoryBoundary = { dragging: true, editingNodeId: null };
        const editing: CanvasHistoryBoundary = { dragging: false, editingNodeId: "node-text" };

        expect(planCanvasHistoryCommit(idle, dragging, false)).toBe("flush");
        expect(planCanvasHistoryCommit(dragging, idle, true)).toBe("flush");
        expect(planCanvasHistoryCommit(idle, editing, true)).toBe("flush");
        expect(planCanvasHistoryCommit(editing, idle, true)).toBe("flush");
        expect(planCanvasHistoryCommit(dragging, dragging, true)).toBe("hold");
        expect(planCanvasHistoryCommit(editing, editing, true)).toBe("hold");
        expect(planCanvasHistoryCommit(idle, idle, false)).toBe("hold");
        expect(planCanvasHistoryCommit(idle, idle, true)).toBe("schedule");
    });

    it("keeps two independent node deletions as two undo steps", () => {
        vi.useFakeTimers();
        const harness = createCommitHarness();
        const loaded = state("loaded");
        const afterDeleteA = state("delete-A");
        const afterDeleteB = state("delete-B");
        harness.load(loaded);

        harness.change(afterDeleteA);
        vi.advanceTimersByTime(CANVAS_HISTORY_MERGE_WINDOW_MS);
        harness.change(afterDeleteB);
        vi.advanceTimersByTime(CANVAS_HISTORY_MERGE_WINDOW_MS);

        expect(harness.timeline().past).toHaveLength(2);
        expect(harness.undo()).toBe(afterDeleteA); // 第一次撤销只恢复最后一次删除
        expect(harness.undo()).toBe(loaded); // 再撤销才回到更早状态
    });

    it("merges a continuous drag with many node updates into a single history step", () => {
        vi.useFakeTimers();
        const harness = createCommitHarness();
        const loaded = state("loaded");
        const moved = state("dragged");
        harness.load(loaded);

        harness.change(loaded, { dragging: true }); // 按下节点：语义边界，此时还没有位置变化
        harness.change(state("drag-1"), { dragging: true }); // 拖动中的多次更新只累积，不按帧拆步
        harness.change(state("drag-2"), { dragging: true });
        harness.change(moved, { dragging: true });
        vi.advanceTimersByTime(CANVAS_HISTORY_MERGE_WINDOW_MS * 3);
        expect(harness.timeline().past).toHaveLength(0);
        harness.change(moved, { dragging: false }); // 松开节点：边界提交整段拖动

        expect(harness.timeline().past).toHaveLength(1);
        expect(harness.timeline().past[0]).toBe(loaded);
        expect(vi.getTimerCount()).toBe(0);
        expect(harness.undo()).toBe(loaded);
    });

    it("merges a whole text editing session into a single history step", () => {
        vi.useFakeTimers();
        const harness = createCommitHarness();
        const loaded = state("loaded");
        const edited = state("edited-text");
        harness.load(loaded);

        harness.change(loaded, { editingNodeId: "node-text" }); // 进入文本编辑：语义边界，此时还没有输入
        harness.change(state("typing-1"), { editingNodeId: "node-text" }); // 编辑会话中的多次输入只累积
        harness.change(edited, { editingNodeId: "node-text" });
        vi.advanceTimersByTime(CANVAS_HISTORY_MERGE_WINDOW_MS * 5);
        expect(harness.timeline().past).toHaveLength(0);
        harness.change(edited, { editingNodeId: null }); // 退出编辑会话：边界提交整段编辑

        expect(harness.timeline().past).toHaveLength(1);
        expect(harness.timeline().past[0]).toBe(loaded);
        expect(harness.undo()).toBe(loaded);
    });

    it("commits the live screen state when the merge window fires", () => {
        vi.useFakeTimers();
        const harness = createCommitHarness();
        const loaded = state("loaded");
        harness.load(loaded);

        harness.change(state("upload-placeholder")); // 合并窗口开始
        harness.change(state("placeholder-deleted")); // 占位节点被删除，窗口重新计算
        vi.advanceTimersByTime(CANVAS_HISTORY_MERGE_WINDOW_MS);

        expect(harness.timeline().past[0]).toBe(loaded);
        expect(harness.undo()).toBe(loaded); // 迟到的提交不会把已经删掉的占位节点写回历史
    });
});

/**
 * 与 use-canvas-persistence-effects 相同的提交调度循环：提交时机由真实的 planCanvasHistoryCommit /
 * transitionCanvasHistory 决定，离散操作走 180ms 合并窗口，语义边界立即提交。
 * 仓库没有 @testing-library，React effect 本身不在 vitest 里执行，这里只回归这套调度契约。
 */
function createCommitHarness() {
    let timeline: CanvasHistoryTimeline = { past: [], future: [] };
    let head: CanvasHistoryEntry | null = null;
    let screen: CanvasHistoryEntry | null = null;
    let boundary: CanvasHistoryBoundary = { dragging: false, editingNodeId: null };
    let timer: ReturnType<typeof setTimeout> | null = null;

    const commitPending = () => {
        const transition = transitionCanvasHistory(timeline, head, screen!, "commit");
        if (!transition) return;
        timeline = transition.timeline;
        head = transition.head;
    };

    return {
        load(entry: CanvasHistoryEntry) {
            head = entry;
            screen = entry;
        },
        change(entry: CanvasHistoryEntry, next: Partial<CanvasHistoryBoundary> = {}) {
            const nextBoundary = { ...boundary, ...next };
            const plan = planCanvasHistoryCommit(boundary, nextBoundary, !isSameCanvasHistoryEntry(head, entry));
            boundary = nextBoundary;
            screen = entry;
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            if (plan === "flush") commitPending();
            if (plan === "schedule")
                timer = setTimeout(() => {
                    timer = null;
                    commitPending();
                }, CANVAS_HISTORY_MERGE_WINDOW_MS);
        },
        undo() {
            const transition = transitionCanvasHistory(timeline, head, screen!, "undo");
            if (!transition) return null;
            timeline = transition.timeline;
            head = transition.head;
            screen = transition.entry ?? transition.head;
            return transition.entry;
        },
        redo() {
            const transition = transitionCanvasHistory(timeline, head, screen!, "redo");
            if (!transition) return null;
            timeline = transition.timeline;
            head = transition.head;
            screen = transition.entry ?? transition.head;
            return transition.entry;
        },
        timeline: () => timeline,
    };
}
