Use this tool when the user wants a fresh Next.js app with shadcn/ui and does not want a long interactive shell setup.

Guidelines:
- Prefer this tool over raw `run_command` when the request is to create, scaffold, bootstrap, or initialize a new Next.js + shadcn project.
- Give it the target project directory path.
- After it succeeds, use the returned `startCommand` when the user asks to run the app.
- The tool writes `.ember-project.json` into the project. If you need to remember how to start or verify the app later, read that file.
