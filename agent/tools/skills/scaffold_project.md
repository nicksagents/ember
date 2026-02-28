Use this tool to create new projects from known presets without making the model spell out long CLI commands.

Use it when the user wants to:
- create a new app
- scaffold a starter project
- bootstrap a framework
- initialize a repo from a common stack

Supported presets:
- `nextjs-shadcn`
- `vite-react-ts`
- `vite-vue-ts`
- `vite-vanilla-ts`
- `electron-forge-vite-ts`
- `expo-default`
- `fastapi-uv`
- `python-uv-app`
- `python-uv-package`

Guidelines:
- Prefer this tool over raw shell commands for these stacks.
- Give it the final target project folder path.
- After success, use the returned `startCommand` when starting the app later.
- The tool writes `.ember-project.json` into the project root. Read that file later if you need to know how to run the project.
