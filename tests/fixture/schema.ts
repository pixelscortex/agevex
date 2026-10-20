import { defineSchema } from "convex/server";

// The fixture app owns no tables of its own: the native Agent component owns
// the transcript and Agevex keeps its coordination state inside its own
// component. This schema is only the host app's (empty) table set, so the
// component tests exercise the real registration against an empty host.
export default defineSchema({});
