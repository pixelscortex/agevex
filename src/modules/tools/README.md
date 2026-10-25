# tools

Host tool factories and source registry items. Registry schemas and state run in the installing host app; this module owns no component.

`client/index.ts` exports tool factories; `registry/<item>/` holds installable host code. The docs registry builder reads those sources and preserves installed file targets.
