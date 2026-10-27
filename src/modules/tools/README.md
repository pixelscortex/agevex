# Deferred questions

Import `createAskUserTool` from `agevex/tools` and register it as `ask_user`.
The implementation lives in `client/ask_user.ts`; `client/index.ts` exports its
factory, options, question schema and limits. There is no registry or extra table.

Core validates the question and answer form, records the native pending call,
and resumes after the authorized owner answers. Root agents can ask by default;
children require `askUser: true`. The factory has no execute function or effect.
See the docs tools pages for structured forms and host-owned budget consent.
