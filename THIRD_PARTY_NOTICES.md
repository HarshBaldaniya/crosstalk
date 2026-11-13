# Third-party notices

Crosstalk's own code is under the [MIT License](LICENSE). The built extension also includes these
packages, each under its own license:

| Package | License | Used for |
|---|---|---|
| [react](https://github.com/facebook/react), react-dom | MIT | The pages inside VS Code |
| [@xyflow/react](https://github.com/xyflow/xyflow) | MIT | The Tower board |
| [d3-force](https://github.com/d3/d3-force) | ISC | Laying out the Map |
| [lucide-react](https://github.com/lucide-icons/lucide) | ISC | Interface icons |
| [@lobehub/icons-static-svg](https://github.com/lobehub/lobe-icons) | MIT | Agent logos |
| [simple-icons](https://github.com/simple-icons/simple-icons) | CC0-1.0 | Agent logos |
| [@vscode/tree-sitter-wasm](https://github.com/microsoft/vscode-tree-sitter-wasm) | MIT | Reading code for the Map |
| [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) | MIT | The tools agents call |
| [zod](https://github.com/colinhacks/zod) | MIT | Checking tool inputs |
| [@anthropic-ai/claude-agent-sdk](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) | Anthropic's terms ([legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)) | Listing and reading Claude Code chats |

The Claude Agent SDK is **not** open source: it is used under Anthropic's own terms, not the MIT
License. It is a dependency, so it is downloaded by `npm install` and is not part of this repository.

Product names and logos (Claude, Claude Code, Codex, ChatGPT, Gemini, VS Code) belong to their
owners. Crosstalk is an independent project and is not affiliated with or endorsed by them.
