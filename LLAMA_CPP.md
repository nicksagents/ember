# llama.cpp Qwen3-Coder Launch

Use this command to run `Qwen3-Coder-30B-A3B-Instruct-Q6_K.gguf` with `llama-server` for Ember:

```bash
~/Desktop/llama.cpp/build/bin/llama-server \
  -m ~/models/Qwen3-Coder-30B-A3B-Instruct-Q6_K.gguf \
  --host 0.0.0.0 \
  --port 8080 \
  --jinja \
  -ngl 99 \
  -c 18500 \
  --threads 8
```

Notes:
- `--jinja` is required for proper Qwen chat-template handling.
- `--port 8080` matches Ember's default local OpenAI-compatible endpoint.
