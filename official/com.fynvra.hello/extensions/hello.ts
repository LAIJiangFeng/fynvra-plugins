// Fynvra 官方示例插件：注册 hello_fynvra 工具，返回问候语和当前时间。
// 只有类型导入（运行时会被擦除），不依赖任何 npm 包；参数用普通 JSON Schema 描述。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "hello_fynvra",
		label: "Hello Fynvra",
		description: "向用户问好并返回当前时间。用于确认 Fynvra 插件已正确安装。",
		parameters: {
			type: "object",
			properties: {
				name: { type: "string", description: "要问候的名字，可省略" },
			},
			additionalProperties: false,
		} as any,

		async execute(_toolCallId: string, params: { name?: string }) {
			const now = new Date();
			const who = params.name?.trim() || "Fynvra";
			const text = `你好，${who}！现在是 ${now.toLocaleString()}（${now.toISOString()}）。`;
			return {
				content: [{ type: "text", text }],
				details: { name: who, time: now.toISOString() },
			};
		},
	});
}
