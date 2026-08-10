// Re-export the shared protocol (events + fold) so consumers can import types
// and the fold from @fairway-kit/client without a second dependency.
export * from "@fairway-kit/protocol";
export * from "./stream.js";
export * from "./client.js";
