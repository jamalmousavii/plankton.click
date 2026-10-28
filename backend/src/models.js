// Prices are USD per 1M tokens, set at or below the cheapest public hosted
// rate for each model (DeepInfra / OpenRouter / Groq, Oct 2026) and scaled
// by model size. Chat bills output tokens; embeddings bill input tokens.
const MODELS = [
  // Chat — Kamel-tarin
  { id: 'llama3.3:70b', name: 'Llama 3.3', size: '70B', ram: '43 GB', category: 'chat', desc: 'Best large model (MMLU 86.0)', inputPrice: 0.08, outputPrice: 0.25, vision: false, audio: false },
  { id: 'deepseek-r1:70b', name: 'DeepSeek R1', size: '70B', ram: '43 GB', category: 'chat', desc: 'Best reasoning model', inputPrice: 0.08, outputPrice: 0.28, vision: false, audio: false },
  { id: 'qwen3:32b', name: 'Qwen 3', size: '32B', ram: '20 GB', category: 'chat', desc: 'Strong reasoning with thinking modes', inputPrice: 0.06, outputPrice: 0.2, vision: false, audio: false },
  { id: 'gpt-oss:20b', name: 'GPT-OSS 20B', size: '21B MoE', ram: '14 GB', category: 'chat', desc: 'OpenAI open-weight (Harmony format)', inputPrice: 0.015, outputPrice: 0.07, vision: false, audio: false },
  { id: 'phi4:14b', name: 'Phi-4', size: '14B', ram: '9 GB', category: 'chat', desc: 'Best small reasoner (math + logic)', inputPrice: 0.03, outputPrice: 0.08, vision: false, audio: false },
  { id: 'llama3.1:8b', name: 'Llama 3.1', size: '8B', ram: '5 GB', category: 'chat', desc: 'Best budget all-rounder', inputPrice: 0.015, outputPrice: 0.025, vision: false, audio: false },
  { id: 'llama3.2:3b', name: 'Llama 3.2', size: '3B', ram: '2 GB', category: 'chat', desc: 'Fastest everyday chat', inputPrice: 0.01, outputPrice: 0.02, vision: false, audio: false },

  // Code — Kamel-tarin
  { id: 'qwen3-coder:30b', name: 'Qwen 3 Coder', size: '30B MoE', ram: '18 GB', category: 'code', desc: 'Best coding model (256K context)', inputPrice: 0.05, outputPrice: 0.2, vision: false, audio: false },
  { id: 'qwen2.5-coder:32b', name: 'Qwen 2.5 Coder', size: '32B', ram: '20 GB', category: 'code', desc: 'Best dense coder (92.7% HumanEval)', inputPrice: 0.06, outputPrice: 0.18, vision: false, audio: false },

  // Vision — Kamel-tarin
  { id: 'gemma3:27b', name: 'Gemma 3', size: '27B', ram: '18 GB', category: 'vision', desc: 'Google multimodal workhorse', inputPrice: 0.04, outputPrice: 0.12, vision: true, audio: false },
  { id: 'mistral-small3.2:24b', name: 'Mistral Small 3.2', size: '24B', ram: '15 GB', category: 'vision', desc: 'Fast vision + tools (EU-made)', inputPrice: 0.04, outputPrice: 0.1, vision: true, audio: false },
  { id: 'qwen3-vl:8b', name: 'Qwen 3 VL', size: '8B', ram: '8 GB', category: 'vision', desc: 'Best vision model (tools + thinking)', inputPrice: 0.03, outputPrice: 0.08, vision: true, audio: false },
  { id: 'gemma4:12b', name: 'Gemma 4', size: '12B', ram: '7 GB', category: 'vision', desc: 'Multimodal + tools + thinking', inputPrice: 0.03, outputPrice: 0.08, vision: true, audio: true },

  // Embedding — Kamel-tarin
  { id: 'embeddinggemma', name: 'EmbeddingGemma', size: '300M', ram: '0.5 GB', category: 'embedding', desc: 'Newest (100+ languages, Matryoshka)', inputPrice: 0.006, outputPrice: 0.006, vision: false, audio: false },
  { id: 'nomic-embed-text', name: 'Nomic Embed', size: '274M', ram: '0.3 GB', category: 'embedding', desc: 'Classic default for RAG', inputPrice: 0.005, outputPrice: 0.005, vision: false, audio: false },
  { id: 'bge-m3', name: 'BGE-M3', size: '567M', ram: '1.2 GB', category: 'embedding', desc: 'Multilingual + long-document RAG', inputPrice: 0.008, outputPrice: 0.008, vision: false, audio: false },
];

module.exports = MODELS;
