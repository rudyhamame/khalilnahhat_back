# Ollama Cloud provider

ECHO AI Configuration supports Ollama Cloud for the Chat assistant. It reuses the authenticated booking chat, order validation, shared draft, request limits, conversation history and usage recording. Other text features that follow Chat configuration (including lyrics concepts and setup advice) use the same adapter. No second administrator or execution engine is introduced.

Set OLLAMA_API_KEY privately on the API server. The default endpoint is https://ollama.com/v1; OLLAMA_BASE_URL may override it with a server-controlled HTTPS endpoint. No key is exposed by configuration responses or shipped to the browser/Android. Existing saved providers and defaults remain unchanged. Choose Ollama Cloud and a currently available text model, then Save configuration. Saved configuration uses the existing revision checks and database persistence.

Models are fetched from https://ollama.com/api/tags, filtered by completion capability and cached for five minutes. Catalog failure is reported separately; it does not break the other providers. Requests to Ollama validate the selected model against this catalog. The adapter rejects incomplete replies and does not silently fall back to another provider.

Ollama Cloud currently does not support enforced structured outputs. The requested schema is included in the prompt, and consumers must retain their existing response validation before accepting fields. No unsupported response_format parameter is sent. Some models may fail to return valid booking JSON; choose another model if this occurs. Real-account validation is required before claiming a selected model works.

Cloud usage depends on the account's Ollama plan/allowance. No per-token price is invented: the dashboard shows a dash for Ollama token rates, provider cost estimates remain null, and existing customer pricing policy stays independent.

Realtime Voice, STT and AI Administrator are not integrated with Ollama in this change. They retain their existing providers; the dashboard explicitly marks Ollama unsupported in those rows.

References:
- https://github.com/ollama/ollama/blob/main/docs/cloud.mdx
- https://github.com/ollama/ollama/blob/main/docs/api/openai-compatibility.mdx
- https://github.com/ollama/ollama/blob/main/docs/capabilities/structured-outputs.mdx
