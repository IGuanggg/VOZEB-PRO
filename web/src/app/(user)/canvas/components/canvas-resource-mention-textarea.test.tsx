import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CanvasResourceMentionTextarea } from "./canvas-resource-mention-textarea";

const baseProps = { value: "", references: [], onChange: () => undefined };

describe("引用输入框提交提示", () => {
    it("有提交行为时显示 Enter 提交、Shift+Enter 换行提示", () => {
        const markup = renderToStaticMarkup(<CanvasResourceMentionTextarea {...baseProps} onSubmit={() => undefined} />);

        expect(markup).toContain("Enter 提交");
        expect(markup).toContain("Shift+Enter 换行");
    });

    it("没有提交行为时不显示提交提示", () => {
        const markup = renderToStaticMarkup(<CanvasResourceMentionTextarea {...baseProps} />);

        expect(markup).not.toContain("Enter 提交");
    });
});
