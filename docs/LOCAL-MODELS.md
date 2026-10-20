# Local models (private, offline, zero quota) via Ollama

The agent can run small models on your own GPU for routing and chat, with the free cloud race as automatic fallback. Free forever, works offline, nothing leaves the machine.

## Setup (Windows)

1. Install Ollama: https://ollama.com/download/windows (free, official).
2. In the agent chat: `local setup` - it detects your GPU, picks models that honestly fit your VRAM, and pulls them (one-time download).
3. `local on` (setup turns it on automatically). `local status` anytime, `local off` to go back to pure cloud.

## What runs where

| GPU VRAM | Chat model | Router model | Note |
|---|---|---|---|
| 4 GB (e.g. RTX 2050/3050 laptop) | qwen3.5:2b | gemma3:1b | Both fully GPU-resident |
| 6 GB | qwen3.5:4b | gemma3:1b | 8B would spill - slower, not smarter |
| 8 GB+ | llama3.1:8b | gemma3:1b | |
| 12 GB+ | qwen3:8b | gemma3:1b | |
| < 2 GB / no NVIDIA | none | none | cloud race only (honest refusal) |

Why not a bigger model on 4GB: decode speed is memory-bandwidth bound. A model that spills to system RAM runs at the speed of the slow half (DDR4 ≈ 51 GB/s vs GPU ≈ 100+ GB/s). A fully-resident 2B beats a half-offloaded 8B every time.

## Tuning for 4GB cards

Set these before starting Ollama to halve context memory:
```
setx OLLAMA_KV_CACHE_TYPE q8_0
setx OLLAMA_FLASH_ATTENTION 1
```
(restart Ollama after). Check residency: `ollama ps` - PROCESSOR must read `100% GPU`. Any CPU share means the model spilled; drop to a smaller model.

## Fallbacks

- Router model down/slow -> the free cloud race routes instead (8s local budget).
- Local chat loses the race or errors -> a cloud model answers. No dead ends.
- Ollama not installed -> everything works exactly as before; local is additive.
